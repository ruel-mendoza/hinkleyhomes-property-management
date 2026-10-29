import { cohoGet } from "./coho-api";

// COHO's rent bank feed and its overdue tenancies, plus our own suggestion of
// which unmatched bank line may be an overdue rent payment. COHO's own match
// suggestions aren't in its API, so this is a simple, explainable rule:
// an unmatched money-in line for exactly the overdue amount, received from a
// week before the rent was due up to today. Each line suggests one tenancy.
// Matching itself is still done in COHO.

type RecordValue = Record<string, unknown>;
const asRecord = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
const list = (value: unknown): RecordValue[] => (Array.isArray(value) ? value.map(asRecord) : []);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

const ukDateFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" });
export const ukToday = () => ukDateFormat.format(new Date());
export const toUkDate = (value: unknown): string | null => {
  const text = str(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : ukDateFormat.format(date);
};
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export type BankLineStatus = "matched" | "partly_matched" | "unmatched" | "excluded";
export type BankLine = {
  id: string;
  date: string;
  amount: number;
  payer: string | null;
  reference: string | null;
  description: string | null;
  account: string | null;
  status: BankLineStatus;
  possibleDuplicate: boolean;
  snoozedUntil: string | null;
};
export type OverdueTenancy = {
  tenancyGuid: string;
  tenancyNumber: string | null;
  propertyReference: string;
  propertyName: string;
  roomReference: string | null;
  roomName: string | null;
  tenantName: string | null;
  outstanding: number;
  daysInArrears: number;
  earliestDue: string | null;
};

// Bank and the last four digits only; the full account number stays here.
const maskAccount = (bank: string | null, account: string | null) => {
  const digits = account?.replace(/\s+/g, "").slice(-4);
  return [bank, digits ? `••••${digits}` : null].filter(Boolean).join(" ") || null;
};

export async function loadBankLines(from: string, to: string): Promise<BankLine[]> {
  const items: RecordValue[] = [];
  for (let page = 1; page <= 30; page++) {
    const payload = asRecord(await cohoGet(`/transactions/items?transactionFilterStatus=all&showSnoozed=true&startDate=${from}&endDate=${to}&page=${page}&pageSize=100`));
    items.push(...list(payload.items));
    if (payload.hasNextPage !== true) break;
  }
  return items.map((line) => ({
    id: String(line.guid),
    date: toUkDate(line.date) ?? to,
    amount: Math.round(num(line.amount) * 100) / 100,
    payer: str(line.name),
    reference: str(line.reference),
    description: str(line.description) ?? str(line.originalDescription),
    account: maskAccount(str(line.bank), str(line.account)),
    status: line.isExcluded === true ? "excluded"
      : line.status === "assigned" || line.isMatched === true ? "matched"
        : line.status === "partiallyAssigned" ? "partly_matched"
          : "unmatched",
    possibleDuplicate: line.potentialDuplicate === true,
    snoozedUntil: toUkDate(line.snoozeUntil),
  }));
}

async function pages(path: string): Promise<RecordValue[]> {
  const items: RecordValue[] = [];
  for (let page = 1; page <= 20; page++) {
    const payload = asRecord(await cohoGet(`${path}&page=${page}&pageSize=100`));
    items.push(...list(payload.items));
    if (payload.hasNextPage !== true) break;
  }
  return items;
}

export async function loadOverdueTenancies(): Promise<OverdueTenancy[]> {
  const [items, tenancies] = await Promise.all([pages("/credit-control/tenancies?scope=overdue"), pages("/tenancies?includeCurrent=true")]);
  const numbers = new Map(tenancies.map((tenancy) => [String(tenancy.guid), str(tenancy.tenancyNumber)]));
  return items
    .filter((item) => item.exclude !== true && num(item.totalOutstanding) > 0)
    .map((item) => ({
      tenancyGuid: String(item.tenancyGuid),
      tenancyNumber: numbers.get(String(item.tenancyGuid)) ?? null,
      propertyReference: str(item.propertyReference) ?? "",
      propertyName: str(item.propertyName) ?? "Unknown property",
      roomReference: str(item.roomReference),
      roomName: str(item.roomName),
      tenantName: str(item.tenantName),
      outstanding: num(item.totalOutstanding),
      daysInArrears: Math.max(Math.trunc(num(item.daysInArrears)), 0),
      earliestDue: toUkDate(item.earliestDateDue),
    }));
}

// tenancyGuid -> bank line, using each line at most once.
export function suggestPayments(arrears: OverdueTenancy[], lines: BankLine[], today = ukToday()): Map<string, BankLine> {
  const open = lines.filter((line) => (line.status === "unmatched" || line.status === "partly_matched") && line.amount > 0);
  const used = new Set<string>();
  const result = new Map<string, BankLine>();
  for (const arrear of [...arrears].sort((a, b) => b.daysInArrears - a.daysInArrears)) {
    const earliest = arrear.earliestDue ? addDays(arrear.earliestDue, -7) : "0000-00-00";
    const candidate = open
      .filter((line) => !used.has(line.id) && Math.abs(line.amount - arrear.outstanding) < 0.005 && line.date >= earliest && line.date <= today)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    if (candidate) {
      used.add(candidate.id);
      result.set(arrear.tenancyGuid, candidate);
    }
  }
  return result;
}

// Plain-English reason shown with each proposal.
export function matchReason(arrear: OverdueTenancy, line: BankLine): string {
  if (!arrear.earliestDue) return "Same amount as the overdue rent.";
  const days = Math.round((Date.parse(`${line.date}T12:00:00Z`) - Date.parse(`${arrear.earliestDue}T12:00:00Z`)) / 86_400_000);
  const when = days === 0 ? "on the day it was due" : days > 0 ? `${days} ${days === 1 ? "day" : "days"} after it was due` : `${-days} ${days === -1 ? "day" : "days"} before it was due`;
  return `Same amount as the overdue rent, received ${when}.`;
}

// One cached read of the feed and arrears, shared by the bank feed page and the overview.
const CACHE_MS = 15 * 60_000;
let cache: { at: number; key: string; lines: BankLine[]; arrears: OverdueTenancy[] } | null = null;
export async function rentMatchingData(from: string, refresh = false) {
  const today = ukToday();
  const key = `${from}|${today}`;
  if (!refresh && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache;
  const [lines, arrears] = await Promise.all([loadBankLines(from, today), loadOverdueTenancies()]);
  cache = { at: Date.now(), key, lines, arrears };
  return cache;
}
