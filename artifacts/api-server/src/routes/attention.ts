import { Router, type IRouter } from "express";
import { and, asc, desc, eq, gte, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
  cohoActionsTable,
  exceptionQueueTable,
  getDb,
  invoiceIntakeReviewsTable,
  isDatabaseConfigured,
  xeroOverdueTrackingTable,
} from "@workspace/db";
import { GetAttentionResponse } from "@workspace/api-zod";
import { latestReviews } from "../lib/bill-coding";
import { clearResolvedIntakeReviews } from "../lib/intake-reviews";
import { fetchComplianceOverview } from "../lib/coho-compliance";
import { cohoApiKey } from "../lib/integrations-env";

// Operations overview, "Needs attention": what someone should act on today,
// from the app's own tables (alerts, reviews, held bills, overdue ranking, COHO
// actions) and one cached COHO compliance call. The page adds the figures it
// already loads (arrears, rent reviews, deposits, chase today, banking). Each
// source is read on its own, so one failing only drops its rows.

type Severity = "high" | "warn" | "info";
type Item = { key: string; severity: Severity; label: string; count: number; amount: number | null; detail: string | null; href: string };

const router: IRouter = Router();
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const daysAgo = (date: Date) => Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));

async function financeAlerts(): Promise<Item[]> {
  const q = exceptionQueueTable;
  const open = (kind: "bank_detail_change" | "invoice_variance") => and(eq(q.kind, kind), eq(q.status, "open"));
  const [bank, prices] = await Promise.all([
    getDb().select({ summary: q.summary, details: q.details }).from(q).where(open("bank_detail_change")).orderBy(desc(q.createdAt)),
    getDb().select({ n: sql<number>`count(*)::int` }).from(q).where(and(open("invoice_variance"), sql`${q.details}->>'severity' = 'high'`)),
  ]);
  const items: Item[] = [];
  if (bank.length) {
    const supplier = (bank[0].details as Record<string, unknown> | null)?.supplier;
    items.push({
      key: "bank_details", severity: "high", label: "Supplier bank details changed", count: bank.length, amount: null,
      detail: `${typeof supplier === "string" && supplier ? supplier : bank[0].summary} · phone them before the next payment`,
      href: "/checks?tab=alerts",
    });
  }
  const n = prices[0]?.n ?? 0;
  if (n) items.push({ key: "price_alerts", severity: "warn", label: "Bill prices well above usual", count: n, amount: null, detail: null, href: "/checks?tab=alerts" });
  return items;
}

async function intakeReviews(): Promise<Item[]> {
  // Not worth failing the item over: uncleared reviews just stay counted until next time.
  await clearResolvedIntakeReviews().catch(() => undefined);
  const t = invoiceIntakeReviewsTable;
  const rows = await getDb().select({ createdAt: t.createdAt, supplier: t.supplierName, sender: t.senderEmail }).from(t).where(eq(t.status, "open")).orderBy(asc(t.createdAt));
  if (!rows.length) return [];
  const oldest = rows[0];
  return [{
    key: "intake_reviews", severity: "warn", label: "Invoices for review", count: rows.length, amount: null,
    detail: `oldest ${daysAgo(oldest.createdAt) ? `${plural(daysAgo(oldest.createdAt), "day")} old` : "from today"}${oldest.supplier || oldest.sender ? ` (${oldest.supplier || oldest.sender})` : ""}`,
    href: "/invoices?tab=review",
  }];
}

async function heldBills(): Promise<Item[]> {
  const held = (await latestReviews()).filter((row) => ["held", "create_failed", "read_failed"].includes(row.status));
  if (!held.length) return [];
  const failed = held.filter((row) => row.status !== "held").length;
  return [{
    key: "held_bills", severity: "warn", label: "Supplier bills held", count: held.length, amount: null,
    detail: failed ? `${failed} could not be read or written to Xero` : "need a property or a decision",
    href: "/checks?tab=coding",
  }];
}

async function actNowOverdue(): Promise<Item[]> {
  const t = xeroOverdueTrackingTable;
  // Only what the last few daily checks still saw, so a stopped schedule doesn't leave old rows.
  const recent = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  const rows = await getDb()
    .select({ ledger: t.ledger, n: sql<number>`count(*)::int`, amount: sql<string>`coalesce(sum(${t.amountDue}), 0)` })
    .from(t)
    .where(and(isNull(t.clearedOn), eq(t.priority, 1), gte(t.lastSeenOn, recent)))
    .groupBy(t.ledger);
  return rows.filter((row) => row.n > 0).map((row) => row.ledger === "receivable"
    ? { key: "overdue_receivable", severity: "high" as const, label: "Overdue to us: act now", count: row.n, amount: Number(row.amount), detail: "high value or long overdue", href: "/checks" }
    : { key: "overdue_payable", severity: "warn" as const, label: "Our bills overdue: act now", count: row.n, amount: Number(row.amount), detail: "suppliers waiting to be paid", href: "/checks" });
}

async function cohoActions(propertyReference: string | undefined): Promise<Item[]> {
  const t = cohoActionsTable;
  const rows = await getDb()
    .select({ category: t.category, propertyName: t.propertyName, dueDate: t.dueDate })
    .from(t)
    .where(and(
      ne(t.status, "completed"), eq(t.archived, false), eq(t.snoozed, false), isNull(t.removedFromCohoAt),
      or(eq(t.overdue, true), lt(t.dueDate, new Date())),
      propertyReference ? eq(t.cohoPropertyReference, propertyReference) : undefined,
    ))
    .orderBy(asc(t.dueDate));
  if (!rows.length) return [];
  const maintenance = rows.filter((row) => row.category === "maintenance").length;
  const oldest = rows.find((row) => row.dueDate);
  return [{
    key: "coho_actions", severity: maintenance ? "warn" : "info", label: "COHO actions overdue", count: rows.length, amount: null,
    detail: [maintenance ? `${maintenance} maintenance` : null, oldest?.dueDate ? `oldest due ${plural(daysAgo(oldest.dueDate), "day")} ago${oldest.propertyName ? ` (${oldest.propertyName})` : ""}` : null].filter(Boolean).join(" · ") || null,
    href: "/actions",
  }];
}

// One COHO call per bucket (every property at once), kept for 10 minutes.
const COMPLIANCE_CACHE_MS = 10 * 60_000;
const complianceCache = new Map<string, { at: number; items: Item[] }>();

async function compliance(propertyReference: string | undefined): Promise<Item[]> {
  if (!cohoApiKey()) return [];
  const cacheKey = propertyReference ?? "";
  const hit = complianceCache.get(cacheKey);
  if (hit && Date.now() - hit.at < COMPLIANCE_CACHE_MS) return hit.items;
  const count = async (days: number) => {
    const { leaves, names } = await fetchComplianceOverview(days, propertyReference);
    let total = 0;
    let worst = { name: "", n: 0 };
    for (const [reference, items] of leaves) {
      const n = [...items.values()].reduce((sum, leaf) => sum + (leaf.total ?? 0), 0);
      total += n;
      if (n > worst.n) worst = { name: names.get(reference) || reference, n };
    }
    return { total, worst };
  };
  const [expired, due] = await Promise.all([count(0), count(30)]);
  const items: Item[] = [];
  if (expired.total) items.push({ key: "compliance_expired", severity: "high", label: "Compliance expired", count: expired.total, amount: null, detail: expired.worst.name ? `most at ${expired.worst.name} (${expired.worst.n})` : null, href: "/compliance?status=expired" });
  if (due.total) items.push({ key: "compliance_due", severity: "info", label: "Compliance due within 30 days", count: due.total, amount: null, detail: due.worst.name ? `most at ${due.worst.name} (${due.worst.n})` : null, href: "/compliance?status=due_30" });
  complianceCache.set(cacheKey, { at: Date.now(), items });
  return items;
}

router.get("/overview/attention", async (req, res): Promise<void> => {
  const property = typeof req.query.property === "string" && req.query.property.trim() ? req.query.property.trim().slice(0, 100) : undefined;
  const sources: [string, () => Promise<Item[]>][] = [
    ["COHO compliance", () => compliance(property)],
    ...(isDatabaseConfigured()
      ? ([
        ["Finance alerts", financeAlerts],
        ["Invoices for review", intakeReviews],
        ["Bill coding", heldBills],
        ["Overdue ranking", actNowOverdue],
        ["COHO actions", () => cohoActions(property)],
      ] as [string, () => Promise<Item[]>][])
      : []),
  ];
  const results = await Promise.allSettled(sources.map(([, read]) => read()));
  const problems: string[] = [];
  const items = results.flatMap((result, index) => {
    if (result.status === "fulfilled") return result.value;
    req.log.warn({ err: result.reason }, `Needs attention: ${sources[index][0]} could not be read`);
    problems.push(`${sources[index][0]} could not be checked.`);
    return [];
  });
  res.json(GetAttentionResponse.parse({ items, problems, checked: sources.map(([name]) => name) }));
});

export default router;
