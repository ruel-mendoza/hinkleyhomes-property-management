// Ranks overdue invoices and bills by value, age and risk (moved from the n8n
// workflow's "Rank by Impact and Risk" step). Pure functions only.

export type OverdueInput = {
  ledger: "receivable" | "payable";
  tenantId: string;
  company: string;
  invoiceId: string;
  number: string | null;
  contactId: string | null;
  contactName: string;
  dueDate: string | null;
  daysOverdue: number;
  amountDue: number;
  total: number;
};

export type RankedOverdue = OverdueInput & {
  amountPaid: number;
  valueBand: "High" | "Medium" | "Low";
  ageBucket: string;
  riskScore: number;
  riskProfile: "High" | "Medium" | "Low";
  riskReasons: string[];
  priority: 1 | 2 | 3;
  // Rough guide (amount x typical loss rate for that age); receivables only.
  valueAtRisk: number;
  contactExposure: number;
  contactOverdueCount: number;
};

// GBP thresholds.
export const VALUE_HIGH = 2500;
export const VALUE_MEDIUM = 500;
const EXPOSURE_HIGH = 10000;
const EXPOSURE_MEDIUM = 2500;
// Age buckets with an indicative chance the money is never collected.
export const AGE_BUCKETS = [
  { max: 30, label: "1-30 days", points: 0, lossRate: 0.05 },
  { max: 60, label: "31-60 days", points: 1, lossRate: 0.1 },
  { max: 90, label: "61-90 days", points: 2, lossRate: 0.25 },
  { max: 180, label: "91-180 days", points: 3, lossRate: 0.5 },
  { max: 365, label: "181-365 days", points: 4, lossRate: 0.75 },
  { max: Infinity, label: "Over 1 year", points: 5, lossRate: 0.9 },
];

const round2 = (n: number) => Math.round(n * 100) / 100;
const gbp = (n: number) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Most urgent first: priority, then value at risk, then amount.
export function rankOverdue(items: OverdueInput[]): RankedOverdue[] {
  const overdue = items.filter((item) => item.daysOverdue > 0 && item.amountDue > 0);
  const contacts = new Map<string, { count: number; total: number }>();
  const contactKey = (item: OverdueInput) => `${item.tenantId}|${item.ledger}|${item.contactId ?? item.contactName}`;
  for (const item of overdue) {
    const c = contacts.get(contactKey(item)) ?? { count: 0, total: 0 };
    c.count += 1;
    c.total += item.amountDue;
    contacts.set(contactKey(item), c);
  }

  return overdue
    .map((item): RankedOverdue => {
      const c = contacts.get(contactKey(item))!;
      const age = AGE_BUCKETS.find((bucket) => item.daysOverdue <= bucket.max)!;
      const valueBand = item.amountDue >= VALUE_HIGH ? "High" : item.amountDue >= VALUE_MEDIUM ? "Medium" : "Low";
      const amountPaid = round2(Math.max(0, item.total - item.amountDue));
      let score = age.points;
      const reasons: string[] = [];
      if (age.points >= 2) reasons.push(`${age.label} overdue`);
      if (c.count >= 3) { score += 2; reasons.push(`${c.count} overdue for this contact`); }
      else if (c.count === 2) { score += 1; reasons.push("2 overdue for this contact"); }
      if (c.total >= EXPOSURE_HIGH) { score += 2; reasons.push(`${gbp(c.total)} outstanding with this contact`); }
      else if (c.total >= EXPOSURE_MEDIUM) { score += 1; reasons.push(`${gbp(c.total)} outstanding with this contact`); }
      if (amountPaid > 0) { score -= 1; reasons.push("part-paid"); }
      const riskProfile = score >= 5 ? "High" : score >= 2 ? "Medium" : "Low";
      let priority: 1 | 2 | 3 = 3;
      if ((valueBand === "High" && riskProfile !== "Low") || (valueBand === "Medium" && riskProfile === "High")) priority = 1;
      else if (valueBand === "High" || (valueBand === "Medium" && riskProfile === "Medium") || (valueBand === "Low" && riskProfile === "High")) priority = 2;
      return {
        ...item,
        amountPaid,
        valueBand,
        ageBucket: age.label,
        riskScore: score,
        riskProfile,
        riskReasons: reasons,
        priority,
        valueAtRisk: item.ledger === "receivable" ? round2(item.amountDue * age.lossRate) : 0,
        contactExposure: round2(c.total),
        contactOverdueCount: c.count,
      };
    })
    .sort((a, b) => a.priority - b.priority || b.valueAtRisk - a.valueAtRisk || b.amountDue - a.amountDue);
}
