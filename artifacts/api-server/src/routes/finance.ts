import { Router, type IRouter } from "express";
import { isDatabaseConfigured } from "@workspace/db";
import { GetFinanceBankFeedResponse, GetFinanceIncomeResponse, SyncRentMatchActionsResponse } from "@workspace/api-zod";
import { cohoApiKey } from "../lib/integrations-env";
import { cohoGet } from "../lib/coho-api";
import { logger } from "../lib/logger";
import { matchReason, rentMatchingData, suggestPayments } from "../lib/rent-matching";
import { openRentMatchActions, syncRentMatchActions } from "../lib/rent-match-actions";

// Finance section, read-only from COHO:
//   GET /finance/financial-items  rent invoiced (client money) and management
//                                 fees (Hinkley income); COHO holds no expenses
//                                 for this account, those are in Xero.
//   GET /transactions/items       COHO's rent bank feed: bank lines matched (or
//                                 not) to rent. Matching itself stays in COHO;
//                                 POST /finance/bank-feed/coho-actions raises a
//                                 COHO action for each suggested match.
// Bank account numbers never leave the server except as the last four digits.

type RecordValue = Record<string, unknown>;
const asRecord = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
const list = (value: unknown): RecordValue[] => (Array.isArray(value) ? value.map(asRecord) : []);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const round = (value: number) => Math.round(value * 100) / 100;

const ukDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" });
const toUkDate = (value: unknown): string | null => {
  const text = str(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : ukDate.format(date);
};

// The 12 months up to and including the current one, oldest first.
function lastTwelveMonths(today: string): string[] {
  const [year, month] = today.split("-").map(Number);
  return Array.from({ length: 12 }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 1 - (11 - index), 1));
    return date.toISOString().slice(0, 7);
  });
}

const CACHE_MS = 30 * 60_000;
const cache = new Map<string, { at: number; body: unknown }>();
async function cached<T>(key: string, refresh: boolean, build: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.body as T;
  const body = await build();
  cache.set(key, { at: Date.now(), body });
  return body;
}

async function buildIncome() {
  const today = ukDate.format(new Date());
  const months = lastTwelveMonths(today);
  const from = `${months[0]}-01`;
  const query = new URLSearchParams({
    startDate: from,
    endDate: today,
    includeOrganisationItems: "true",
    includeClientItems: "true",
    includeClientMoney: "true",
    includeTenantMoney: "true",
  });
  const items = list(asRecord(await cohoGet(`/finance/financial-items?${query}`)).items);

  const byMonth = new Map(months.map((month) => [month, { month, rent: 0, fees: 0, unpaid: 0 }]));
  const byProperty = new Map<string, { propertyReference: string; propertyName: string; ownerName: string | null; rent: number; fees: number; unpaid: number; lastPaid: string | null }>();
  const byOwner = new Map<string, { ownerReference: string; ownerName: string; properties: Set<string>; rent: number; fees: number }>();
  let rentTotal = 0, feesTotal = 0, unpaidTotal = 0, unpaidCount = 0, otherTotal = 0;
  const rows: {
    id: string; invoiceDate: string; category: "rent" | "management_fee" | "other"; categoryName: string;
    propertyReference: string; propertyName: string; ownerReference: string | null; ownerName: string | null;
    tenantName: string | null; amount: number; unpaid: number; paidStatus: string; paidDate: string | null;
  }[] = [];

  for (const item of items) {
    const category = str(item.parentCategory);
    const amount = num(item.totalAmount);
    const kind = category === "rent" ? "rent" : category === "managementFee" ? "fees" : null;
    const itemUnpaid = ["unpaid", "partiallyPaid"].includes(String(item.paidStatus)) ? Math.max(amount - num(item.amountPaid), 0) : 0;
    rows.push({
      id: String(item.guid),
      invoiceDate: toUkDate(item.invoiceDate) ?? today,
      category: kind === "rent" ? "rent" : kind === "fees" ? "management_fee" : "other",
      categoryName: str(item.categoryName) ?? "Other",
      propertyReference: str(item.propertyReference) ?? "",
      propertyName: str(item.propertyName) ?? "",
      ownerReference: str(item.propertyOwnerReference),
      ownerName: str(item.propertyOwnerDisplayName),
      tenantName: str(item.tenantName),
      amount: round(amount),
      unpaid: round(itemUnpaid),
      paidStatus: str(item.paidStatus) ?? "unknown",
      paidDate: toUkDate(item.fullyPaidDate),
    });
    if (!kind) {
      otherTotal += amount;
      continue;
    }
    const month = (toUkDate(item.invoiceDate) ?? "").slice(0, 7);
    const unpaid = ["unpaid", "partiallyPaid"].includes(String(item.paidStatus)) ? Math.max(amount - num(item.amountPaid), 0) : 0;
    const reference = str(item.propertyReference) ?? "";
    const property = byProperty.get(reference) ?? {
      propertyReference: reference,
      propertyName: str(item.propertyName) ?? reference,
      ownerName: str(item.propertyOwnerDisplayName),
      rent: 0, fees: 0, unpaid: 0, lastPaid: null,
    };
    property[kind] += amount;
    const paidOn = toUkDate(item.fullyPaidDate);
    if (kind === "rent") {
      property.unpaid += unpaid;
      if (paidOn && (!property.lastPaid || paidOn > property.lastPaid)) property.lastPaid = paidOn;
      if (unpaid) { unpaidTotal += unpaid; unpaidCount += 1; }
      rentTotal += amount;
    } else {
      feesTotal += amount;
    }
    byProperty.set(reference, property);
    const bucket = byMonth.get(month);
    if (bucket) {
      bucket[kind] += amount;
      if (kind === "rent") bucket.unpaid += unpaid;
    }
    const ownerReference = str(item.propertyOwnerReference);
    if (ownerReference) {
      const owner = byOwner.get(ownerReference) ?? { ownerReference, ownerName: str(item.propertyOwnerDisplayName) ?? ownerReference, properties: new Set(), rent: 0, fees: 0 };
      owner.properties.add(reference);
      owner[kind] += amount;
      byOwner.set(ownerReference, owner);
    }
  }

  const byName = (a: string, b: string) => a.localeCompare(b, "en-GB", { numeric: true });
  return GetFinanceIncomeResponse.parse({
    asOf: today,
    from,
    rentTotal: round(rentTotal),
    feesTotal: round(feesTotal),
    feeRatePercent: rentTotal ? round((feesTotal / rentTotal) * 100) : null,
    unpaidTotal: round(unpaidTotal),
    unpaidCount,
    otherTotal: round(otherTotal),
    months: [...byMonth.values()].map((month) => ({ month: month.month, rent: round(month.rent), fees: round(month.fees), unpaid: round(month.unpaid) })),
    properties: [...byProperty.values()]
      .map((property) => ({ ...property, rent: round(property.rent), fees: round(property.fees), unpaid: round(property.unpaid) }))
      .sort((a, b) => byName(a.propertyName, b.propertyName)),
    owners: [...byOwner.values()]
      .map((owner) => ({ ownerReference: owner.ownerReference, ownerName: owner.ownerName, properties: owner.properties.size, rent: round(owner.rent), fees: round(owner.fees) }))
      .sort((a, b) => b.rent - a.rent),
    items: rows.sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate)),
  });
}

async function buildBankFeed(refresh: boolean) {
  const today = ukDate.format(new Date());
  const months = lastTwelveMonths(today);
  const from = `${months[0]}-01`;
  const { lines, arrears } = await rentMatchingData(from, refresh);
  const suggestions = suggestPayments(arrears, lines, today);
  const matchFor = new Map([...suggestions].map(([tenancyGuid, line]) => [line.id, arrears.find((arrear) => arrear.tenancyGuid === tenancyGuid)!]));
  const actions = isDatabaseConfigured()
    ? await openRentMatchActions().catch((error: unknown) => {
        logger.warn({ err: error }, "Rent match actions could not be read");
        return new Map<string, string>();
      })
    : new Map<string, string>();

  const byMonth = new Map(months.map((month) => [month, { month, matched: 0, unmatched: 0 }]));
  let matchedCount = 0, unmatchedCount = 0, excludedCount = 0, matchedAmount = 0, unmatchedAmount = 0;
  let oldestUnmatched: string | null = null;
  for (const line of lines) {
    const bucket = byMonth.get(line.date.slice(0, 7));
    if (line.status === "excluded") excludedCount += 1;
    else if (line.status === "matched") { matchedCount += 1; matchedAmount += line.amount; if (bucket) bucket.matched += line.amount; }
    else {
      unmatchedCount += 1;
      unmatchedAmount += line.amount;
      if (bucket) bucket.unmatched += line.amount;
      if (!oldestUnmatched || line.date < oldestUnmatched) oldestUnmatched = line.date;
    }
  }

  return GetFinanceBankFeedResponse.parse({
    asOf: today,
    from,
    accounts: [...new Set(lines.map((line) => line.account).filter(Boolean))],
    matchedCount,
    unmatchedCount,
    excludedCount,
    matchedAmount: round(matchedAmount),
    unmatchedAmount: round(unmatchedAmount),
    oldestUnmatched,
    months: [...byMonth.values()].map((month) => ({ month: month.month, matched: round(month.matched), unmatched: round(month.unmatched) })),
    lines: lines
      .map((line) => {
        const match = matchFor.get(line.id);
        return {
          ...line,
          possibleMatch: match
            ? {
                propertyReference: match.propertyReference,
                propertyName: match.propertyName,
                tenantName: match.tenantName,
                tenancyNumber: match.tenancyNumber,
                outstanding: match.outstanding,
                earliestDue: match.earliestDue,
                daysInArrears: match.daysInArrears,
                reason: matchReason(match, line),
                cohoActionReference: actions.get(line.id) ?? null,
              }
            : null,
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date)),
  });
}

const financeRouter: IRouter = Router();

financeRouter.get("/finance/income", async (req, res): Promise<void> => {
  if (!cohoApiKey()) {
    res.status(503).json({ error: "COHO_API_KEY is not configured." });
    return;
  }
  try {
    res.json(await cached("income", req.query.refresh === "1", buildIncome));
  } catch (error) {
    req.log.warn({ err: error }, "COHO financial items unavailable");
    res.status(502).json({ error: "COHO could not be reached. Try again." });
  }
});

financeRouter.get("/finance/bank-feed", async (req, res): Promise<void> => {
  if (!cohoApiKey()) {
    res.status(503).json({ error: "COHO_API_KEY is not configured." });
    return;
  }
  try {
    res.json(await cached("bank-feed", req.query.refresh === "1", () => buildBankFeed(req.query.refresh === "1")));
  } catch (error) {
    req.log.warn({ err: error }, "COHO bank feed unavailable");
    res.status(502).json({ error: "COHO could not be reached. Try again." });
  }
});

// Staff "Add to COHO actions" button; n8n runs the same thing on a schedule.
financeRouter.post("/finance/bank-feed/coho-actions", async (req, res): Promise<void> => {
  if (!cohoApiKey() || !isDatabaseConfigured()) {
    res.status(503).json({ error: "COHO or the database is not configured." });
    return;
  }
  const result = await syncRentMatchActions("manual");
  cache.delete("bank-feed");
  if (result.status === "failed") {
    res.status(502).json({ error: result.error ?? "COHO could not be reached. Try again." });
    return;
  }
  res.json(SyncRentMatchActionsResponse.parse(result));
});

export default financeRouter;
