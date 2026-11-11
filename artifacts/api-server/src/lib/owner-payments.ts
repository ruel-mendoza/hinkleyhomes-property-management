import { COMPANIES } from "../routes/money";
import { parseXeroDate, xeroGatewayRequest } from "./xero-gateway";

// Finds each Rental Ninja landlord payout in Xero (read-only). Landlords are
// paid either by a bill to the landlord in Hinkley Homes Management or by a
// payment from Hinkley Homes Lettings' bank, usually 5-7 days after the month
// (checked against May-Oct 2026). Rental Ninja records no payments itself.
//
// Matching, in order, each Xero record used once:
//   1. same amount and the landlord's name, 10 days before to 75 days after the period end
//   2. same amount, any name, when exactly one record in the window has it
//   3. the landlord's name and 2-4 records adding up to the payout (paid in parts)
//   4. the landlord's name and one record equal to two of their payouts (paid together)

export type PayoutToFind = { statementId: number; landlord: string; net: number; end: string };
export type PaymentFound = {
  status: "paid" | "billed" | "waiting" | "missing";
  company: string | null;
  kind: "bill" | "payment" | null;
  date: string | null;
  amount: number | null;
  parts: number;
  sharedWith: string | null;
  reference: string | null;
};
type XeroRecord = { company: string; kind: "bill" | "payment"; date: string; paidOn: string | null; amount: number; contact: string; reference: string | null; paid: boolean };

const WINDOW_BEFORE = 10;
const WINDOW_AFTER = 75;
const WAIT_DAYS = 7;
const shortName = (name: string) => (name === "Hinkley Homes Ltd" ? name : name.replace(/^Hinkley Homes /, ""));
const day = (value: unknown) => parseXeroDate(value)?.toISOString().slice(0, 10) ?? null;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const daysAfter = (from: string, to: string) => (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000;
const near = (a: number, b: number) => Math.abs(a - b) < 0.015;
const xeroDate = (date: string) => `DateTime(${date.replace(/-/g, ",")})`;

// Names differ between the systems ("Janice & Paul Sutton" / "Paul And Janice
// Sutton", "Rishi & Co LTD" / "Rishi & Co. Ltd"), so compare distinctive words.
const GENERIC = new Set(["ltd", "limited", "the", "and", "co", "uk", "plc", "llp"]);
const COMMON = new Set(["property", "properties", "investments", "holdings", "solutions", "estates", "accommodation", "living", "management", "group", "services"]);
function words(name: string): string[] {
  const all = name.toLowerCase().replace(/&/g, " ").split(/[^a-z0-9]+/).filter((word) => word && !GENERIC.has(word));
  const distinctive = all.filter((word) => word.length >= 3 && !COMMON.has(word));
  // "FG Property Investments" has no distinctive word, so fall back to all of them together.
  return distinctive.length ? distinctive : [all.join(" ")];
}
function sameName(a: string, b: string): boolean {
  const left = words(a);
  const right = words(b);
  if (left.length === 1 && left[0].includes(" ")) return right.join(" ").includes(left[0]) || b.toLowerCase().includes(left[0]);
  return left.some((word) => right.includes(word));
}

// The n8n gateway sometimes fails a single call (a plain HTTP 500, or Xero
// rate limiting); these are reads, so wait and try again up to twice.
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function readPage(tenantId: string, resource: "bankTransactions" | "invoices", query: Record<string, string | number>) {
  for (const wait of [2_000, 6_000, null]) {
    let response: Awaited<ReturnType<typeof xeroGatewayRequest>> | null = null;
    try {
      response = await xeroGatewayRequest({ tenantId, resource, query });
    } catch (error) {
      if (wait === null) throw error;
    }
    if (response?.ok) return response;
    if (response && response.status !== 429 && response.status < 500) throw new Error(`Xero returned HTTP ${response.status}.`);
    if (wait === null) throw new Error(response?.status === 429 ? "Xero is rate limiting; try again shortly." : `Xero returned HTTP ${response?.status}.`);
    await pause(response?.status === 429 ? Math.min(Number(response.retryAfter) * 1000 || wait, 30_000) : wait);
  }
  throw new Error("Xero couldn't be read.");
}

async function pages(tenantId: string, resource: "bankTransactions" | "invoices", where: string, key: string) {
  const items: Record<string, any>[] = [];
  for (let page = 1; page <= 10; page++) {
    const response = await readPage(tenantId, resource, { where, page, pageSize: 100 });
    const batch = ((response.data as Record<string, unknown>)?.[key] ?? []) as Record<string, any>[];
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

async function xeroRecords(from: string, to: string): Promise<XeroRecord[]> {
  const range = `Date>=${xeroDate(from)}&&Date<=${xeroDate(to)}`;
  // One company at a time: ten reads at once through n8n made the gateway fail.
  const perCompany: XeroRecord[][] = [];
  for (const company of COMPANIES) {
    const [spends, bills] = await Promise.all([
      pages(company.tenantId, "bankTransactions", `Status=="AUTHORISED"&&Type=="SPEND"&&${range}`, "BankTransactions"),
      pages(company.tenantId, "invoices", `Type=="ACCPAY"&&${range}`, "Invoices"),
    ]);
    const name = shortName(company.name);
    perCompany.push([
      ...spends.map((item): XeroRecord => ({ company: name, kind: "payment", date: day(item.Date) ?? from, paidOn: day(item.Date), amount: Math.abs(Number(item.Total) || 0), contact: item.Contact?.Name ?? "", reference: item.Reference ?? null, paid: true })),
      ...bills
        .filter((item) => item.Status !== "VOIDED" && item.Status !== "DELETED")
        .map((item): XeroRecord => ({ company: name, kind: "bill", date: day(item.Date) ?? from, paidOn: day(item.FullyPaidOnDate), amount: Number(item.Total) || 0, contact: item.Contact?.Name ?? "", reference: item.Reference || item.InvoiceNumber || null, paid: item.Status === "PAID" })),
    ]);
  }
  return perCompany.flat();
}

// Up to 4 records adding up to the target (records sorted by date, at most 14 tried).
function partsAddingUp(records: XeroRecord[], target: number): XeroRecord[] | null {
  const pool = records.slice(0, 14);
  const search = (start: number, left: number, picked: XeroRecord[]): XeroRecord[] | null => {
    if (picked.length >= 2 && near(left, 0)) return picked;
    if (picked.length >= 4) return null;
    for (let index = start; index < pool.length; index++) {
      if (pool[index].amount > left + 0.015) continue;
      const found = search(index + 1, left - pool[index].amount, [...picked, pool[index]]);
      if (found) return found;
    }
    return null;
  };
  return search(0, target, []);
}

function describe(records: XeroRecord[], sharedWith: string | null = null): PaymentFound {
  const paid = records.every((record) => record.paid);
  const dates = records.map((record) => (record.kind === "bill" ? record.paidOn ?? record.date : record.date)).sort();
  return {
    status: paid ? "paid" : "billed",
    company: [...new Set(records.map((record) => record.company))].join(" and "),
    kind: records[0].kind,
    date: dates.at(-1) ?? null,
    amount: Math.round(records.reduce((sum, record) => sum + record.amount, 0) * 100) / 100,
    parts: records.length,
    sharedWith,
    reference: records.map((record) => record.reference).filter(Boolean).join(", ") || null,
  };
}

export async function findPayouts(payouts: PayoutToFind[], today: string): Promise<Map<number, PaymentFound>> {
  const found = new Map<number, PaymentFound>();
  const toFind = payouts.filter((payout) => payout.net > 0);
  if (!toFind.length) return found;
  const ends = toFind.map((payout) => payout.end).sort();
  const records = await xeroRecords(addDays(ends[0], -WINDOW_BEFORE), addDays(ends.at(-1)!, WINDOW_AFTER));
  const used = new Set<XeroRecord>();
  const inWindow = (payout: PayoutToFind) =>
    records.filter((record) => !used.has(record) && daysAfter(payout.end, record.date) >= -WINDOW_BEFORE && daysAfter(payout.end, record.date) <= WINDOW_AFTER);
  const take = (payout: PayoutToFind, matched: XeroRecord[], sharedWith: string | null = null) => {
    matched.forEach((record) => used.add(record));
    found.set(payout.statementId, describe(matched, sharedWith));
  };
  const open = () => toFind.filter((payout) => !found.has(payout.statementId));

  for (const payout of open()) {
    const match = inWindow(payout).find((record) => near(record.amount, payout.net) && sameName(payout.landlord, record.contact));
    if (match) take(payout, [match]);
  }
  for (const payout of open()) {
    const sameAmount = inWindow(payout).filter((record) => near(record.amount, payout.net));
    if (sameAmount.length === 1) take(payout, sameAmount);
  }
  for (const payout of open()) {
    const named = inWindow(payout).filter((record) => sameName(payout.landlord, record.contact)).sort((a, b) => a.date.localeCompare(b.date));
    const parts = partsAddingUp(named, payout.net);
    if (parts) take(payout, parts);
  }
  for (const payout of open()) {
    if (found.has(payout.statementId)) continue;
    const partner = open().find((other) => other !== payout && sameName(payout.landlord, other.landlord));
    if (!partner) continue;
    const match = inWindow(payout).find((record) => near(record.amount, payout.net + partner.net) && sameName(payout.landlord, record.contact));
    if (match) {
      take(payout, [match], partner.landlord);
      found.set(partner.statementId, describe([match], payout.landlord));
    }
  }
  for (const payout of open()) {
    found.set(payout.statementId, {
      status: daysAfter(payout.end, today) <= WAIT_DAYS ? "waiting" : "missing",
      company: null, kind: null, date: null, amount: null, parts: 0, sharedWith: null, reference: null,
    });
  }
  return found;
}
