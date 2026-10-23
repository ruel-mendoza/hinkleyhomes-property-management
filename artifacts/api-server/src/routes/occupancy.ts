import { Router, type IRouter } from "express";
import { GetOccupancyResponse } from "@workspace/api-zod";
import { cohoApiKey } from "../lib/integrations-env";
import { cohoGet } from "../lib/coho-api";

// Occupancy, as on COHO's Occupancy page: every unit with its current or
// future tenancy, or vacant. Three COHO Public API v1.1 lists are joined:
//   GET /properties?includeRooms=true          units, advertised rent, available from
//   GET /tenancies?includeCurrent&includeFuture tenancies and tenants (no rent)
//   GET /rent-review/tenancies?dueDays=All      rent, fixed-term end, next review
// Tenants come back with email, phone and date of birth; only names leave the server.

type RecordValue = Record<string, unknown>;
const asRecord = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
const list = (value: unknown): RecordValue[] => (Array.isArray(value) ? value.map(asRecord) : []);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

// A fixed term ending within this many days counts as "becoming periodic".
// COHO's own window isn't exposed by the API.
const BECOMING_PERIODIC_DAYS = 60;

// COHO stores UK dates as UK midnight in UTC (1 Aug BST = 2026-07-31T23:00Z).
const ukDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" });
const toUkDate = (value: unknown): string | null => {
  const text = str(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : ukDate.format(date);
};
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

async function allPages(path: string): Promise<RecordValue[]> {
  const items: RecordValue[] = [];
  for (let page = 1; page <= 50; page++) {
    const payload = asRecord(await cohoGet(`${path}${path.includes("?") ? "&" : "?"}page=${page}&pageSize=100`));
    items.push(...list(payload.items));
    if (payload.hasNextPage !== true) break;
  }
  return items;
}

type Status = "fixed_term" | "becoming_periodic" | "periodic" | "ending" | "future" | "vacant";
function tenancyStatus(today: string, start: string | null, end: string | null, fixedTermEnd: string | null): Status {
  if (start && start > today) return "future";
  if (end) return "ending";
  if (fixedTermEnd && fixedTermEnd >= today) {
    return fixedTermEnd <= addDays(today, BECOMING_PERIODIC_DAYS) ? "becoming_periodic" : "fixed_term";
  }
  return "periodic";
}

const occupancyRouter: IRouter = Router();

occupancyRouter.get("/occupancy", async (req, res): Promise<void> => {
  if (!cohoApiKey()) {
    res.status(503).json({ error: "COHO_API_KEY is not configured." });
    return;
  }
  let properties: RecordValue[];
  let tenancies: RecordValue[];
  let reviews: RecordValue[];
  try {
    [properties, tenancies, reviews] = await Promise.all([
      allPages("/properties?includeRooms=true"),
      allPages("/tenancies?includeCurrent=true&includeFuture=true"),
      allPages("/rent-review/tenancies?dueDays=All"),
    ]);
  } catch (error) {
    req.log.warn({ err: error }, "COHO occupancy data unavailable");
    res.status(502).json({ error: "COHO could not be reached. Try again." });
    return;
  }

  const today = ukDate.format(new Date());
  const reviewFor = new Map(reviews.map((review) => [str(review.tenancyGuid) ?? "", review]));
  const tenanciesFor = new Map<string, RecordValue[]>();
  for (const tenancy of tenancies) {
    if (!["active", "future"].includes(String(tenancy.status))) continue;
    const key = `${str(tenancy.propertyReference)}/${str(tenancy.roomReference)}`;
    tenanciesFor.set(key, [...(tenanciesFor.get(key) ?? []), tenancy]);
  }

  let units = 0;
  const rows = properties.flatMap((property) => {
    const propertyReference = str(property.reference) ?? "";
    const propertyName = str(property.name) ?? propertyReference;
    const rooms = list(property.rooms);
    units += rooms.length;
    return rooms.flatMap((room) => {
      const unitReference = str(room.reference) ?? "";
      const unit = { propertyReference, propertyName, unitReference, unitName: str(room.name) ?? "Unit", unitsInProperty: rooms.length };
      const unitTenancies = (tenanciesFor.get(`${propertyReference}/${unitReference}`) ?? [])
        .sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)));
      if (!unitTenancies.some((tenancy) => tenancy.status === "active")) {
        unitTenancies.unshift({});
      }
      return unitTenancies.map((tenancy) => {
        if (!tenancy.guid) {
          return {
            ...unit,
            tenancyGuid: null,
            tenancyNumber: null,
            tenants: [],
            rent: num(room.rent) || null,
            paymentFrequency: str(room.paymentFrequency),
            startDate: null,
            fixedTermEnd: null,
            endDate: null,
            availableFrom: toUkDate(room.availableFrom),
            nextRentReview: null,
            status: "vacant" as const,
          };
        }
        const review = reviewFor.get(String(tenancy.guid)) ?? {};
        const startDate = toUkDate(tenancy.startDate);
        const endDate = toUkDate(tenancy.endDate);
        const fixedTermEnd = toUkDate(review.fixedTermEndDate);
        return {
          ...unit,
          tenancyGuid: String(tenancy.guid),
          tenancyNumber: str(tenancy.tenancyNumber),
          tenants: list(tenancy.tenants).map((tenant) => ({
            name: str(tenant.fullname) ?? ([str(tenant.forename), str(tenant.surname)].filter(Boolean).join(" ") || "Tenant"),
            type: str(tenant.type),
            cohoAccount: str(tenant.cohoAccountStatus),
          })),
          rent: num(review.currentRent) ?? (num(room.rent) || null),
          paymentFrequency: str(review.paymentFrequency) ?? str(room.paymentFrequency),
          startDate,
          fixedTermEnd,
          endDate,
          availableFrom: null,
          nextRentReview: toUkDate(review.nextRentReview),
          status: tenancyStatus(today, startDate, endDate, fixedTermEnd),
        };
      });
    });
  });

  res.json(GetOccupancyResponse.parse({ asOf: today, becomingPeriodicDays: BECOMING_PERIODIC_DAYS, units, rows }));
});

export default occupancyRouter;
