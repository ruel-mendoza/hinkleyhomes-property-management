// Price and bank-detail rules for supplier bills sent by the n8n "Xero watcher".
// Pure functions only: lib/bill-checks-store.ts loads the history and records
// what these return.

export type BillLine = {
  description: string | null;
  quantity: number | null;
  unitAmount: number | null;
  lineAmount: number | null;
  taxAmount: number | null;
};

export type BankDetails = {
  accountName: string | null;
  sortCode: string | null;
  accountNumber: string | null;
  iban: string | null;
};

export type IncomingBill = {
  tenantId: string;
  company: string;
  billId: string;
  number: string | null;
  supplier: string;
  contactId: string | null;
  date: string | null; // YYYY-MM-DD
  total: number | null;
  currency: string; // upper case; GBP when Xero didn't say
  status: string; // Xero status, upper case
  lineAmountTypes: "Exclusive" | "Inclusive" | "NoTax";
  lines: BillLine[];
  bank: BankDetails | null;
};

export type PricedLine = { key: string; unitPrice: number };

export type PastBill = {
  tenantId: string;
  billId: string;
  supplierKey: string;
  billDate: string | null;
  total: number | null;
  currency: string;
  status: string;
  lines: PricedLine[];
};

export type FlagCode =
  | "line_price_up"
  | "bill_total_unusual"
  | "bank_details_new"
  | "bank_details_changed"
  | "bank_details_replaced"
  | "bank_details_unchecked";

export type Flag = {
  code: FlagCode;
  severity: "high" | "warn" | "info";
  message: string;
  // Identifies the flag within its bill, so a re-sent bill doesn't raise it twice.
  check: string;
};

export type CheckOptions = {
  lookbackDays: number; // how far back to compare prices
  priceUpPct: number; // e.g. 0.15 = 15%
  priceUpMinAbs: number; // ignore rises smaller than this per unit, in currency units
  minHistory: number; // past occurrences needed before a price is judged
  totalUnusualFactor: number; // total more than this many times the usual bill
};

export const DEFAULT_OPTIONS: CheckOptions = {
  lookbackDays: 365,
  priceUpPct: 0.15,
  priceUpMinAbs: 20,
  minHistory: 2,
  totalUnusualFactor: 2.5,
};

// Only bills Xero treats as real count as price history; voided and deleted
// bills are stored but neither checked nor compared with.
const COUNTED_STATUSES = new Set(["SUBMITTED", "AUTHORISED", "PAID"]);
export const isCheckedStatus = (status: string) => status !== "VOIDED" && status !== "DELETED";

const DAY = 86_400_000;
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const round2 = (n: number) => Math.round(n * 100) / 100;

const keyChars = (s: string) => s.replace(/[^a-z0-9]+/g, "");

// "ABC Plumbing Ltd" and "A.B.C. Plumbing Limited" are the same supplier.
export const supplierKey = (name: string): string => {
  const lower = name.toLowerCase().replace(/&/g, " and ");
  return keyChars(lower.replace(/\b(ltd|limited|plc|llp|the)\b/g, " ")) || keyChars(lower);
};

// Same job worded the same way = same key. Numbers and generic address words are
// dropped, so "Clean - Flat 2 - 03/10" and "Clean - Flat 5 - 10/10" both read
// "clean"; street and property names are kept, so prices compare per property.
export const lineKey = (description: string | null): string =>
  String(description ?? "")
    .toLowerCase()
    .replace(/\d+/g, " ")
    .replace(/\b(flat|unit|apt|apartment|room|road|rd|street|st|avenue|ave|lane|close|house)\b/g, " ")
    .replace(/[^a-z]+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => word.length > 2)
    .slice(0, 6)
    .join(" ");

// Price per unit, net of VAT. Inclusive amounts without the tax figure are
// skipped rather than compared with net prices.
export function unitNetPrice(line: BillLine, types: IncomingBill["lineAmountTypes"]): number | null {
  const quantity = line.quantity !== null && line.quantity > 0 ? line.quantity : 1;
  let net: number | null;
  if (types === "Inclusive") {
    const gross = line.lineAmount ?? (line.unitAmount !== null ? line.unitAmount * quantity : null);
    net = gross !== null && line.taxAmount !== null ? gross - line.taxAmount : null;
  } else {
    net = line.unitAmount !== null ? line.unitAmount * quantity : line.lineAmount;
  }
  return net !== null && Number.isFinite(net) && net > 0 ? round2(net / quantity) : null;
}

export const pricedLines = (bill: IncomingBill): PricedLine[] =>
  bill.lines.flatMap((line) => {
    const key = lineKey(line.description);
    const unitPrice = unitNetPrice(line, bill.lineAmountTypes);
    return key && unitPrice !== null ? [{ key, unitPrice }] : [];
  });

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const money = (n: number, currency: string) => (currency === "GBP" ? "£" : `${currency} `) + n.toFixed(2);

export function priceFlags(bill: IncomingBill, history: PastBill[], opts: CheckOptions = DEFAULT_OPTIONS): Flag[] {
  if (!isCheckedStatus(bill.status)) return [];
  const key = supplierKey(bill.supplier);
  const billMs = bill.date ? dayMs(bill.date) : Date.now();
  const past = history.filter((h) => {
    if (h.supplierKey !== key || (h.billId === bill.billId && h.tenantId === bill.tenantId)) return false;
    if (h.currency !== bill.currency || !COUNTED_STATUSES.has(h.status) || !h.billDate) return false;
    const age = billMs - dayMs(h.billDate);
    return age >= 0 && age <= opts.lookbackDays * DAY;
  });
  const flags: Flag[] = [];

  // 1. The same kind of line from the same supplier, compared with its usual unit price.
  const seen = new Set<string>();
  for (const line of pricedLines(bill)) {
    if (seen.has(line.key)) continue;
    seen.add(line.key);
    const prices = past.flatMap((h) => h.lines.filter((l) => l.key === line.key).map((l) => l.unitPrice));
    if (prices.length < opts.minHistory) continue;
    const usual = median(prices);
    const rise = line.unitPrice - usual;
    if (usual > 0 && rise >= opts.priceUpMinAbs && rise / usual >= opts.priceUpPct) {
      const pct = Math.round((rise / usual) * 100);
      flags.push({
        code: "line_price_up",
        severity: pct >= 50 ? "high" : "warn",
        message: `"${line.key}" is ${money(line.unitPrice, bill.currency)} per unit before VAT, usually ${money(usual, bill.currency)} (${prices.length} past lines): up ${pct}%.`,
        check: `line_price_up:${line.key}`,
      });
    }
  }

  // 2. The whole bill far above this supplier's usual bill.
  const totals = past.map((h) => h.total).filter((t): t is number => t !== null && t > 0);
  if (bill.total !== null && totals.length >= Math.max(3, opts.minHistory)) {
    const usual = median(totals);
    if (bill.total >= usual * opts.totalUnusualFactor && bill.total - usual >= opts.priceUpMinAbs) {
      flags.push({
        code: "bill_total_unusual",
        severity: "info",
        message: `Total ${money(bill.total, bill.currency)} is ${(bill.total / usual).toFixed(1)}x this supplier's usual bill (${money(usual, bill.currency)}).`,
        check: "bill_total_unusual",
      });
    }
  }
  return flags;
}

// --- Bank details --------------------------------------------------------------

export type UkAccount = { sortCode: string; accountNumber: string };

export function ukAccount(bank: BankDetails | null): UkAccount | null {
  const sortCode = String(bank?.sortCode ?? "").replace(/\D/g, "");
  const accountNumber = String(bank?.accountNumber ?? "").replace(/\D/g, "");
  return sortCode.length === 6 && accountNumber.length >= 6 && accountNumber.length <= 10 ? { sortCode, accountNumber } : null;
}

export const maskAccount = (account: UkAccount) => `${account.sortCode.slice(0, 2)}-**-** / ****${account.accountNumber.slice(-4)}`;

// What the app already holds for the supplier, newest first.
export type KnownAccount = UkAccount & { id: string; isActive: boolean; verified: boolean };

const PHONE = "Phone the supplier on a number you already hold before paying.";

// Unverified accounts are flagged on every bill until a person verifies them,
// so a missed digest doesn't lose the warning.
export function bankFlag(account: UkAccount, known: KnownAccount[]): Flag | null {
  const match = known.find((k) => k.sortCode === account.sortCode && k.accountNumber === account.accountNumber);
  const others = known.filter((k) => k !== match);
  if (!match || !match.verified) {
    if (!others.length) {
      return {
        code: "bank_details_new",
        severity: "warn",
        message: `First bank account seen for this supplier (${maskAccount(account)}), not verified yet. ${PHONE}`,
        check: "bank",
      };
    }
    const previous = others.find((k) => k.isActive) ?? others[0];
    return {
      code: "bank_details_changed",
      severity: "high",
      message: `Bank details differ from those on file: was ${maskAccount(previous)}, now ${maskAccount(account)}, not verified yet. ${PHONE}`,
      check: "bank",
    };
  }
  const current = others.find((k) => k.isActive);
  if (!match.isActive && current) {
    return {
      code: "bank_details_replaced",
      severity: "warn",
      message: `Bill gives ${maskAccount(account)}, an older account; the supplier's current verified account is ${maskAccount(current)}.`,
      check: "bank",
    };
  }
  return null;
}

export const ibanOnlyFlag = (bank: BankDetails | null): Flag | null =>
  bank?.iban && !ukAccount(bank)
    ? { code: "bank_details_unchecked", severity: "warn", message: `Bank details are an IBAN, which the app can't check yet. ${PHONE}`, check: "bank" }
    : null;
