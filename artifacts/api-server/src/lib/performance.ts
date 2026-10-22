import { asc, gte, sql } from "drizzle-orm";
import { cohoUnitSnapshotsTable, getDb, isDatabaseConfigured, type CohoUnitSnapshot } from "@workspace/db";
import { CohoApiError, cohoGet } from "./coho-api";

// Performance metrics, as on COHO's Rent Roll page. COHO's API has no
// analytics endpoint, so each figure is worked out from raw COHO data:
//   rent roll, paid on time, days late  per-unit rent due records
//   target                              sum of each unit's advertised rent
//   satisfaction                        /tenant-feedback/overview
//   occupancy, tenancy length, voids    current tenancies plus our own daily
//                                       unit snapshots (COHO returns no past
//                                       tenancies, so history builds up here)
// Rent roll, target, paid on time and October occupancy were checked against
// COHO's own page on 2026-10-22 and matched exactly.

type RecordValue = Record<string, unknown>;
const asRecord = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
const list = (value: unknown): RecordValue[] => (Array.isArray(value) ? value.map(asRecord) : []);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

const ukDateFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" });
export const ukToday = () => ukDateFormat.format(new Date());
// COHO stores UK dates as UK midnight in UTC (1 Oct BST = 2026-09-30T23:00Z).
const toUkDate = (value: unknown): string | null => {
  const text = str(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : ukDateFormat.format(date);
};
const DAY = 86_400_000;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY);
const monthOf = (date: string) => date.slice(0, 7);
const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

// --- COHO data -------------------------------------------------------------------------

type Unit = { propertyReference: string; propertyName: string; unitReference: string; advertisedRent: number | null };
type Tenancy = { guid: string; propertyReference: string; unitReference: string; start: string; end: string | null; rent: number | null };
type RentRecord = { propertyReference: string; due: string; amount: number; status: string; paidInFull: string | null; daysPaidLate: number | null };
type FeedbackMonth = { month: string; overall: { score: number; count: number } | null; byProperty: Map<string, { score: number; count: number }> };
export type CohoPerformanceData = { loadedAt: number; units: Unit[]; tenancies: Tenancy[]; rent: RentRecord[]; feedback: FeedbackMonth[] };

async function pages(path: string, pageSize = 100): Promise<RecordValue[]> {
  const items: RecordValue[] = [];
  for (let page = 1; page <= 30; page++) {
    const payload = asRecord(await cohoGet(`${path}${path.includes("?") ? "&" : "?"}page=${page}&pageSize=${pageSize}`));
    const batch = list(payload.items);
    items.push(...batch);
    if (payload.hasNextPage !== true) break;
  }
  return items;
}

// The per-unit rent list has no page size or hasNextPage; read until a page is empty.
async function unitRentRecords(propertyReference: string, unitReference: string, since: string): Promise<RecordValue[]> {
  const items: RecordValue[] = [];
  for (let page = 1; page <= 20; page++) {
    let payload: RecordValue;
    try {
      payload = asRecord(
        await cohoGet(`/properties/${encodeURIComponent(propertyReference)}/rooms/${encodeURIComponent(unitReference)}/rent-due-records?rentOnly=true&dateFrom=${since}&page=${page}`),
      );
    } catch (error) {
      // 404 = the unit has never had a tenancy.
      if (error instanceof CohoApiError && error.status === 404) return items;
      throw error;
    }
    const batch = list(payload.items);
    if (!batch.length) break;
    items.push(...batch);
  }
  return items;
}

// Runs a few at a time so 20+ units don't hit COHO all at once.
async function inBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += size) results.push(...(await Promise.all(items.slice(index, index + size).map(run))));
  return results;
}

export async function loadCohoPerformanceData(): Promise<CohoPerformanceData> {
  const today = ukToday();
  const since = addDays(today, -400);
  const [properties, tenancies, reviews, feedback] = await Promise.all([
    pages("/properties?includeRooms=true"),
    pages("/tenancies?includeCurrent=true&includeFuture=true"),
    pages("/rent-review/tenancies?dueDays=All"),
    cohoGet(`/tenant-feedback/overview?dateFrom=${addDays(today, -400)}&dateTo=${today}`).then(asRecord),
  ]);
  const units: Unit[] = properties.flatMap((property) =>
    list(property.rooms).map((room) => ({
      propertyReference: str(property.reference) ?? "",
      propertyName: str(property.name) ?? "",
      unitReference: str(room.reference) ?? "",
      advertisedRent: num(room.rent) || null,
    })),
  );
  const rentFor = new Map(reviews.map((review) => [str(review.tenancyGuid), num(review.currentRent)]));
  const rentLists = await inBatches(units, 6, async (unit) =>
    (await unitRentRecords(unit.propertyReference, unit.unitReference, since)).map((record) => ({ unit, record })),
  );
  return {
    loadedAt: Date.now(),
    units,
    tenancies: tenancies
      .filter((tenancy) => ["active", "future"].includes(String(tenancy.status)))
      .map((tenancy) => ({
        guid: String(tenancy.guid),
        propertyReference: str(tenancy.propertyReference) ?? "",
        unitReference: str(tenancy.roomReference) ?? "",
        start: toUkDate(tenancy.startDate) ?? today,
        end: toUkDate(tenancy.endDate),
        rent: rentFor.get(str(tenancy.guid)) ?? null,
      })),
    rent: rentLists
      .flat()
      .filter(({ record }) => (str(record.type) ?? "rent") === "rent" && record.deleted !== true && !record.reversed)
      .map(({ unit, record }) => ({
        propertyReference: unit.propertyReference,
        due: toUkDate(record.dateDue) ?? today,
        amount: num(record.amountTotal) ?? num(record.amount) ?? 0,
        status: str(record.paymentStatus) ?? "",
        paidInFull: toUkDate(record.datePaidInFull),
        daysPaidLate: num(record.daysPaidLate),
      })),
    feedback: list(feedback.tenantMonthlyFeedback).map((month) => {
      const score = (value: unknown) => {
        const overall = asRecord(value);
        const average = num(overall.averageScore);
        const count = num(overall.totalCount) ?? 0;
        return average === null || !count ? null : { score: average, count };
      };
      return {
        month: (toUkDate(month.date) ?? str(month.date)?.slice(0, 10) ?? "").slice(0, 7),
        overall: score(month.overall),
        byProperty: new Map(
          list(month.propertyFeedback)
            .map((property) => [str(property.propertyReference) ?? "", score(property.overall)] as const)
            .filter((entry): entry is [string, { score: number; count: number }] => entry[1] !== null),
        ),
      };
    }),
  };
}

// --- Snapshots -----------------------------------------------------------------------------

const occupiedOn = (tenancy: Tenancy, day: string) => tenancy.start <= day && (!tenancy.end || tenancy.end >= day);

// Saves (or refreshes) today's row for every unit. Safe to call repeatedly.
export async function recordUnitSnapshot(data: CohoPerformanceData, day = ukToday()): Promise<number> {
  const rows = data.units.map((unit) => {
    const tenancy = data.tenancies.find((item) => item.propertyReference === unit.propertyReference && item.unitReference === unit.unitReference && occupiedOn(item, day));
    return {
      snapshotDate: day,
      cohoPropertyReference: unit.propertyReference,
      propertyName: unit.propertyName,
      cohoUnitReference: unit.unitReference,
      status: tenancy ? ("let" as const) : ("vacant" as const),
      tenancyGuid: tenancy?.guid ?? null,
      tenancyStartDate: tenancy?.start ?? null,
      rent: tenancy?.rent === null || tenancy?.rent === undefined ? null : String(tenancy.rent),
      advertisedRent: unit.advertisedRent === null ? null : String(unit.advertisedRent),
    };
  });
  if (!rows.length) return 0;
  const t = cohoUnitSnapshotsTable;
  await getDb()
    .insert(t)
    .values(rows)
    .onConflictDoUpdate({
      target: [t.snapshotDate, t.cohoPropertyReference, t.cohoUnitReference],
      set: {
        propertyName: sql`excluded.property_name`,
        status: sql`excluded.status`,
        tenancyGuid: sql`excluded.tenancy_guid`,
        tenancyStartDate: sql`excluded.tenancy_start_date`,
        rent: sql`excluded.rent`,
        advertisedRent: sql`excluded.advertised_rent`,
        updatedAt: sql`now()`,
      },
    });
  return rows.length;
}

export async function readSnapshots(since: string): Promise<CohoUnitSnapshot[]> {
  if (!isDatabaseConfigured()) return [];
  const t = cohoUnitSnapshotsTable;
  return getDb().select().from(t).where(gte(t.snapshotDate, since)).orderBy(asc(t.snapshotDate));
}

// --- Metrics -------------------------------------------------------------------------------

type PeriodKey = "month_to_date" | "last_month" | "last_90_days" | "last_year";
const monthName = (month: string) => new Date(`${month}-01T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

export function periodsFor(today: string): { key: PeriodKey; label: string; from: string; to: string }[] {
  const monthStart = `${today.slice(0, 8)}01`;
  const lastMonthEnd = addDays(monthStart, -1);
  const lastMonthStart = `${lastMonthEnd.slice(0, 8)}01`;
  return [
    { key: "month_to_date", label: `${monthName(monthOf(today))} (to date)`, from: monthStart, to: today },
    { key: "last_month", label: monthName(monthOf(lastMonthStart)), from: lastMonthStart, to: lastMonthEnd },
    { key: "last_90_days", label: "Last 90 days", from: addDays(today, -89), to: today },
    { key: "last_year", label: "Last year", from: addDays(today, -364), to: today },
  ];
}

export function computePerformance(data: CohoPerformanceData, snapshots: CohoUnitSnapshot[], propertyReference: string | null, today = ukToday()) {
  const inScope = <T extends { propertyReference: string }>(items: T[]) => items.filter((item) => !propertyReference || item.propertyReference === propertyReference);
  const units = inScope(data.units);
  const tenancies = inScope(data.tenancies);
  const rent = inScope(data.rent);
  const shots = snapshots.filter((row) => !propertyReference || row.cohoPropertyReference === propertyReference);
  const snapshotsSince = snapshots.length ? snapshots[0].snapshotDate : null;
  const unitKey = (property: string, unit: string) => `${property}/${unit}`;
  const letInSnapshot = new Set(shots.filter((row) => row.status === "let").map((row) => `${row.snapshotDate}|${unitKey(row.cohoPropertyReference, row.cohoUnitReference)}`));
  const target = units.reduce((sum, unit) => sum + (unit.advertisedRent ?? 0), 0);

  const rentRoll = (month: string) => {
    const amount = round(rent.filter((record) => monthOf(record.due) === month).reduce((sum, record) => sum + record.amount, 0));
    return { month, amount, target: round(target), percent: target ? Math.round((amount / target) * 100) : null };
  };

  const occupiedUnitDay = (unit: Unit, day: string) =>
    tenancies.some((tenancy) => tenancy.propertyReference === unit.propertyReference && tenancy.unitReference === unit.unitReference && occupiedOn(tenancy, day)) ||
    letInSnapshot.has(`${day}|${unitKey(unit.propertyReference, unit.unitReference)}`);

  // Vacant runs (from snapshots) that ended with a let day, keyed by the day they were filled.
  const filledVoids: { filled: string; days: number }[] = [];
  const byUnit = new Map<string, CohoUnitSnapshot[]>();
  for (const row of shots) byUnit.set(unitKey(row.cohoPropertyReference, row.cohoUnitReference), [...(byUnit.get(unitKey(row.cohoPropertyReference, row.cohoUnitReference)) ?? []), row]);
  for (const rows of byUnit.values()) {
    let runStart: string | null = null;
    let runKnown = false;
    rows.forEach((row, index) => {
      const previous = rows[index - 1];
      const continuous = previous && daysBetween(previous.snapshotDate, row.snapshotDate) === 1;
      if (row.status === "vacant") {
        if (!runStart || !continuous) {
          runStart = row.snapshotDate;
          // A run that starts on the unit's first snapshot (or after a gap) has an unknown start.
          runKnown = Boolean(previous && continuous && previous.status === "let");
        }
      } else {
        if (runStart && runKnown && continuous) filledVoids.push({ filled: row.snapshotDate, days: daysBetween(runStart, row.snapshotDate) });
        runStart = null;
      }
    });
  }

  const periods = periodsFor(today).map((period) => {
    const end = period.to < today ? period.to : today;
    const due = rent.filter((record) => record.due >= period.from && record.due <= end);
    const onTime = due.filter((record) => record.status === "paidOnTime").length;
    const lateDays = due.map((record) =>
      record.status === "overdue" ? Math.max(daysBetween(record.due, today), 0)
        : record.status === "paidLate" ? record.daysPaidLate ?? (record.paidInFull ? Math.max(daysBetween(record.due, record.paidInFull), 0) : 0)
          : 0,
    );

    let occupied = 0;
    let unitDays = 0;
    for (let day = period.from; day <= end; day = addDays(day, 1)) {
      for (const unit of units) {
        unitDays += 1;
        if (occupiedUnitDay(unit, day)) occupied += 1;
      }
    }

    const months = new Set<string>();
    for (let day = period.from; day <= end; day = addDays(day, 1)) months.add(monthOf(day));
    const scores = data.feedback
      .filter((month) => months.has(month.month))
      .map((month) => (propertyReference ? month.byProperty.get(propertyReference) ?? null : month.overall))
      .filter((score): score is { score: number; count: number } => score !== null);
    const responses = scores.reduce((sum, score) => sum + score.count, 0);

    const voids = filledVoids.filter((item) => item.filled >= period.from && item.filled <= end);
    return {
      key: period.key,
      label: period.label,
      from: period.from,
      to: period.to,
      rentRecords: due.length,
      paidOnTimePercent: due.length ? round((onTime / due.length) * 100) : null,
      averageDaysLate: due.length ? round(lateDays.reduce((sum, days) => sum + days, 0) / due.length, 1) : null,
      occupancyPercent: unitDays ? round((occupied / unitDays) * 100) : null,
      occupancyComplete: Boolean(snapshotsSince && period.from >= snapshotsSince),
      satisfaction: responses ? round(scores.reduce((sum, score) => sum + score.score * score.count, 0) / responses, 1) : null,
      satisfactionResponses: responses,
      daysToFillVoids: voids.length ? round(voids.reduce((sum, item) => sum + item.days, 0) / voids.length, 1) : null,
      voidsFilled: voids.length,
    };
  });

  // Tenancy length: current tenancies to today, plus ended ones seen in snapshots.
  const lengths = new Map<string, number>();
  for (const tenancy of tenancies) if (tenancy.start <= today) lengths.set(tenancy.guid, daysBetween(tenancy.start, tenancy.end && tenancy.end < today ? tenancy.end : today));
  for (const row of shots) {
    if (!row.tenancyGuid || !row.tenancyStartDate || tenancies.some((tenancy) => tenancy.guid === row.tenancyGuid)) continue;
    lengths.set(row.tenancyGuid, Math.max(lengths.get(row.tenancyGuid) ?? 0, daysBetween(row.tenancyStartDate, row.snapshotDate)));
  }
  const occupiedToday = units.filter((unit) => occupiedUnitDay(unit, today)).length;

  return {
    asOf: today,
    propertyReference,
    units: units.length,
    occupiedToday,
    occupancyTodayPercent: units.length ? round((occupiedToday / units.length) * 100) : null,
    rentRollThisMonth: rentRoll(monthOf(today)),
    rentRollLastMonth: rentRoll(monthOf(addDays(`${today.slice(0, 8)}01`, -1))),
    periods,
    averageTenancyMonths: lengths.size ? round([...lengths.values()].reduce((sum, days) => sum + days, 0) / lengths.size / 30.4375, 1) : null,
    tenanciesCounted: lengths.size,
    snapshotsSince,
  };
}
