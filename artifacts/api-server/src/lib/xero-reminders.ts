import { and, desc, eq, inArray } from "drizzle-orm";
import {
  getDb,
  xeroInvoiceRemindersTable,
  xeroReminderSettingsTable,
  type XeroInvoiceReminder,
  type XeroReminderSettings,
} from "@workspace/db";
import { parseXeroDate, xeroGatewayRequest } from "./xero-gateway";

// Payment reminders (Phase 2). The app decides whether an overdue sales invoice
// should get a reminder and which stage; the n8n workflow "Xero overdue
// reminders" writes the email, sends it through Outlook and reports back.
// Reminders move up one stage at a time, so a customer's first email is always
// the friendly one, and they stop for anything staff have paused, disputed or
// recently chased, or that Xero itself has just reminded.

type RecordValue = Record<string, unknown>;
const asRecord = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
const list = (value: unknown): RecordValue[] => (Array.isArray(value) ? value.map(asRecord) : []);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

export const ukToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
const dayOf = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(date);
const pretty = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

// Notes written by the workflow carry this author, so they don't count as a staff chase.
export const AUTOMATIC_AUTHOR = "n8n (automatic reminder)";
const SETTINGS_ID = "default";

// --- Settings ---------------------------------------------------------------------

export async function getReminderSettings(allTenantIds: string[]): Promise<XeroReminderSettings> {
  const db = getDb();
  const [row] = await db.select().from(xeroReminderSettingsTable).where(eq(xeroReminderSettingsTable.id, SETTINGS_ID)).limit(1);
  if (row) return row;
  // First use: automatic reminders off, test mode, every company ticked.
  const [created] = await db
    .insert(xeroReminderSettingsTable)
    .values({ id: SETTINGS_ID, companies: allTenantIds })
    .onConflictDoNothing()
    .returning();
  return created ?? (await db.select().from(xeroReminderSettingsTable).where(eq(xeroReminderSettingsTable.id, SETTINGS_ID)).limit(1))[0];
}

export type ReminderSettingsPatch = Partial<
  Pick<XeroReminderSettings, "autoEnabled" | "mode" | "internalEmail" | "stageDays" | "maxOverdueDays" | "minDaysBetween" | "manualChaseCooldownDays" | "xeroReminderCooldownDays" | "weekdaysOnly" | "xeroHistoryNotes" | "companies">
>;

export async function saveReminderSettings(patch: ReminderSettingsPatch, updatedBy: string | null, allTenantIds: string[]) {
  const before = await getReminderSettings(allTenantIds);
  const [after] = await getDb()
    .update(xeroReminderSettingsTable)
    .set({ ...patch, updatedBy })
    .where(eq(xeroReminderSettingsTable.id, SETTINGS_ID))
    .returning();
  return { before, after };
}

// --- Xero activity (history) --------------------------------------------------------

export type XeroActivity = {
  sentOn: string | null;
  reminderDates: string[];
  // Latest "reminders turned off/on" change in the invoice's History: true = off. Null if never changed.
  remindersOff: boolean | null;
  // Name of the contact's Xero group that opts it out of reminders (e.g. "No reminders").
  optedOutGroup: string | null;
  recent: { date: string; change: string; details: string | null }[];
};
const HISTORY_CACHE_MS = 30 * 60_000;
const historyCache = new Map<string, { at: number; value: XeroActivity | null }>();

// Reads the invoice's History & notes. Entries mentioning reminders are split into
// "turned off"/"turned on" switches (Xero's per-invoice Reminders setting isn't in
// its API, but changing it is recorded here) and reminders sent; other "sent" or
// "emailed" entries are invoice sends. Null if the gateway can't read history.
const REMINDER = /remind/i;
const SWITCHED_OFF = /(turned off|switched off|disabled|stopped|paused|\boff\b)/i;
const SWITCHED_ON = /(turned on|switched on|enabled|resumed|\bon\b)/i;
export async function xeroActivity(tenantId: string, invoiceId: string): Promise<XeroActivity | null> {
  const key = `${tenantId}|${invoiceId}`;
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.at < HISTORY_CACHE_MS) return hit.value;
  let value: XeroActivity | null = null;
  try {
    const response = await xeroGatewayRequest({ tenantId, resource: "invoiceHistory", id: invoiceId });
    if (response.ok) {
      const records = list(asRecord(response.data).HistoryRecords)
        .map((record) => {
          const when = parseXeroDate(record.DateUTC ?? record.DateUTCString);
          return { date: when ? dayOf(when) : "", change: str(record.Changes) ?? "", details: str(record.Details) };
        })
        .filter((record) => record.date)
        .sort((a, b) => b.date.localeCompare(a.date));
      const text = (record: { change: string; details: string | null }) => `${record.change} ${record.details ?? ""}`;
      const switches = records.filter((record) => REMINDER.test(text(record)) && !/\b(sent|emailed)\b/i.test(text(record)) && (SWITCHED_OFF.test(text(record)) || SWITCHED_ON.test(text(record))));
      const reminders = records.filter((record) => REMINDER.test(text(record)) && !switches.includes(record));
      // "Invoice Unsent" / "unmarked as sent" entries are not sends.
      const sends = records.filter((record) => !REMINDER.test(text(record)) && !/unsent|unmarked as sent/i.test(text(record)) && /\b(sent|emailed)\b/i.test(text(record)));
      value = {
        sentOn: sends.length ? sends[sends.length - 1].date : null,
        reminderDates: reminders.map((record) => record.date),
        remindersOff: switches.length ? SWITCHED_OFF.test(text(switches[0])) : null,
        optedOutGroup: null,
        recent: records.slice(0, 6),
      };
    }
  } catch {
    value = null;
  }
  historyCache.set(key, { at: Date.now(), value });
  return value;
}

export async function xeroRemindersSwitchedOn(tenantId: string): Promise<boolean | null> {
  try {
    const response = await xeroGatewayRequest({ tenantId, resource: "invoiceReminderSettings" });
    if (!response.ok) return null;
    const enabled = asRecord(list(asRecord(response.data).InvoiceReminders)[0] ?? response.data).Enabled;
    return typeof enabled === "boolean" ? enabled : null;
  } catch {
    return null;
  }
}

// --- Contacts ---------------------------------------------------------------------

// A Xero contact group whose name contains "no reminder(s)" opts the contact out.
const OPT_OUT_GROUP = /no[\s-]*reminders?/i;
type ContactInfo = { at: number; email: string | null; firstName: string | null; optedOutGroup: string | null };
const contactCache = new Map<string, ContactInfo>();
export async function contactEmail(tenantId: string, contactId: string): Promise<ContactInfo> {
  const key = `${tenantId}|${contactId}`;
  const hit = contactCache.get(key);
  if (hit && Date.now() - hit.at < HISTORY_CACHE_MS) return hit;
  const response = await xeroGatewayRequest({ tenantId, resource: "contacts", id: contactId });
  const contact = asRecord(list(asRecord(response.data).Contacts)[0]);
  const person = list(contact.ContactPersons).find((item) => item.IncludeInEmails === true && str(item.EmailAddress)) ?? {};
  const value = {
    at: Date.now(),
    email: str(contact.EmailAddress) ?? str(person.EmailAddress),
    firstName: str(contact.FirstName) ?? str(person.FirstName),
    optedOutGroup: list(contact.ContactGroups).map((group) => str(group.Name)).find((name) => name && OPT_OUT_GROUP.test(name)) ?? null,
  };
  contactCache.set(key, value);
  return value;
}

// --- Reminder log ---------------------------------------------------------------------

export async function remindersFor(invoiceIds: string[]): Promise<Map<string, XeroInvoiceReminder[]>> {
  if (!invoiceIds.length) return new Map();
  const rows = await getDb()
    .select()
    .from(xeroInvoiceRemindersTable)
    .where(inArray(xeroInvoiceRemindersTable.xeroInvoiceId, invoiceIds))
    .orderBy(desc(xeroInvoiceRemindersTable.sentAt));
  const byInvoice = new Map<string, XeroInvoiceReminder[]>();
  for (const row of rows) {
    const key = `${row.xeroTenantId}|${row.xeroInvoiceId}`;
    byInvoice.set(key, [...(byInvoice.get(key) ?? []), row]);
  }
  return byInvoice;
}

export async function logReminder(entry: typeof xeroInvoiceRemindersTable.$inferInsert) {
  const [row] = await getDb().insert(xeroInvoiceRemindersTable).values(entry).returning();
  return row;
}

export async function lastReminder(tenantId: string, invoiceId: string) {
  const [row] = await getDb()
    .select()
    .from(xeroInvoiceRemindersTable)
    .where(and(eq(xeroInvoiceRemindersTable.xeroTenantId, tenantId), eq(xeroInvoiceRemindersTable.xeroInvoiceId, invoiceId)))
    .orderBy(desc(xeroInvoiceRemindersTable.sentAt))
    .limit(1);
  return row ?? null;
}

// --- Decision ---------------------------------------------------------------------------

export type InvoiceForReminder = {
  tenantId: string;
  invoiceId: string;
  daysOverdue: number;
  dueDate: string | null;
};
export type FollowUpForReminder = {
  outcome: string;
  promisedDate: string | null;
  remindersPaused: boolean;
  notes: { outcome: string; authorEmail: string | null; createdAt: string }[];
} | null;

export type ReminderDecision = {
  lastStage: number;
  lastSentAt: string | null;
  lastTestMode: boolean | null;
  sentCount: number;
  nextStage: number | null;
  eligible: boolean;
  reason: string;
};

export function decideReminder(
  invoice: InvoiceForReminder,
  settings: XeroReminderSettings,
  followUp: FollowUpForReminder,
  log: XeroInvoiceReminder[],
  activity: XeroActivity | null,
  today = ukToday(),
): ReminderDecision {
  const stages = [...settings.stageDays].sort((a, b) => a - b);
  const testMode = settings.mode === "test";
  // Stages restart when switching from test to live, so live customers still start at stage 1.
  const reminders = log.filter((row) => (row.kind === "auto_reminder" || row.kind === "manual_reminder") && row.status === "sent" && row.testMode === testMode);
  const lastStage = reminders.reduce((max, row) => Math.max(max, row.stage ?? 0), 0);
  const last = reminders[0] ?? null;
  const lastSentAt = last ? dayOf(last.sentAt) : null;
  const base = { lastStage, lastSentAt, lastTestMode: last ? last.testMode : null, sentCount: reminders.length };
  const blocked = (reason: string, nextStage: number | null = null): ReminderDecision => ({ ...base, nextStage, eligible: false, reason });

  if (invoice.daysOverdue < 1) return blocked("Not overdue yet");
  const nextStage = lastStage + 1;
  if (nextStage > stages.length) return blocked(`All ${stages.length} reminders sent; call the customer`);
  if (!settings.companies.includes(invoice.tenantId)) return blocked("Reminders are off for this company", nextStage);
  if (followUp?.remindersPaused) return blocked("Reminders paused by staff", nextStage);
  if (followUp && ["disputed", "write_off_review", "paid_elsewhere"].includes(followUp.outcome)) {
    return blocked(followUp.outcome === "disputed" ? "Marked disputed" : followUp.outcome === "paid_elsewhere" ? "Customer says it's paid" : "Under write-off review", nextStage);
  }
  if (followUp?.outcome === "promised" && followUp.promisedDate && followUp.promisedDate >= today) {
    return blocked(`Payment promised for ${pretty(followUp.promisedDate)}`, nextStage);
  }
  if (lastStage === 0 && invoice.daysOverdue > settings.maxOverdueDays) {
    return blocked(`Over ${settings.maxOverdueDays} days overdue; chase by phone`, nextStage);
  }
  const stageDay = stages[nextStage - 1];
  if (invoice.daysOverdue < stageDay) {
    const due = invoice.dueDate ? pretty(addDays(invoice.dueDate, stageDay)) : `${stageDay} days overdue`;
    return blocked(`Stage ${nextStage} due ${due}`, nextStage);
  }
  if (lastSentAt && daysBetween(lastSentAt, today) < settings.minDaysBetween) {
    return blocked(`Last reminder ${pretty(lastSentAt)}; next after ${pretty(addDays(lastSentAt, settings.minDaysBetween))}`, nextStage);
  }
  const staffChase = followUp?.notes.find((note) => note.outcome === "chased" && note.authorEmail !== AUTOMATIC_AUTHOR && daysBetween(dayOf(new Date(note.createdAt)), today) < settings.manualChaseCooldownDays);
  if (staffChase) return blocked(`Chased by staff on ${pretty(dayOf(new Date(staffChase.createdAt)))}`, nextStage);
  if (activity?.remindersOff) return blocked("Reminders turned off in Xero", nextStage);
  if (activity?.optedOutGroup) return blocked(`Contact is in the Xero group "${activity.optedOutGroup}"`, nextStage);
  const xeroReminder = activity?.reminderDates.find((date) => daysBetween(date, today) < settings.xeroReminderCooldownDays);
  if (xeroReminder) return blocked(`Xero sent a reminder on ${pretty(xeroReminder)}`, nextStage);
  return { ...base, nextStage, eligible: true, reason: `Stage ${nextStage} reminder due` };
}

export const isWeekend = (date = new Date()) => {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short" }).format(date);
  return day === "Sat" || day === "Sun";
};
