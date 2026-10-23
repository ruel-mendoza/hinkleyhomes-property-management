import { timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type RequestHandler } from "express";
import { isDatabaseConfigured } from "@workspace/db";
import { cohoApiKey, pmsSyncKey } from "../lib/integrations-env";
import { syncCohoActions } from "../lib/coho-actions-sync";
import { recordUnitSnapshot, ukToday } from "../lib/performance";
import { performanceData } from "./performance";
import { readXeroGatewayEnv } from "../lib/integrations-env";
import { AUTOMATIC_AUTHOR, getReminderSettings, isWeekend, logReminder } from "../lib/xero-reminders";
import { DEFAULT_OPTIONS as DEFAULT_BILL_CHECK_OPTIONS, type IncomingBill } from "../lib/bill-checks";
import { checkAndRecordBills } from "../lib/bill-checks-store";
import {
  ALL_TENANT_IDS,
  activityFor,
  addDays,
  loadFollowUps,
  receivablesSnapshot,
  recordFollowUp,
  reminderDecisions,
  reminderItem,
  type ReminderResult,
} from "./receivables";

// Machine-to-machine endpoints (n8n schedules). Mounted before the staff
// sign-in check, so each request must carry the shared PMS_SYNC_KEY instead.
const router: IRouter = Router();

const requireSyncKey: RequestHandler = (req, res, next) => {
  const expected = pmsSyncKey();
  const provided = req.get("X-Hinkley-Sync-Key") ?? "";
  if (!expected) {
    res.status(503).json({ error: "PMS_SYNC_KEY is not configured." });
    return;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
};

router.post("/integrations/coho/actions/sync", requireSyncKey, async (_req, res): Promise<void> => {
  if (!isDatabaseConfigured() || !cohoApiKey()) {
    res.status(503).json({ error: "COHO or the database is not configured." });
    return;
  }
  const result = await syncCohoActions("schedule");
  res.status(result.status === "failed" ? 502 : 200).json(result);
});

// Daily unit snapshot for occupancy history (see lib/performance.ts). The
// Performance page also records one when opened; this keeps days covered
// when nobody opens it.
router.post("/integrations/coho/unit-snapshot", requireSyncKey, async (req, res): Promise<void> => {
  if (!isDatabaseConfigured() || !cohoApiKey()) {
    res.status(503).json({ error: "COHO or the database is not configured." });
    return;
  }
  try {
    const day = ukToday();
    const units = await recordUnitSnapshot(await performanceData(true), day);
    res.json({ day, units });
  } catch (error) {
    req.log.error({ err: error }, "Scheduled unit snapshot failed");
    res.status(502).json({ error: "The unit snapshot could not be recorded." });
  }
});

// --- Payment reminders (n8n "Xero overdue reminders" workflow) -----------------------
// The workflow asks for today's plan each morning, sends each reminder, then
// reports every result back here. Automatic reminders stay off until switched on
// in the app, and test mode sends everything to the internal address.
const MAX_PER_RUN = 25;

router.get("/integrations/xero/reminders/plan", requireSyncKey, async (req, res): Promise<void> => {
  if (!isDatabaseConfigured() || readXeroGatewayEnv().status !== "configured") {
    res.status(503).json({ error: "The database or the Xero gateway is not configured." });
    return;
  }
  const settings = await getReminderSettings(ALL_TENANT_IDS);
  const base = { enabled: settings.autoEnabled, mode: settings.mode, items: [] as unknown[] };
  if (!settings.autoEnabled) {
    res.json({ ...base, reason: "Automatic reminders are switched off in the app." });
    return;
  }
  if (settings.weekdaysOnly && isWeekend()) {
    res.json({ ...base, reason: "Weekend: reminders only go out Monday to Friday." });
    return;
  }
  const snapshot = await receivablesSnapshot(true, req.log);
  const followUps = (await loadFollowUps(snapshot.invoices.map((invoice) => invoice.invoiceId))) ?? new Map();
  const activity = await activityFor(snapshot.invoices);
  const decisions = await reminderDecisions(snapshot, settings, followUps, activity);
  const due = snapshot.invoices.filter((invoice) => decisions.get(`${invoice.tenantId}|${invoice.invoiceId}`)?.eligible).slice(0, MAX_PER_RUN);
  const items = [];
  for (const invoice of due) {
    const decision = decisions.get(`${invoice.tenantId}|${invoice.invoiceId}`)!;
    items.push(await reminderItem(invoice, settings, decision.nextStage!, "auto_reminder", null));
  }
  res.json({ ...base, reason: items.length ? `${items.length} reminder(s) due.` : "No reminders due today.", items });
});

// What the workflow posts back for each item (checked by hand; n8n sends plain JSON).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parseResult(body: unknown): ReminderResult | null {
  const value = (body ?? {}) as Record<string, unknown>;
  const text = (field: string, max: number) => {
    const raw = value[field];
    if (raw === undefined || raw === null || raw === "") return null;
    return typeof raw === "string" || typeof raw === "number" ? String(raw).slice(0, max) : null;
  };
  const action = value.action, kind = value.kind, status = value.status;
  if (!["reminder", "xero_resend", "xero_note"].includes(String(action))) return null;
  if (!["auto_reminder", "manual_reminder", "xero_resend", "xero_note"].includes(String(kind))) return null;
  if (!["sent", "failed", "skipped"].includes(String(status))) return null;
  const tenantId = text("tenantId", 64)?.toLowerCase();
  const invoiceId = text("invoiceId", 64)?.toLowerCase();
  if (!tenantId || !ALL_TENANT_IDS.includes(tenantId) || !invoiceId || !UUID.test(invoiceId)) return null;
  const stage = Number(value.stage);
  return {
    action: action as ReminderResult["action"],
    kind: kind as ReminderResult["kind"],
    tenantId,
    invoiceId,
    invoiceNumber: text("invoiceNumber", 100),
    customer: text("customer", 300),
    stage: Number.isInteger(stage) && stage >= 0 && stage <= 20 ? stage : null,
    testMode: value.testMode === true || value.testMode === "true",
    sentTo: text("sentTo", 300),
    subject: text("subject", 500),
    status: status as ReminderResult["status"],
    detail: text("detail", 2000),
    requestedBy: text("requestedBy", 300),
  };
}

router.post("/integrations/xero/reminders/result", requireSyncKey, async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  const result = parseResult(req.body);
  if (!result) {
    res.status(400).json({ error: "Invalid reminder result." });
    return;
  }
  const detail = result.detail ?? (result.subject ? `Subject: ${result.subject}` : null);
  await logReminder({
    xeroTenantId: result.tenantId,
    xeroInvoiceId: result.invoiceId,
    invoiceNumber: result.invoiceNumber ?? null,
    contactName: result.customer ?? null,
    kind: result.kind,
    stage: result.stage ?? null,
    testMode: result.testMode,
    sentTo: result.sentTo ?? null,
    status: result.status,
    detail,
    requestedBy: result.requestedBy ?? null,
  });

  // Live sends also show in the invoice's follow-up history; test sends are only logged.
  if (result.status === "sent" && !result.testMode && result.action !== "xero_note") {
    const settings = await getReminderSettings(ALL_TENANT_IDS);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
    const current = (await loadFollowUps([result.invoiceId]))?.get(`${result.tenantId}|${result.invoiceId}`);
    const keepOutcome = current && ["promised", "disputed", "paid_elsewhere", "write_off_review"].includes(current.outcome);
    await recordFollowUp({
      tenantId: result.tenantId,
      invoiceId: result.invoiceId,
      invoiceNumber: result.invoiceNumber ?? null,
      contactName: result.customer ?? null,
      outcome: keepOutcome ? current!.outcome : "chased",
      nextChaseDate: addDays(today, settings.minDaysBetween),
      note: result.action === "reminder"
        ? `${result.kind === "auto_reminder" ? "Automatic" : "Manual"} reminder (stage ${result.stage ?? "?"}) emailed to ${result.sentTo ?? "the customer"}.`
        : "Invoice re-sent to the customer from Xero.",
      author: result.requestedBy ?? AUTOMATIC_AUTHOR,
      forceNote: true,
    });
  }
  res.json({
    status: result.status,
    detail: result.status === "sent"
      ? result.action === "reminder" ? `${result.testMode ? "Test " : ""}reminder (stage ${result.stage ?? "?"}) sent to ${result.sentTo ?? "the customer"}.` : result.action === "xero_resend" ? "Invoice re-sent from Xero." : "Note added to the invoice in Xero."
      : detail ?? "Not sent.",
    sentTo: result.sentTo ?? null,
    testMode: result.testMode,
  });
});

// --- Supplier bill checks (n8n "Xero watcher") ----------------------------------------
// The watcher posts the bills it saw this run; the reply lists price and
// bank-detail flags for its digest (isNew = raised for the first time). Flags
// also go to the exception queue; see lib/bill-checks-store.ts. Body, from Xero's bill fields:
// { bills: [{ tenant_id, company, id (InvoiceID), number, supplier, contact_id, date (YYYY-MM-DD),
//   total, currency, status, line_amount_types, lines: [{ description, quantity, unit_amount,
//   line_amount, tax_amount }], bank?: { account_name, sort_code, account_number, iban } }] }
const MAX_BILLS = 2000;
const DAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

function parseBill(raw: unknown): IncomingBill | null {
  const value = (raw ?? {}) as Record<string, unknown>;
  const text = (input: unknown, max: number) =>
    typeof input === "string" && input.trim() ? input.trim().slice(0, max) : typeof input === "number" ? String(input) : null;
  const amount = (input: unknown) => {
    const n = typeof input === "number" ? input : typeof input === "string" && input.trim() ? Number(input) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const tenantId = text(value.tenant_id, 64)?.toLowerCase();
  const billId = text(value.id, 64)?.toLowerCase();
  const supplier = text(value.supplier, 300);
  if (!tenantId || !ALL_TENANT_IDS.includes(tenantId) || !billId || !UUID.test(billId) || !supplier) return null;
  const date = text(value.date, 10);
  const contactId = text(value.contact_id, 64)?.toLowerCase() ?? null;
  const types = text(value.line_amount_types, 20);
  const bank = value.bank && typeof value.bank === "object" ? (value.bank as Record<string, unknown>) : null;
  return {
    tenantId,
    company: text(value.company, 200) ?? "",
    billId,
    number: text(value.number, 100),
    supplier,
    contactId: contactId && UUID.test(contactId) ? contactId : null,
    date: date && DAY_FORMAT.test(date) && !Number.isNaN(Date.parse(date)) ? date : null,
    total: amount(value.total),
    currency: (text(value.currency, 3) ?? "GBP").toUpperCase(),
    status: (text(value.status, 30) ?? "AUTHORISED").toUpperCase(),
    lineAmountTypes: types === "Inclusive" || types === "NoTax" ? types : "Exclusive",
    lines: (Array.isArray(value.lines) ? value.lines : []).slice(0, 500).map((item) => {
      const line = (item ?? {}) as Record<string, unknown>;
      return {
        description: text(line.description, 500),
        quantity: amount(line.quantity),
        unitAmount: amount(line.unit_amount),
        lineAmount: amount(line.line_amount ?? line.amount),
        taxAmount: amount(line.tax_amount),
      };
    }),
    bank: bank
      ? { accountName: text(bank.account_name, 200), sortCode: text(bank.sort_code, 20), accountNumber: text(bank.account_number, 30), iban: text(bank.iban, 40) }
      : null,
  };
}

router.post("/integrations/xero/bills/check", requireSyncKey, async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  const raw: unknown[] = Array.isArray(req.body?.bills) ? req.body.bills : [];
  if (raw.length > MAX_BILLS) {
    res.status(413).json({ error: `Too many bills in one request (max ${MAX_BILLS}).` });
    return;
  }
  // The last copy wins when the same bill is sent twice.
  const bills = new Map<string, IncomingBill>();
  let rejected = 0;
  for (const item of raw) {
    const bill = parseBill(item);
    if (bill) bills.set(`${bill.tenantId}|${bill.billId}`, bill);
    else rejected++;
  }
  if (!bills.size) {
    res.json({ checked: 0, rejected, flags: [], summary: { high: 0, warn: 0, info: 0, new: 0 } });
    return;
  }
  try {
    const flags = await checkAndRecordBills([...bills.values()], DEFAULT_BILL_CHECK_OPTIONS, req.id !== undefined && req.id !== null ? String(req.id) : null);
    const count = (severity: string) => flags.filter((flag) => flag.severity === severity).length;
    res.json({
      checked: bills.size,
      rejected,
      flags,
      summary: { high: count("high"), warn: count("warn"), info: count("info"), new: flags.filter((flag) => flag.isNew).length },
    });
  } catch (error) {
    req.log.error({ err: error }, "Bill checks failed");
    res.status(500).json({ error: "The bill checks could not be run." });
  }
});

export default router;
