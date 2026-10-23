import { and, desc, eq, gte, inArray, isNull, like } from "drizzle-orm";
import {
  getDb,
  integrationSyncRunsTable,
  xeroBillHistoryTable,
  xeroOverdueTrackingTable,
  type XeroOverdueTracking,
} from "@workspace/db";
import { COMPANIES } from "../routes/money";
import { receivablesSnapshot, type Snapshot } from "../routes/receivables";
import { DEFAULT_OPTIONS, type IncomingBill } from "./bill-checks";
import { checkAndRecordBills, raiseExceptions, type ExceptionDraft } from "./bill-checks-store";
import { logger } from "./logger";
import { rankOverdue, type OverdueInput, type RankedOverdue } from "./overdue-ranking";
import { spendFlags, DEFAULT_SPEND_OPTIONS } from "./spend-trends";
import { parseXeroDate, xeroGatewayRequest } from "./xero-gateway";

// Xero daily checks. The app is the one place that reads Xero (through the n8n
// gateway); the n8n "Xero daily checks" workflow only starts a run each morning,
// and staff can start one from the Finance checks page. A run:
// 1. ranks overdue invoices and bills and tracks what is new or more urgent;
// 2. fetches supplier bills changed since the last run (13 months on the first
//    run) into xero_bill_history and runs the price and bank-detail checks;
// 3. runs the monthly spend-trend checks over the stored history.
// Findings go to exception_queue; nothing is emailed.

export const DAILY_CHECKS_TRIGGER = "xero_daily_checks:";
const HISTORY_MONTHS = 13;
// Bills dated before this many days ago are recorded but not price-checked.
const CHECK_WINDOW_DAYS = 45;
const PAGE_SIZE = 1000;
const STALE_RUN_MS = 20 * 60_000;

type RecordValue = Record<string, unknown>;
const asRecord = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
const list = (value: unknown): RecordValue[] => (Array.isArray(value) ? value.map(asRecord) : []);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const xeroDay = (value: unknown) => parseXeroDate(value)?.toISOString().slice(0, 10) ?? null;
export const ukToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export type CheckRunDetails = {
  overdueReceivables: number;
  overdueReceivablesTotal: number;
  overduePayables: number;
  overduePayablesTotal: number;
  priority1: number;
  newOverdue: number;
  billsSynced: number;
  fullBillSync: boolean;
  billFlags: number;
  newBillFlags: number;
  spendFlags: number;
  newSpendFlags: number;
  problems: string[];
};

// --- Overdue ----------------------------------------------------------------------

export function overdueInputs(snapshot: Snapshot): OverdueInput[] {
  return [
    ...snapshot.invoices.map((invoice) => ({
      ledger: "receivable" as const,
      tenantId: invoice.tenantId,
      company: invoice.company,
      invoiceId: invoice.invoiceId.toLowerCase(),
      number: invoice.number,
      contactId: invoice.contactId,
      contactName: invoice.contactName,
      dueDate: invoice.dueDate,
      daysOverdue: invoice.daysOverdue,
      amountDue: invoice.amountDue,
      total: invoice.total,
    })),
    ...snapshot.bills.map((bill) => ({
      ledger: "payable" as const,
      tenantId: bill.tenantId,
      company: bill.company,
      invoiceId: bill.billId.toLowerCase(),
      number: bill.number,
      contactId: bill.contactId,
      contactName: bill.contactName,
      dueDate: bill.dueDate,
      daysOverdue: bill.daysOverdue,
      amountDue: bill.amountDue,
      total: bill.total,
    })),
  ];
}

export type OverdueChange = "new" | "escalated" | "ongoing";

// New: first seen on the latest run (or not tracked yet). Escalated: its
// priority is more urgent than at the run before. What the very first run found
// is the starting point, not new.
export function overdueChange(item: RankedOverdue, row: XeroOverdueTracking | undefined, firstDay: string | null): OverdueChange {
  if (row && !row.clearedOn && row.firstSeenOn === firstDay && row.previousPriority === null) return "ongoing";
  if (!row || row.clearedOn || row.firstSeenOn === row.lastSeenOn) return "new";
  if (row.previousPriority !== null && item.priority < row.previousPriority) return "escalated";
  return "ongoing";
}

// UK day of the first successful daily check.
export async function firstCheckDay(): Promise<string | null> {
  const r = integrationSyncRunsTable;
  const [first] = await getDb()
    .select({ startedAt: r.startedAt })
    .from(r)
    .where(and(eq(r.integration, "xero"), eq(r.status, "succeeded"), like(r.trigger, `${DAILY_CHECKS_TRIGGER}%`)))
    .orderBy(r.startedAt)
    .limit(1);
  return first ? new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(first.startedAt) : null;
}

export async function loadTracking(): Promise<Map<string, XeroOverdueTracking>> {
  const rows = await getDb().select().from(xeroOverdueTrackingTable).where(isNull(xeroOverdueTrackingTable.clearedOn));
  return new Map(rows.map((row) => [`${row.xeroTenantId}|${row.xeroInvoiceId}`, row]));
}

async function trackOverdue(ranked: RankedOverdue[], readTenants: Set<string>, today: string): Promise<number> {
  const db = getDb();
  const t = xeroOverdueTrackingTable;
  const open = await loadTracking();
  const all = await db.select({ id: t.id, tenantId: t.xeroTenantId, invoiceId: t.xeroInvoiceId }).from(t);
  const anyRow = new Map(all.map((row) => [`${row.tenantId}|${row.invoiceId}`, row.id]));
  let fresh = 0;
  await db.transaction(async (tx) => {
    for (const item of ranked) {
      const key = `${item.tenantId}|${item.invoiceId}`;
      const current = open.get(key);
      const values = { invoiceNumber: item.number, contactName: item.contactName, amountDue: item.amountDue.toFixed(2), lastSeenOn: today, priority: item.priority };
      if (current) {
        if (current.lastSeenOn === today) continue;
        await tx.update(t).set({ ...values, previousPriority: current.priority }).where(eq(t.id, current.id));
      } else if (anyRow.has(key)) {
        // Overdue again after being cleared: starts over as new.
        fresh++;
        await tx.update(t).set({ ...values, firstSeenOn: today, previousPriority: null, clearedOn: null }).where(eq(t.id, anyRow.get(key)!));
      } else {
        fresh++;
        await tx.insert(t).values({ ...values, xeroTenantId: item.tenantId, xeroInvoiceId: item.invoiceId, ledger: item.ledger, firstSeenOn: today });
      }
    }
    // No longer overdue (paid, credited, voided): only for companies read in full.
    const still = new Set(ranked.map((item) => `${item.tenantId}|${item.invoiceId}`));
    const cleared = [...open.values()].filter((row) => readTenants.has(row.xeroTenantId) && !still.has(`${row.xeroTenantId}|${row.xeroInvoiceId}`)).map((row) => row.id);
    for (let i = 0; i < cleared.length; i += 500) await tx.update(t).set({ clearedOn: today }).where(inArray(t.id, cleared.slice(i, i + 500)));
  });
  return fresh;
}

// --- Bills from Xero ----------------------------------------------------------------

function toIncomingBill(company: { tenantId: string; name: string }, bill: RecordValue): IncomingBill | null {
  const billId = str(bill.InvoiceID)?.toLowerCase();
  const contact = asRecord(bill.Contact);
  const supplier = str(contact.Name);
  if (!billId || !supplier) return null;
  const types = str(bill.LineAmountTypes);
  return {
    tenantId: company.tenantId,
    company: company.name,
    billId,
    number: str(bill.InvoiceNumber),
    supplier,
    contactId: str(contact.ContactID)?.toLowerCase() ?? null,
    date: xeroDay(bill.Date),
    total: num(bill.Total),
    subTotal: num(bill.SubTotal),
    currency: (str(bill.CurrencyCode) ?? "GBP").toUpperCase(),
    status: (str(bill.Status) ?? "AUTHORISED").toUpperCase(),
    lineAmountTypes: types === "Inclusive" || types === "NoTax" ? types : "Exclusive",
    lines: list(bill.LineItems).map((line) => ({
      description: str(line.Description),
      quantity: num(line.Quantity),
      unitAmount: num(line.UnitAmount),
      lineAmount: num(line.LineAmount),
      taxAmount: num(line.TaxAmount),
      accountCode: str(line.AccountCode),
    })),
    bank: null,
  };
}

// Supplier bills (with line items) dated in the last HISTORY_MONTHS, changed
// since `since` when given. Voided and deleted bills are fetched too, so the
// history stops counting them.
async function fetchBills(company: { tenantId: string; name: string }, since: Date | null, today: string): Promise<IncomingBill[]> {
  const [y, m] = today.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1 - HISTORY_MONTHS, 1));
  const where = `Type=="ACCPAY"&&Date>=DateTime(${from.getUTCFullYear()},${from.getUTCMonth() + 1},1)`;
  const bills: IncomingBill[] = [];
  for (let page = 1; page <= 20; page++) {
    const response = await xeroGatewayRequest({
      tenantId: company.tenantId,
      resource: "invoices",
      query: { where, Statuses: "SUBMITTED,AUTHORISED,PAID,VOIDED,DELETED", page, pageSize: PAGE_SIZE },
      ifModifiedSince: since ?? undefined,
    });
    if (response.status === 304) break;
    if (!response.ok) throw new Error(response.status === 429 ? "Xero is rate limiting; try again shortly." : `Xero returned HTTP ${response.status}.`);
    const batch = list(asRecord(response.data).Invoices);
    for (const raw of batch) {
      const bill = toIncomingBill(company, raw);
      if (bill) bills.push(bill);
    }
    if (batch.length < PAGE_SIZE) break;
  }
  return bills;
}

async function runSpendTrends(today: string): Promise<{ total: number; fresh: number }> {
  const h = xeroBillHistoryTable;
  const [y, m] = today.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1 - (DEFAULT_SPEND_OPTIONS.baselineMonths + 2), 1)).toISOString().slice(0, 10);
  const rows = await getDb()
    .select()
    .from(h)
    .where(and(gte(h.billDate, from), inArray(h.status, ["AUTHORISED", "PAID"]), eq(h.currency, "GBP")));
  const flags = spendFlags(
    rows.map((row) => ({
      rowId: row.id,
      tenantId: row.xeroTenantId,
      company: row.company,
      billId: row.xeroBillId,
      number: row.billNumber,
      supplierKey: row.supplierKey,
      supplierName: row.supplierName,
      billDate: row.billDate!,
      subTotal: row.subTotal === null ? null : Number(row.subTotal),
      // Rows saved before account codes were kept have no net per line.
      lines: row.lines.filter((line) => typeof line.net === "number"),
    })),
    today,
  );
  const drafts: ExceptionDraft[] = flags.map((flag) => ({
    kind: "invoice_variance",
    sourceTable: flag.billRowId ? "xero_bill_history" : "xero_spend_trends",
    sourceId: flag.billRowId ?? flag.key,
    check: flag.billRowId ? flag.key : flag.code,
    summary: `${flag.subject} (${flag.company}): ${flag.message}`,
    details: { code: flag.code, severity: flag.severity, tenantId: flag.tenantId, company: flag.company, supplier: flag.subject, number: flag.number, increase: flag.increase },
  }));
  const fresh = await getDb().transaction((tx) => raiseExceptions(tx, drafts));
  return { total: flags.length, fresh: fresh.size };
}

// --- Runs -------------------------------------------------------------------------

export async function lastCheckRuns(limit = 10) {
  const r = integrationSyncRunsTable;
  return getDb()
    .select()
    .from(r)
    .where(and(eq(r.integration, "xero"), like(r.trigger, `${DAILY_CHECKS_TRIGGER}%`)))
    .orderBy(desc(r.startedAt))
    .limit(limit);
}

export type CheckRunResult = { status: "succeeded" | "failed" | "skipped"; runId: string | null; details: CheckRunDetails | null; error: string | null };

export async function runDailyChecks(trigger: "schedule" | "manual", requestId: string | null = null): Promise<CheckRunResult> {
  const db = getDb();
  const r = integrationSyncRunsTable;
  const recent = await lastCheckRuns(20);
  if (recent.some((run) => run.status === "running" && Date.now() - run.startedAt.getTime() < STALE_RUN_MS)) {
    return { status: "skipped", runId: null, details: null, error: "A check run is already in progress." };
  }
  // Bills are fetched from the last run that read every company's bills.
  const lastGood = recent.find((run) => run.status === "succeeded" && !((run.details as CheckRunDetails | null)?.problems ?? []).some((problem) => problem.includes(" bills: ")));
  const [run] = await db.insert(r).values({ integration: "xero", trigger: `${DAILY_CHECKS_TRIGGER}${trigger}` }).returning({ id: r.id, startedAt: r.startedAt });
  const today = ukToday();
  const problems: string[] = [];
  const details: CheckRunDetails = {
    overdueReceivables: 0, overdueReceivablesTotal: 0, overduePayables: 0, overduePayablesTotal: 0, priority1: 0, newOverdue: 0,
    billsSynced: 0, fullBillSync: !lastGood, billFlags: 0, newBillFlags: 0, spendFlags: 0, newSpendFlags: 0, problems,
  };

  try {
    // 1. Overdue ranking and tracking.
    try {
      const snapshot = await receivablesSnapshot(true);
      const ranked = rankOverdue(overdueInputs(snapshot));
      const receivables = ranked.filter((item) => item.ledger === "receivable");
      const payables = ranked.filter((item) => item.ledger === "payable");
      Object.assign(details, {
        overdueReceivables: receivables.length,
        overdueReceivablesTotal: Math.round(receivables.reduce((sum, item) => sum + item.amountDue, 0) * 100) / 100,
        overduePayables: payables.length,
        overduePayablesTotal: Math.round(payables.reduce((sum, item) => sum + item.amountDue, 0) * 100) / 100,
        priority1: ranked.filter((item) => item.priority === 1).length,
      });
      for (const company of snapshot.companies.filter((item) => item.error)) problems.push(`${company.name}: ${company.error}`);
      const fresh = await trackOverdue(ranked, new Set(snapshot.companies.filter((item) => !item.error).map((item) => item.tenantId)), today);
      // On the first run everything is the starting point.
      details.newOverdue = recent.some((item) => item.status === "succeeded") ? fresh : 0;
    } catch (error) {
      problems.push(`Overdue: ${(error as Error).message}`);
    }

    // 2. Supplier bills: changed since the last good run (an hour's overlap), or 13 months the first time.
    const since = lastGood ? new Date(lastGood.startedAt.getTime() - 60 * 60_000) : null;
    const bills: IncomingBill[] = [];
    for (const company of COMPANIES) {
      try {
        bills.push(...(await fetchBills(company, since, today)));
      } catch (error) {
        problems.push(`${company.name} bills: ${(error as Error).message}`);
      }
    }
    details.billsSynced = bills.length;
    if (bills.length) {
      const flags = await checkAndRecordBills(bills, DEFAULT_OPTIONS, requestId, addDays(today, -CHECK_WINDOW_DAYS));
      details.billFlags = flags.length;
      details.newBillFlags = flags.filter((flag) => flag.isNew).length;
    }

    // 3. Monthly spend trends over the stored history.
    const trends = await runSpendTrends(today);
    details.spendFlags = trends.total;
    details.newSpendFlags = trends.fresh;

    const failed = problems.length > 0 && details.billsSynced === 0 && details.overdueReceivables + details.overduePayables === 0;
    await db
      .update(r)
      .set({ status: failed ? "failed" : "succeeded", finishedAt: new Date(), recordsProcessed: bills.length, details, error: problems.length ? problems.join("; ").slice(0, 1000) : null })
      .where(eq(r.id, run.id));
    logger.info({ trigger, ...details }, "Xero daily checks finished");
    return { status: failed ? "failed" : "succeeded", runId: run.id, details, error: problems.length ? problems.join("; ") : null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(r).set({ status: "failed", finishedAt: new Date(), details, error: message.slice(0, 1000) }).where(eq(r.id, run.id)).catch(() => undefined);
    logger.warn({ trigger, err: error }, "Xero daily checks failed");
    return { status: "failed", runId: run.id, details, error: message };
  }
}
