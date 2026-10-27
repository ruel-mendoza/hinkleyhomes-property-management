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
import { runDailyChecks } from "../lib/finance-checks";
import { codingPlan, recordResult, recordReview, savedReading } from "../lib/bill-coding";
import type { XeroBill } from "../lib/bill-coding-rules";
import { parseIntakeReview, recordIntakeReview } from "../lib/intake-reviews";
import { smoobuMode } from "../lib/integrations-env";
import { handleSmoobuEvent, syncStays } from "../lib/stays";
import { handleChargeAutomationEvent } from "../lib/guest-checks";
import { COMPANIES } from "./money";
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

// --- Smoobu (n8n "Hinkley PMS – Smoobu sync") -----------------------------------------
// Smoobu webhooks reach n8n, which forwards each one here as it came ({ action, user, data }).
// The booking is re-read from Smoobu, so a forged event can only cause a refresh.
router.post("/integrations/smoobu/event", requireSyncKey, async (req, res): Promise<void> => {
  if (!isDatabaseConfigured() || !smoobuMode()) {
    res.status(503).json({ error: "Smoobu or the database is not configured." });
    return;
  }
  try {
    res.json(await handleSmoobuEvent(req.body));
  } catch (error) {
    req.log.error({ err: error }, "Smoobu event could not be handled");
    res.status(502).json({ error: "The booking could not be read from Smoobu." });
  }
});

// Hourly catch-up: bookings changed since the last good run, and the apartment list.
router.post("/integrations/smoobu/sync", requireSyncKey, async (_req, res): Promise<void> => {
  if (!isDatabaseConfigured() || !smoobuMode()) {
    res.status(503).json({ error: "Smoobu or the database is not configured." });
    return;
  }
  const result = await syncStays("schedule");
  res.status(result.status === "failed" ? 502 : 200).json(result);
});

// --- ChargeAutomation (n8n "Hinkley PMS – ChargeAutomation events") ---------------------
// Guest payment, deposit, ID, card and online check-in events, forwarded as they
// came (an array with one { event, data }). Only outcomes are kept; online
// check-in is confirmed with ChargeAutomation through the gateway when it is set up.
router.post("/integrations/chargeautomation/event", requireSyncKey, async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  try {
    res.json(await handleChargeAutomationEvent(req.body));
  } catch (error) {
    req.log.error({ err: error }, "ChargeAutomation event could not be handled");
    res.status(500).json({ error: "The ChargeAutomation event could not be recorded." });
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

// --- Bill coding (n8n "Route A: Xero-first" workflow, hourly) -------------------------
// See lib/bill-coding.ts: the app picks the bills, keeps the readings and the
// reviews, and decides what n8n writes to Xero.
router.get("/integrations/bill-coding/plan", requireSyncKey, async (req, res): Promise<void> => {
  if (!isDatabaseConfigured() || readXeroGatewayEnv().status !== "configured") {
    res.status(503).json({ error: "The database or the Xero gateway is not configured." });
    return;
  }
  try {
    res.json(await codingPlan());
  } catch (error) {
    req.log.error({ err: error }, "Bill coding plan failed");
    res.status(502).json({ error: "The bills to check could not be worked out." });
  }
});

router.get("/integrations/bill-coding/readings/:hash", requireSyncKey, async (req, res): Promise<void> => {
  const hash = String(req.params.hash ?? "");
  if (!isDatabaseConfigured() || !/^[a-z0-9-]{4,80}$/i.test(hash)) {
    res.json({ found: false });
    return;
  }
  const reading = await savedReading(hash);
  res.json(reading ? { found: true, extraction: reading.extraction, model: reading.model, provider: reading.provider } : { found: false });
});

function parseXeroBill(raw: unknown): XeroBill | null {
  const v = (raw ?? {}) as Record<string, unknown>;
  const s = (key: string, max = 300) => (typeof v[key] === "string" ? (v[key] as string).slice(0, max) : "");
  const tenantId = s("tenantId", 64).toLowerCase();
  const invoiceId = s("invoiceId", 64).toLowerCase();
  if (!ALL_TENANT_IDS.includes(tenantId) || !UUID.test(invoiceId)) return null;
  return {
    key: `xero::${tenantId}::${invoiceId}`,
    tenantId,
    tenantName: COMPANIES.find((company) => company.tenantId === tenantId)!.name,
    invoiceId,
    number: s("number", 100),
    status: s("status", 30),
    supplierName: s("supplierName"),
    currency: s("currency", 3) || "GBP",
    date: s("date", 10),
    dueDate: s("dueDate", 10),
    total: typeof v.total === "number" && Number.isFinite(v.total) ? v.total : null,
    lineAmountTypes: s("lineAmountTypes", 20),
    url: `https://go.xero.com/AccountsPayable/View.aspx?invoiceID=${invoiceId}`,
    lines: (Array.isArray(v.lines) ? v.lines : []).slice(0, 500).map((item) => {
      const l = (item ?? {}) as Record<string, unknown>;
      return {
        description: typeof l.description === "string" ? l.description.slice(0, 2000) : "",
        lineAmount: typeof l.lineAmount === "number" && Number.isFinite(l.lineAmount) ? l.lineAmount : null,
        accountCode: typeof l.accountCode === "string" ? l.accountCode.slice(0, 20) : "",
        taxType: typeof l.taxType === "string" ? l.taxType.slice(0, 40) : "",
      };
    }),
  };
}

router.post("/integrations/bill-coding/review", requireSyncKey, async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const xero = parseXeroBill(body.xero);
  const source = (body.source ?? {}) as Record<string, unknown>;
  const extraction = body.extraction && typeof body.extraction === "object" && !Array.isArray(body.extraction) ? (body.extraction as Record<string, unknown>) : null;
  if (!xero) {
    res.status(400).json({ error: "Send the bill as the plan returned it (xero.tenantId and xero.invoiceId)." });
    return;
  }
  try {
    const result = await recordReview({
      xero,
      docHash: typeof body.doc_hash === "string" ? body.doc_hash.slice(0, 80) : "",
      fromCache: body.from_cache === true,
      provider: typeof body.provider === "string" ? body.provider.slice(0, 40) : "",
      model: typeof body.model === "string" ? body.model.slice(0, 80) : "",
      extraction,
      extractionError: typeof body.extraction_error === "string" && body.extraction_error ? body.extraction_error.slice(0, 1000) : null,
      source: {
        filename: typeof source.filename === "string" ? source.filename.slice(0, 300) : "",
        mimeType: typeof source.mime_type === "string" ? source.mime_type.slice(0, 100) : "",
        sourceType: typeof source.source_type === "string" ? source.source_type.slice(0, 40) : "",
      },
    }, req.id !== undefined && req.id !== null ? String(req.id) : null);
    res.json(result);
  } catch (error) {
    req.log.error({ err: error }, "Bill coding review failed");
    res.status(500).json({ error: "The bill could not be reviewed." });
  }
});

router.post("/integrations/bill-coding/result", requireSyncKey, async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const text = (key: string, max: number) => (typeof body[key] === "string" && body[key] ? (body[key] as string).slice(0, max) : null);
  const reviewId = text("review_id", 64);
  const planIndex = Number(body.plan_index);
  if (!reviewId || !UUID.test(reviewId) || !Number.isInteger(planIndex) || planIndex < 0) {
    res.status(400).json({ error: "Send review_id and plan_index as the review returned them." });
    return;
  }
  const updated = await recordResult({
    reviewId,
    planIndex,
    ok: body.ok === true || body.ok === "true",
    xeroInvoiceId: text("xero_invoice_id", 64),
    xeroStatus: text("xero_status", 30),
    error: text("error", 1000),
    attachment: text("attachment", 300),
  });
  if (!updated) {
    res.status(404).json({ error: "Review not found." });
    return;
  }
  res.json({ status: updated.status });
});

// --- Inbox intake check (n8n "Hinkley Intake check", every minute) ---------------------
// Emails the check sent for review (see lib/intake-reviews.ts). Body: { internet_message_id,
//   outlook_message_id, web_link, received_at, sender_email, sender_name, subject, supplier_name,
//   invoice_number, invoice_date, total, currency, bill_to, bill_to_company,
//   reasons: [{ code, message }], issues: [{ code, message, lines: [{ text, amount }] }] }
router.post("/integrations/intake/review", requireSyncKey, async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  const review = parseIntakeReview(req.body);
  if (!review) {
    res.status(400).json({ error: "Send internet_message_id (or outlook_message_id) with the review." });
    return;
  }
  try {
    res.json(await recordIntakeReview(review));
  } catch (error) {
    req.log.error({ err: error }, "Intake review could not be saved");
    res.status(500).json({ error: "The review could not be saved." });
  }
});

// --- Xero daily checks (n8n "Xero daily checks" workflow, 8am) -------------------------
// Overdue ranking, bill price and bank checks, and spend trends; see
// lib/finance-checks.ts. The first run reads 13 months of bills and takes longer.
router.post("/integrations/xero/daily-checks", requireSyncKey, async (req, res): Promise<void> => {
  if (!isDatabaseConfigured() || readXeroGatewayEnv().status !== "configured") {
    res.status(503).json({ error: "The database or the Xero gateway is not configured." });
    return;
  }
  const result = await runDailyChecks("schedule", req.id !== undefined && req.id !== null ? String(req.id) : null);
  res.status(result.status === "failed" ? 502 : result.status === "skipped" ? 409 : 200).json(result);
});

// --- Supplier bill checks (n8n "Xero watcher") ----------------------------------------
// The watcher posts the bills it saw this run; the reply lists price and
// bank-detail flags for its digest (isNew = raised for the first time). Flags
// also go to the exception queue; see lib/bill-checks-store.ts. Body, from Xero's bill fields:
// { bills: [{ tenant_id, company, id (InvoiceID), number, supplier, contact_id, date (YYYY-MM-DD),
//   total, sub_total, currency, status, line_amount_types, lines: [{ description, quantity,
//   unit_amount, line_amount, tax_amount, account_code }], bank?: { account_name, sort_code,
//   account_number, iban } }] }
// The daily checks fetch bills from Xero themselves; this endpoint is for bank
// details read from invoice documents, which Xero doesn't hold.
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
    subTotal: amount(value.sub_total),
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
        accountCode: text(line.account_code, 20),
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
