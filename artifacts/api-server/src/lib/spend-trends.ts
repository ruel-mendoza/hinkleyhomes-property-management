// Spend-trend rules over the stored bill history (moved from the n8n workflow's
// "Detect Unusual Cost Increases" step). Pure functions only.
// - Supplier spend: last month's spend with a supplier against its 6-month average.
// - Expense category: the same per Xero account code.
// - Recurring bill: a new bill above a supplier's steady usual amount.
// Only recurring costs are judged (billed in most of the baseline months, or a
// steady repeating bill). Amounts are net of VAT.

import type { HistoryLine } from "./bill-checks";

export type SpendBill = {
  rowId: string;
  tenantId: string;
  company: string;
  billId: string;
  number: string | null;
  supplierKey: string;
  supplierName: string;
  billDate: string; // YYYY-MM-DD
  subTotal: number | null;
  lines: HistoryLine[];
};

export type SpendFlag = {
  code: "supplier_spend_up" | "category_spend_up" | "recurring_bill_up";
  severity: "high" | "warn";
  message: string;
  // Raised once per key: a month's trend, or one bill.
  key: string;
  billRowId: string | null;
  tenantId: string;
  company: string;
  subject: string;
  number: string | null;
  increase: number;
};

export type SpendOptions = {
  baselineMonths: number;
  minActiveMonths: number;
  spendRisePct: number;
  spendRiseMin: number;
  priceRisePct: number;
  priceRiseMin: number;
  priceMaxVariation: number;
  priceLookbackDays: number;
  highPct: number;
  highAbs: number;
};

export const DEFAULT_SPEND_OPTIONS: SpendOptions = {
  baselineMonths: 6,
  minActiveMonths: 4,
  spendRisePct: 25,
  spendRiseMin: 100,
  priceRisePct: 15,
  priceRiseMin: 25,
  priceMaxVariation: 0.15,
  priceLookbackDays: 45,
  highPct: 50,
  highAbs: 500,
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const gbp = (n: number) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const monthOf = (day: string) => day.slice(0, 7);
// "2026-10" minus n months.
const monthsBack = (month: string, n: number) => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return d.toISOString().slice(0, 7);
};

type Series = { tenantId: string; company: string; label: string; months: Map<string, number>; examples: Map<string, number> };

function add(map: Map<string, Series>, key: string, base: Omit<Series, "months" | "examples">, month: string, amount: number, example?: string) {
  const series = map.get(key) ?? { ...base, months: new Map(), examples: new Map() };
  series.months.set(month, (series.months.get(month) ?? 0) + amount);
  if (example) series.examples.set(example, (series.examples.get(example) ?? 0) + 1);
  map.set(key, series);
}

// today: YYYY-MM-DD in UK time. Bills are expected to cover at least baselineMonths + 1 months back.
export function spendFlags(bills: SpendBill[], today: string, opts: SpendOptions = DEFAULT_SPEND_OPTIONS): SpendFlag[] {
  const recent = monthsBack(monthOf(today), 1);
  const baseline = Array.from({ length: opts.baselineMonths }, (_, i) => monthsBack(monthOf(today), i + 2));
  const severity = (pct: number, inc: number): SpendFlag["severity"] => (pct >= opts.highPct && inc >= opts.highAbs ? "high" : "warn");
  const flags: SpendFlag[] = [];

  const suppliers = new Map<string, Series>();
  const categories = new Map<string, Series>();
  for (const bill of bills) {
    const month = monthOf(bill.billDate);
    const amount = bill.subTotal ?? bill.lines.reduce((sum, line) => sum + line.net, 0);
    add(suppliers, `${bill.tenantId}|${bill.supplierKey}`, { tenantId: bill.tenantId, company: bill.company, label: bill.supplierName }, month, amount);
    for (const line of bill.lines) {
      const code = line.accountCode ?? "Uncoded";
      add(categories, `${bill.tenantId}|${code}`, { tenantId: bill.tenantId, company: bill.company, label: `Account ${code}` }, month, line.net, line.key || undefined);
    }
  }

  const checkSpend = (map: Map<string, Series>, code: "supplier_spend_up" | "category_spend_up") => {
    for (const [key, series] of map) {
      const values = baseline.map((month) => series.months.get(month) ?? 0);
      const active = values.filter((v) => v > 0).length;
      if (active < opts.minActiveMonths) continue;
      const usual = values.reduce((sum, v) => sum + v, 0) / opts.baselineMonths;
      const now = series.months.get(recent) ?? 0;
      const inc = now - usual;
      if (usual <= 0) continue;
      const pct = (inc / usual) * 100;
      if (pct < opts.spendRisePct || inc < opts.spendRiseMin) continue;
      const top = [...series.examples].sort((a, b) => b[1] - a[1])[0]?.[0];
      const subject = top ? `${series.label} (e.g. "${top}")` : series.label;
      flags.push({
        code,
        severity: severity(pct, inc),
        message: `${code === "supplier_spend_up" ? "Spend with" : "Spend on"} ${subject} in ${recent} was ${gbp(now)}, against a usual ${gbp(usual)} a month (${baseline[baseline.length - 1]} to ${baseline[0]}, billed in ${active} of ${opts.baselineMonths} months): up ${Math.round(pct)}%.`,
        key: `${recent}|${key}|${code}`,
        billRowId: null,
        tenantId: series.tenantId,
        company: series.company,
        subject,
        number: null,
        increase: round2(inc),
      });
    }
  };
  checkSpend(suppliers, "supplier_spend_up");
  checkSpend(categories, "category_spend_up");

  // Recurring bills: compared with the previous six bills from the same supplier,
  // when those were steady (within priceMaxVariation of each other).
  const cutoff = new Date(Date.parse(`${today}T12:00:00Z`) - opts.priceLookbackDays * 86_400_000).toISOString().slice(0, 10);
  const bySupplier = new Map<string, SpendBill[]>();
  for (const bill of bills) {
    if (bill.subTotal === null || bill.subTotal <= 0) continue;
    const key = `${bill.tenantId}|${bill.supplierKey}`;
    bySupplier.set(key, [...(bySupplier.get(key) ?? []), bill]);
  }
  for (const list of bySupplier.values()) {
    list.sort((a, b) => a.billDate.localeCompare(b.billDate) || a.billId.localeCompare(b.billId));
    list.forEach((bill, i) => {
      if (bill.billDate < cutoff) return;
      const prior = list.slice(Math.max(0, i - 6), i).map((b) => b.subTotal!);
      if (prior.length < 3) return;
      const sorted = [...prior].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      if (!(median > 0) || (sorted[sorted.length - 1] - sorted[0]) / median > opts.priceMaxVariation) return;
      const inc = bill.subTotal! - median;
      const pct = (inc / median) * 100;
      if (pct < opts.priceRisePct || inc < opts.priceRiseMin) return;
      flags.push({
        code: "recurring_bill_up",
        severity: severity(pct, inc),
        message: `Bill ${bill.number ?? ""} dated ${bill.billDate} is ${gbp(bill.subTotal!)} before VAT, against a steady ${gbp(median)} over the previous ${prior.length} bills: up ${Math.round(pct)}%.`.replace("Bill  dated", "Bill dated"),
        key: "recurring_bill_up",
        billRowId: bill.rowId,
        tenantId: bill.tenantId,
        company: bill.company,
        subject: bill.supplierName,
        number: bill.number,
        increase: round2(inc),
      });
    });
  }

  return flags.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1) || b.increase - a.increase);
}
