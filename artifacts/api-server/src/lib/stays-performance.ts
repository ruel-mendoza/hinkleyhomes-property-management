import { and, asc, eq, gte, inArray, like, lte, ne } from "drizzle-orm";
import { getDb, integrationSyncRunsTable, propertiesTable, shortStayBookingsTable, smoobuApartmentsTable } from "@workspace/db";
import { lastMonths, monthEnd, periodsFor, ukToday } from "./performance";
import { FIRST_SYNC_DAYS, SYNC_TRIGGER, addDays } from "./stays";

// Stays performance (Hinkley Homes Stays), the hotel measures worked out from
// the bookings already synced from Smoobu, so nothing extra is read from it:
//   occupancy  booked nights / apartment-nights (blocked nights aren't stored,
//              so they count as free)
//   room revenue  booking price less cleaning fees, spread evenly over the
//              nights stayed (before channel commission)
//   ADR        room revenue per booked night
//   RevPAR     room revenue per available night
// The apartment count is today's, so months before an apartment was added
// read a little low.

const AHEAD_NIGHTS = 30;
const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
const nightsBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
const later = (a: string, b: string) => (a > b ? a : b);
const earlier = (a: string, b: string) => (a < b ? a : b);

type Stay = { arrival: string; departure: string; nights: number; nightly: number; channel: string };

// The first night every booking is known for: the first successful sync read
// bookings departing from FIRST_SYNC_DAYS before it.
async function historyFrom(): Promise<string | null> {
  const r = integrationSyncRunsTable;
  const [first] = await getDb()
    .select({ startedAt: r.startedAt })
    .from(r)
    .where(and(eq(r.integration, "smoobu"), eq(r.status, "succeeded"), like(r.trigger, `${SYNC_TRIGGER}:%`)))
    .orderBy(asc(r.startedAt))
    .limit(1);
  return first ? addDays(first.startedAt.toISOString().slice(0, 10), -FIRST_SYNC_DAYS) : null;
}

export async function staysPerformance(propertyReference: string | null, today = ukToday()) {
  const a = smoobuApartmentsTable;
  const p = propertiesTable;
  const t = shortStayBookingsTable;
  const months = lastMonths(today, 12);
  const start = `${months[0]}-01`;
  const aheadTo = addDays(today, AHEAD_NIGHTS - 1);

  const [allApartments, since] = await Promise.all([
    getDb().select({ id: a.smoobuApartmentId, coho: a.cohoPropertyReference, registerCoho: p.cohoPropertyReference }).from(a).leftJoin(p, eq(p.id, a.propertyId)),
    historyFrom(),
  ]);
  const apartments = allApartments.filter((apartment) => !propertyReference || (apartment.coho ?? apartment.registerCoho) === propertyReference).map((apartment) => apartment.id);
  const rows = apartments.length
    ? await getDb()
        .select({ arrival: t.arrivalDate, departure: t.departureDate, total: t.totalAmount, cleaning: t.cleaningFee, channel: t.channel })
        .from(t)
        .where(and(ne(t.status, "cancelled"), inArray(t.smoobuApartmentId, apartments), gte(t.departureDate, start), lte(t.arrivalDate, aheadTo)))
    : [];
  return computeStaysPerformance(apartments.length, rows, since, propertyReference, today);
}

type BookingRow = { arrival: string; departure: string; total: string | null; cleaning: string | null; channel: string | null };

export function computeStaysPerformance(apartmentCount: number, rows: BookingRow[], since: string | null, propertyReference: string | null, today = ukToday()) {
  const months = lastMonths(today, 12);
  const aheadTo = addDays(today, AHEAD_NIGHTS - 1);
  const stays: Stay[] = rows.flatMap((row) => {
    const nights = nightsBetween(row.arrival, row.departure);
    if (nights < 1) return [];
    const room = Math.max((row.total === null ? 0 : Number(row.total)) - (row.cleaning === null ? 0 : Number(row.cleaning)), 0);
    return [{ arrival: row.arrival, departure: row.departure, nights, nightly: room / nights, channel: row.channel?.trim() || "Other" }];
  });

  // Nights of a stay that fall between two dates (both inclusive).
  const nightsIn = (stay: Stay, from: string, to: string) => Math.max(nightsBetween(later(stay.arrival, from), earlier(stay.departure, addDays(to, 1))), 0);

  const figures = (from: string, to: string) => {
    const days = Math.max(nightsBetween(from, to) + 1, 0);
    const availableNights = apartmentCount * days;
    let bookedNights = 0;
    let revenue = 0;
    for (const stay of stays) {
      const nights = nightsIn(stay, from, to);
      bookedNights += nights;
      revenue += nights * stay.nightly;
    }
    return {
      availableNights,
      bookedNights,
      occupancyPercent: availableNights ? round((bookedNights / availableNights) * 100, 1) : null,
      roomRevenue: round(revenue),
      averageDailyRate: bookedNights ? round(revenue / bookedNights) : null,
      revPar: availableNights ? round(revenue / availableNights) : null,
      complete: Boolean(since && from >= since),
    };
  };

  const periods = periodsFor(today).map((period) => {
    const end = earlier(period.to, today);
    const arrivals = stays.filter((stay) => stay.arrival >= period.from && stay.arrival <= end);
    return {
      key: period.key,
      label: period.label,
      from: period.from,
      to: period.to,
      ...figures(period.from, end),
      arrivals: arrivals.length,
      averageStayNights: arrivals.length ? round(arrivals.reduce((sum, stay) => sum + stay.nights, 0) / arrivals.length, 1) : null,
    };
  });

  const channelFrom = addDays(today, -89);
  const byChannel = new Map<string, { bookedNights: number; roomRevenue: number }>();
  for (const stay of stays) {
    const nights = nightsIn(stay, channelFrom, today);
    if (!nights) continue;
    const entry = byChannel.get(stay.channel) ?? { bookedNights: 0, roomRevenue: 0 };
    entry.bookedNights += nights;
    entry.roomRevenue += nights * stay.nightly;
    byChannel.set(stay.channel, entry);
  }

  return {
    asOf: today,
    propertyReference,
    apartments: apartmentCount,
    historyFrom: since,
    periods,
    months: months.map((month) => ({ month, ...figures(`${month}-01`, earlier(monthEnd(month), today)) })),
    ahead: { from: today, to: aheadTo, ...figures(today, aheadTo), complete: true },
    channels: [...byChannel.entries()]
      .map(([channel, entry]) => ({ channel, bookedNights: entry.bookedNights, roomRevenue: round(entry.roomRevenue) }))
      .sort((x, y) => y.bookedNights - x.bookedNights),
  };
}
