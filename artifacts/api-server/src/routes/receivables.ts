import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  auditLogTable,
  getDb,
  isDatabaseConfigured,
  xeroInvoiceFollowUpNotesTable,
  xeroInvoiceFollowUpsTable,
  type XeroInvoiceFollowUp,
  type XeroReminderSettings,
} from "@workspace/db";
import {
  GetInvoicePaymentLinkParams,
  GetReceivablesResponse,
  GetReminderSettingsResponse,
  RunInvoiceActionBody,
  RunInvoiceActionParams,
  RunInvoiceActionResponse,
  UpdateInvoiceFollowUpBody,
  UpdateInvoiceFollowUpParams,
  UpdateInvoiceFollowUpResponse,
  UpdateReminderSettingsBody,
} from "@workspace/api-zod";
import { cohoApiKey, readReminderWebhookEnv, readXeroGatewayEnv } from "../lib/integrations-env";
import { cohoGet } from "../lib/coho-api";
import { parseXeroDate, xeroGatewayRequest } from "../lib/xero-gateway";
import {
  AUTOMATIC_AUTHOR,
  contactEmail,
  decideReminder,
  getReminderSettings,
  remindersFor,
  saveReminderSettings,
  xeroActivity,
  xeroRemindersSwitchedOn,
  type ReminderDecision,
  type XeroActivity,
} from "../lib/xero-reminders";
import { COMPANIES } from "./money";

// Invoices page: open sales invoices owed to each company and open bills each
// company owes, from Xero through the n8n gateway, plus our follow-ups and
// payment reminders. Follow-ups and the reminder log are kept in Supabase.
// Reminders, invoice re-sends and Xero notes are carried out by the n8n
// workflow "Xero overdue reminders" (n8n/xero-overdue-reminders.workflow.json).

type RecordValue = Record<string, unknown>;
const asRecord = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
const list = (value: unknown): RecordValue[] => (Array.isArray(value) ? value.map(asRecord) : []);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const round = (value: number) => Math.round(value * 100) / 100;

const ukToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
// Xero dates are date-only values at UTC midnight.
const xeroDay = (value: unknown) => parseXeroDate(value)?.toISOString().slice(0, 10) ?? null;
const daysPast = (due: string | null, today: string) => (due ? Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${due}T12:00:00Z`)) / 86_400_000) : 0);
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
export const ALL_TENANT_IDS: string[] = COMPANIES.map((company) => company.tenantId);

async function xeroPages(tenantId: string, where: string, statuses: string): Promise<RecordValue[]> {
  const items: RecordValue[] = [];
  for (let page = 1; page <= 10; page++) {
    const response = await xeroGatewayRequest({ tenantId, resource: "invoices", query: { where, Statuses: statuses, page, pageSize: 100 } });
    if (!response.ok) throw new Error(response.status === 429 ? "Xero is rate limiting; try again shortly." : `Xero returned HTTP ${response.status}.`);
    const batch = list(asRecord(response.data).Invoices);
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

const firstLine = (invoice: RecordValue) => asRecord(list(invoice.LineItems)[0]);
const trackingOption = (invoice: RecordValue) =>
  list(invoice.LineItems).flatMap((line) => list(line.Tracking)).map((tracking) => str(tracking.Option)).find(Boolean) ?? null;
const describe = (invoice: RecordValue) => str(firstLine(invoice).Description)?.replace(/\s+/g, " ").slice(0, 160) ?? null;

// "31 Lyndale Avenue" -> "31 lyndale": house number plus the first word of the street.
const addressKey = (name: string) => {
  const match = /^(\d+[a-z]?)\s+([a-z]+)/i.exec(name.trim());
  return match ? `${match[1]} ${match[2]}`.toLowerCase() : null;
};
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ");

async function cohoPropertyKeys(): Promise<{ key: string; propertyReference: string; propertyName: string }[]> {
  if (!cohoApiKey()) return [];
  const payload = asRecord(await cohoGet("/properties?page=1&pageSize=100"));
  return list(payload.items)
    .map((item) => ({ propertyReference: str(item.reference) ?? "", propertyName: str(item.name) ?? "", key: addressKey(str(item.name) ?? "") }))
    .filter((item): item is { key: string; propertyReference: string; propertyName: string } => Boolean(item.key && item.propertyReference));
}

export type Snapshot = Awaited<ReturnType<typeof loadXero>>;
export type SnapshotInvoice = Snapshot["invoices"][number];
async function loadXero() {
  const today = ukToday();
  const properties = await cohoPropertyKeys().catch(() => [] as Awaited<ReturnType<typeof cohoPropertyKeys>>);
  const results = await Promise.all(
    COMPANIES.map(async (company) => {
      try {
        const [sales, bills] = await Promise.all([
          xeroPages(company.tenantId, 'Type=="ACCREC"&&AmountDue>0', "AUTHORISED"),
          xeroPages(company.tenantId, 'Type=="ACCPAY"&&AmountDue>0', "AUTHORISED,SUBMITTED"),
        ]);
        return { company, sales, bills, error: null as string | null };
      } catch (error) {
        return { company, sales: [] as RecordValue[], bills: [] as RecordValue[], error: (error as Error).message };
      }
    }),
  );

  const invoices = results.flatMap(({ company, sales }) =>
    sales.map((invoice) => {
      const dueDate = xeroDay(invoice.DueDate);
      const property = trackingOption(invoice);
      const description = describe(invoice);
      const reference = str(invoice.Reference);
      // Rent invoices in companies that hold property money may duplicate a COHO tenancy.
      const text = squash([property, description, reference].filter(Boolean).join(" "));
      const looksLikeRent = company.holdsPropertyMoney && /\brent\b/.test(text);
      const coho = looksLikeRent ? properties.find((item) => text.includes(item.key)) : undefined;
      return {
        tenantId: company.tenantId,
        company: company.name,
        invoiceId: String(invoice.InvoiceID),
        contactId: str(asRecord(invoice.Contact).ContactID),
        number: str(invoice.InvoiceNumber),
        contactName: str(asRecord(invoice.Contact).Name) ?? "Unknown contact",
        reference,
        description,
        property,
        date: xeroDay(invoice.Date),
        dueDate,
        daysOverdue: daysPast(dueDate, today),
        total: round(num(invoice.Total)),
        amountDue: round(num(invoice.AmountDue)),
        sent: invoice.SentToContact === true,
        cohoProperty: coho ? { propertyReference: coho.propertyReference, propertyName: coho.propertyName } : null,
      };
    }),
  );
  const bills = results.flatMap(({ company, bills: items }) =>
    items.map((bill) => {
      const dueDate = xeroDay(bill.DueDate);
      return {
        tenantId: company.tenantId,
        company: company.name,
        billId: String(bill.InvoiceID),
        number: str(bill.InvoiceNumber),
        contactName: str(asRecord(bill.Contact).Name) ?? "Unknown supplier",
        description: describe(bill),
        property: trackingOption(bill),
        dueDate,
        daysOverdue: daysPast(dueDate, today),
        total: round(num(bill.Total)),
        amountDue: round(num(bill.AmountDue)),
        status: str(bill.Status) ?? "AUTHORISED",
      };
    }),
  );
  const companies = results.map(({ company, error }) => {
    const owed = invoices.filter((invoice) => invoice.tenantId === company.tenantId);
    const overdue = owed.filter((invoice) => invoice.daysOverdue > 0);
    const late = bills.filter((bill) => bill.tenantId === company.tenantId && bill.daysOverdue > 0);
    return {
      tenantId: company.tenantId,
      name: company.name,
      holdsPropertyMoney: company.holdsPropertyMoney,
      receivableOpen: round(owed.reduce((sum, invoice) => sum + invoice.amountDue, 0)),
      receivableOverdue: round(overdue.reduce((sum, invoice) => sum + invoice.amountDue, 0)),
      overdueCount: overdue.length,
      billsOverdue: round(late.reduce((sum, bill) => sum + bill.amountDue, 0)),
      billsOverdueCount: late.length,
      error,
    };
  });
  return {
    at: Date.now(),
    complete: results.every((result) => !result.error),
    asOf: today,
    companies,
    // Newest invoice first; ISO dates compare as strings.
    invoices: invoices.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || (b.number ?? "").localeCompare(a.number ?? "", undefined, { numeric: true })),
    bills: bills.sort((a, b) => (b.dueDate ?? "").localeCompare(a.dueDate ?? "") || (b.number ?? "").localeCompare(a.number ?? "", undefined, { numeric: true })),
  };
}

const CACHE_MS = 10 * 60_000;
let cache: Snapshot | null = null;

export async function receivablesSnapshot(refresh = false, log?: Request["log"]): Promise<Snapshot> {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return cache;
  const snapshot = await loadXero();
  // Only complete reads are cached, so a Xero blip is retried on the next load.
  cache = snapshot.complete ? snapshot : null;
  if (!snapshot.complete) log?.warn({ errors: snapshot.companies.filter((company) => company.error) }, "Some Xero companies could not be read for receivables");
  return snapshot;
}

// --- Follow-ups ------------------------------------------------------------------

export type FollowUpView = ReturnType<typeof followUpView>;
function followUpView(row: XeroInvoiceFollowUp, notes: { outcome: string; note: string | null; authorEmail: string | null; createdAt: Date }[]) {
  return {
    outcome: row.outcome,
    nextChaseDate: row.nextChaseDate,
    promisedDate: row.promisedDate,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
    remindersPaused: row.remindersPaused,
    notes: notes.slice(0, 10).map((note) => ({ ...note, createdAt: note.createdAt.toISOString() })),
  };
}

export async function loadFollowUps(invoiceIds: string[]): Promise<Map<string, FollowUpView> | null> {
  if (!isDatabaseConfigured()) return null;
  if (!invoiceIds.length) return new Map();
  const db = getDb();
  const rows = await db.select().from(xeroInvoiceFollowUpsTable).where(inArray(xeroInvoiceFollowUpsTable.xeroInvoiceId, invoiceIds));
  const notes = rows.length
    ? await db
        .select({
          followUpId: xeroInvoiceFollowUpNotesTable.followUpId,
          outcome: xeroInvoiceFollowUpNotesTable.outcome,
          note: xeroInvoiceFollowUpNotesTable.note,
          authorEmail: xeroInvoiceFollowUpNotesTable.authorEmail,
          createdAt: xeroInvoiceFollowUpNotesTable.createdAt,
        })
        .from(xeroInvoiceFollowUpNotesTable)
        .where(inArray(xeroInvoiceFollowUpNotesTable.followUpId, rows.map((row) => row.id)))
        .orderBy(desc(xeroInvoiceFollowUpNotesTable.createdAt))
    : [];
  return new Map(rows.map((row) => [`${row.xeroTenantId}|${row.xeroInvoiceId}`, followUpView(row, notes.filter((note) => note.followUpId === row.id))]));
}

// Upserts the follow-up state and appends a note; used by staff and by reminder results.
export async function recordFollowUp(input: {
  tenantId: string; invoiceId: string; invoiceNumber?: string | null; contactName?: string | null;
  outcome?: XeroInvoiceFollowUp["outcome"]; nextChaseDate?: string | null; promisedDate?: string | null; remindersPaused?: boolean;
  note?: string | null; author: string | null; forceNote?: boolean;
}) {
  const db = getDb();
  const t = xeroInvoiceFollowUpsTable;
  const [before] = await db.select().from(t).where(and(eq(t.xeroTenantId, input.tenantId), eq(t.xeroInvoiceId, input.invoiceId))).limit(1);
  const outcome = input.outcome ?? before?.outcome ?? "not_contacted";
  const values = {
    outcome,
    nextChaseDate: input.nextChaseDate !== undefined ? input.nextChaseDate : before?.nextChaseDate ?? null,
    promisedDate: input.promisedDate !== undefined ? input.promisedDate : before?.promisedDate ?? null,
    remindersPaused: input.remindersPaused ?? before?.remindersPaused ?? false,
    updatedBy: input.author,
  };
  const [saved] = await db
    .insert(t)
    .values({ xeroTenantId: input.tenantId, xeroInvoiceId: input.invoiceId, invoiceNumber: input.invoiceNumber ?? null, contactName: input.contactName ?? null, ...values })
    .onConflictDoUpdate({
      target: [t.xeroTenantId, t.xeroInvoiceId],
      set: {
        ...values,
        invoiceNumber: sql`coalesce(excluded.invoice_number, ${t.invoiceNumber})`,
        contactName: sql`coalesce(excluded.contact_name, ${t.contactName})`,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  if (input.forceNote || input.note || before?.outcome !== outcome) {
    await db.insert(xeroInvoiceFollowUpNotesTable).values({ followUpId: saved.id, outcome, note: input.note ?? null, authorEmail: input.author });
  }
  return { before: before ?? null, saved };
}

async function audit(req: Request, res: Response, action: string, tableName: string, recordId: string, before: unknown, after: unknown) {
  const staff = res.locals.staff as { userId?: string; email?: string } | undefined;
  await getDb()
    .insert(auditLogTable)
    .values({
      actorEmail: staff?.email ?? null,
      actorUserId: staff?.userId ?? null,
      action,
      tableName,
      recordId,
      before: before ?? null,
      after: after ?? null,
      requestId: req.id !== undefined && req.id !== null ? String(req.id) : null,
      ipAddress: req.ip ?? null,
    })
    .catch((error: unknown) => req.log.error({ err: error }, "Could not write the audit log entry"));
}

// --- Reminders -------------------------------------------------------------------------

async function inBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += size) results.push(...(await Promise.all(items.slice(index, index + size).map(run))));
  return results;
}

export async function activityFor(invoices: SnapshotInvoice[]): Promise<Map<string, XeroActivity | null>> {
  const overdue = invoices.filter((invoice) => invoice.daysOverdue >= 1);
  const pairs = await inBatches(overdue, 4, async (invoice) => {
    const [history, contact] = await Promise.all([
      xeroActivity(invoice.tenantId, invoice.invoiceId),
      invoice.contactId ? contactEmail(invoice.tenantId, invoice.contactId).catch(() => null) : Promise.resolve(null),
    ]);
    const optedOutGroup = contact?.optedOutGroup ?? null;
    // Keep the contact opt-out even when the invoice history can't be read.
    const activity: XeroActivity | null = history
      ? { ...history, optedOutGroup }
      : optedOutGroup
        ? { sentOn: null, reminderDates: [], remindersOff: null, optedOutGroup, recent: [] }
        : null;
    return [`${invoice.tenantId}|${invoice.invoiceId}`, activity] as const;
  });
  return new Map(pairs);
}

export async function reminderDecisions(snapshot: Snapshot, settings: XeroReminderSettings, followUps: Map<string, FollowUpView>, activity: Map<string, XeroActivity | null>) {
  const logs = await remindersFor(snapshot.invoices.map((invoice) => invoice.invoiceId));
  return new Map(
    snapshot.invoices.map((invoice) => {
      const key = `${invoice.tenantId}|${invoice.invoiceId}`;
      return [key, decideReminder(invoice, settings, followUps.get(key) ?? null, logs.get(key) ?? [], activity.get(key) ?? null, snapshot.asOf)] as const;
    }),
  );
}

// The item the n8n workflow turns into an email (or a Xero call). Email wording
// stages 1-3 escalate; stage 4 is the final notice and is used for the last stage.
export async function reminderItem(invoice: SnapshotInvoice, settings: XeroReminderSettings, stage: number, kind: "auto_reminder" | "manual_reminder", requestedBy: string | null) {
  const testMode = settings.mode === "test";
  const contact = invoice.contactId ? await contactEmail(invoice.tenantId, invoice.contactId).catch(() => ({ email: null, firstName: null })) : { email: null, firstName: null };
  const totalStages = settings.stageDays.length;
  const finalStage = stage >= totalStages;
  const noEmail = !contact.email;
  return {
    action: "reminder",
    kind,
    tenantId: invoice.tenantId,
    orgId: invoice.tenantId,
    invoiceId: invoice.invoiceId,
    company: invoice.company,
    contactId: invoice.contactId ?? "",
    customer: invoice.contactName,
    customerEmail: contact.email ?? "",
    firstName: contact.firstName ?? "",
    invoiceNumber: invoice.number ?? invoice.invoiceId,
    reference: invoice.reference ?? "",
    dueDate: invoice.dueDate ?? "",
    overdueDays: invoice.daysOverdue,
    stage,
    totalStages,
    wordingStage: finalStage ? 4 : Math.min(stage, 3),
    amountDueRaw: invoice.amountDue,
    amountDue: gbp.format(invoice.amountDue),
    testMode,
    sendTo: testMode || noEmail ? settings.internalEmail : contact.email!,
    cc: !testMode && !noEmail && finalStage ? settings.internalEmail : "",
    internalEmail: settings.internalEmail,
    signOffName: "The Accounts Team",
    xeroHistoryNotes: settings.xeroHistoryNotes && !testMode,
    requestedBy,
  };
}

// What the n8n workflow reports back after each item.
export type ReminderResult = {
  action: "reminder" | "xero_resend" | "xero_note";
  kind: "auto_reminder" | "manual_reminder" | "xero_resend" | "xero_note";
  tenantId: string; invoiceId: string; invoiceNumber?: string | null; customer?: string | null;
  stage?: number | null; testMode: boolean; sentTo?: string | null; subject?: string | null;
  status: "sent" | "failed" | "skipped"; detail?: string | null; requestedBy?: string | null;
};

export async function settingsSummary(settings: XeroReminderSettings) {
  const xeroFlags = await Promise.all(COMPANIES.map((company) => xeroRemindersSwitchedOn(company.tenantId)));
  return {
    autoEnabled: settings.autoEnabled,
    mode: settings.mode,
    internalEmail: settings.internalEmail,
    stageDays: [...settings.stageDays].sort((a, b) => a - b),
    maxOverdueDays: settings.maxOverdueDays,
    minDaysBetween: settings.minDaysBetween,
    manualChaseCooldownDays: settings.manualChaseCooldownDays,
    xeroReminderCooldownDays: settings.xeroReminderCooldownDays,
    weekdaysOnly: settings.weekdaysOnly,
    xeroHistoryNotes: settings.xeroHistoryNotes,
    companies: COMPANIES.map((company, index) => ({
      tenantId: company.tenantId,
      name: company.name,
      holdsPropertyMoney: company.holdsPropertyMoney,
      enabled: settings.companies.includes(company.tenantId),
      xeroRemindersOn: xeroFlags[index],
    })),
    webhookConfigured: readReminderWebhookEnv().status === "configured",
    updatedBy: settings.updatedBy,
    updatedAt: settings.updatedAt.toISOString(),
  };
}

// Calls the n8n reminders workflow's webhook and returns what it reported.
async function runWorkflow(items: unknown[]): Promise<unknown> {
  const env = readReminderWebhookEnv();
  if (env.status !== "configured") throw new Error("The n8n reminders workflow is not configured (N8N_REMINDER_WEBHOOK_URL).");
  const response = await fetch(env.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "X-Hinkley-Gateway-Key": env.key },
    body: JSON.stringify({ items }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(response.status === 404 ? "The n8n reminders workflow is not active." : `The n8n reminders workflow returned HTTP ${response.status}.`);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// --- Routes --------------------------------------------------------------------------------

const receivablesRouter: IRouter = Router();

receivablesRouter.get("/receivables", async (req, res): Promise<void> => {
  if (readXeroGatewayEnv().status !== "configured") {
    res.status(503).json({ error: "The n8n Xero gateway is not configured." });
    return;
  }
  const snapshot = await receivablesSnapshot(req.query.refresh === "1", req.log);

  let followUps: Map<string, FollowUpView> | null = null;
  try {
    followUps = await loadFollowUps(snapshot.invoices.map((invoice) => invoice.invoiceId));
  } catch (error) {
    // Usually the tables haven't been created yet (pnpm --filter @workspace/db run push).
    req.log.error({ err: error }, "Invoice follow-ups could not be read");
  }
  const activity = await activityFor(snapshot.invoices);
  let settings: XeroReminderSettings | null = null;
  let decisions: Map<string, ReminderDecision> | null = null;
  if (followUps) {
    try {
      settings = await getReminderSettings(ALL_TENANT_IDS);
      decisions = await reminderDecisions(snapshot, settings, followUps, activity);
    } catch (error) {
      req.log.error({ err: error }, "Payment reminders could not be read");
    }
  }

  res.json(
    GetReceivablesResponse.parse({
      asOf: snapshot.asOf,
      error: snapshot.companies.every((company) => company.error) ? "Xero could not be reached." : null,
      companies: snapshot.companies,
      invoices: snapshot.invoices.map((invoice) => {
        const key = `${invoice.tenantId}|${invoice.invoiceId}`;
        const decision = decisions?.get(key);
        return {
          ...invoice,
          followUp: followUps?.get(key) ?? null,
          reminder: decision && settings ? { ...decision, totalStages: settings.stageDays.length } : null,
          xeroActivity: activity.get(key) ?? null,
        };
      }),
      bills: snapshot.bills,
      followUpsAvailable: followUps !== null,
      reminders: settings
        ? { autoEnabled: settings.autoEnabled, mode: settings.mode, internalEmail: settings.internalEmail, webhookConfigured: readReminderWebhookEnv().status === "configured" }
        : null,
    }),
  );
});

const knownTenant = (tenantId: string) => ALL_TENANT_IDS.includes(tenantId.toLowerCase());

receivablesRouter.get("/receivables/:tenantId/:invoiceId/payment-link", async (req, res): Promise<void> => {
  const params = GetInvoicePaymentLinkParams.safeParse(req.params);
  if (!params.success || !knownTenant(params.data.tenantId)) {
    res.status(400).json({ error: "Unknown company or invoice." });
    return;
  }
  try {
    const response = await xeroGatewayRequest({ tenantId: params.data.tenantId, resource: "onlineInvoice", id: params.data.invoiceId });
    if (response.status === 400 && /Unknown resource/i.test(response.error ?? "")) {
      res.status(503).json({ error: "Import the updated n8n Xero gateway to get payment links." });
      return;
    }
    const url = str(asRecord(list(asRecord(response.data).OnlineInvoices)[0]).OnlineInvoiceUrl);
    if (!response.ok || !url) {
      res.status(response.status === 404 ? 404 : 502).json({ error: "Xero has no online invoice for this invoice." });
      return;
    }
    res.json({ url });
  } catch (error) {
    req.log.warn({ err: error }, "Xero online invoice link unavailable");
    res.status(502).json({ error: "Xero could not be reached." });
  }
});

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (value: string | null | undefined) => !value || (DAY.test(value) && !Number.isNaN(Date.parse(value)));

receivablesRouter.put("/receivables/:tenantId/:invoiceId/follow-up", async (req: Request, res: Response): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  const params = UpdateInvoiceFollowUpParams.safeParse(req.params);
  const body = UpdateInvoiceFollowUpBody.safeParse(req.body);
  if (!params.success || !knownTenant(params.data.tenantId) || !body.success || !validDay(body.data.nextChaseDate) || !validDay(body.data.promisedDate)) {
    res.status(400).json({ error: "Check the follow-up: choose an outcome, and dates must be valid (YYYY-MM-DD)." });
    return;
  }
  const data = body.data;
  const staff = res.locals.staff as { email?: string } | undefined;
  const tenantId = params.data.tenantId.toLowerCase();
  const invoiceId = params.data.invoiceId.toLowerCase();
  const { before, saved } = await recordFollowUp({
    tenantId,
    invoiceId,
    invoiceNumber: data.invoiceNumber ?? null,
    contactName: data.contactName ?? null,
    outcome: data.outcome,
    nextChaseDate: data.nextChaseDate ?? null,
    promisedDate: data.promisedDate ?? null,
    remindersPaused: data.remindersPaused,
    note: data.note?.trim() || null,
    author: staff?.email ?? null,
  });
  await audit(req, res, "invoice_follow_up.update", "xero_invoice_follow_ups", saved.id, before, { ...saved, note: data.note ?? null });
  const view = (await loadFollowUps([invoiceId]))?.get(`${tenantId}|${invoiceId}`);
  res.json(UpdateInvoiceFollowUpResponse.parse(view));
});

receivablesRouter.get("/reminders/settings", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  try {
    res.json(GetReminderSettingsResponse.parse(await settingsSummary(await getReminderSettings(ALL_TENANT_IDS))));
  } catch (error) {
    req.log.error({ err: error }, "Reminder settings could not be read");
    res.status(503).json({ error: "Reminder settings aren't set up yet: run the database push to create the tables." });
  }
});

receivablesRouter.put("/reminders/settings", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  const body = UpdateReminderSettingsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Check the reminder settings: stages are days overdue (1–365) and limits must be positive whole numbers." });
    return;
  }
  const patch = { ...body.data };
  if (patch.companies) patch.companies = patch.companies.map((id) => id.toLowerCase()).filter((id) => ALL_TENANT_IDS.includes(id));
  if (patch.stageDays) patch.stageDays = [...new Set(patch.stageDays)].sort((a, b) => a - b);
  if (patch.internalEmail !== undefined && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(patch.internalEmail.trim())) {
    res.status(400).json({ error: "Enter a valid internal email address." });
    return;
  }
  if (patch.internalEmail) patch.internalEmail = patch.internalEmail.trim();
  const staff = res.locals.staff as { email?: string } | undefined;
  const { before, after } = await saveReminderSettings(patch, staff?.email ?? null, ALL_TENANT_IDS);
  await audit(req, res, "reminder_settings.update", "xero_reminder_settings", after.id, before, after);
  res.json(GetReminderSettingsResponse.parse(await settingsSummary(after)));
});

receivablesRouter.post("/receivables/:tenantId/:invoiceId/actions", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  const params = RunInvoiceActionParams.safeParse(req.params);
  const body = RunInvoiceActionBody.safeParse(req.body);
  if (!params.success || !knownTenant(params.data.tenantId) || !body.success) {
    res.status(400).json({ error: "Unknown invoice or action." });
    return;
  }
  const staff = res.locals.staff as { email?: string } | undefined;
  const tenantId = params.data.tenantId.toLowerCase();
  const invoiceId = params.data.invoiceId.toLowerCase();
  const settings = await getReminderSettings(ALL_TENANT_IDS);
  const testMode = settings.mode === "test";
  const snapshot = await receivablesSnapshot(false, req.log);
  const invoice = snapshot.invoices.find((item) => item.tenantId === tenantId && item.invoiceId.toLowerCase() === invoiceId);
  if (!invoice) {
    res.status(400).json({ error: "This invoice is no longer open in Xero. Refresh the page." });
    return;
  }

  let item: Record<string, unknown>;
  if (body.data.action === "reminder") {
    const followUps = (await loadFollowUps([invoice.invoiceId])) ?? new Map();
    const activity = await activityFor([invoice]);
    const decision = (await reminderDecisions({ ...snapshot, invoices: [invoice] }, settings, followUps, activity)).get(`${tenantId}|${invoice.invoiceId}`)!;
    // A person can send the next stage at any time; after the last stage they repeat the final notice.
    const stage = Math.min(decision.lastStage + 1, settings.stageDays.length);
    item = await reminderItem(invoice, settings, stage, "manual_reminder", staff?.email ?? null);
  } else {
    if (testMode) {
      res.status(400).json({ error: "Switch reminders to live mode to re-send invoices or write notes in Xero; test mode never contacts Xero." });
      return;
    }
    const note = body.data.note?.trim();
    if (body.data.action === "xero_note" && !note) {
      res.status(400).json({ error: "Write the note to add to the invoice in Xero." });
      return;
    }
    item = {
      action: body.data.action,
      kind: body.data.action,
      tenantId,
      invoiceId: invoice.invoiceId,
      invoiceNumber: invoice.number ?? invoice.invoiceId,
      customer: invoice.contactName,
      note: note ?? null,
      testMode: false,
      requestedBy: staff?.email ?? null,
    };
  }

  let reported: unknown;
  try {
    reported = await runWorkflow([item]);
  } catch (error) {
    req.log.warn({ err: error, action: body.data.action }, "n8n reminders workflow call failed");
    res.status(502).json({ error: (error as Error).message });
    return;
  }
  await audit(req, res, `invoice_action.${body.data.action}`, "xero_invoice_reminders", invoice.invoiceId, null, { item, reported });
  // The workflow responds with what the result endpoint returned for this item.
  const result = asRecord(Array.isArray(reported) ? reported[0] : reported);
  res.json(
    RunInvoiceActionResponse.parse({
      status: ["sent", "failed", "skipped"].includes(String(result.status)) ? result.status : "sent",
      detail: str(result.detail) ?? (body.data.action === "reminder" ? `Stage ${item.stage} reminder sent.` : "Done."),
      sentTo: str(result.sentTo) ?? (typeof item.sendTo === "string" ? item.sendTo : null),
      testMode: body.data.action === "reminder" ? testMode : false,
    }),
  );
});

export { addDays };
export default receivablesRouter;
