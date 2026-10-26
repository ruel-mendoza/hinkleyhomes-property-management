import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, numeric, pgEnum, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { id, money, timestamps } from "./columns";
import { contractorInvoicesTable } from "./maintenance";
import { entitiesTable, propertiesTable } from "./properties";
import { n8nIntakeWriterRole } from "./roles";
import { supplierBankDetailsTable, suppliersTable } from "./suppliers";

export const receiptSourceEnum = pgEnum("receipt_source", ["email", "whatsapp", "manual"]);

export const receiptStatusEnum = pgEnum("receipt_status", [
  "pending",
  "matched",
  "exception",
  "posted",
  "rejected",
]);

// Supplier / utility e-receipts parsed by n8n (IMAP + LLM) or the WhatsApp bot.
export const supplierReceiptsTable = pgTable(
  "supplier_receipts",
  {
    id: id(),
    source: receiptSourceEnum("source").notNull(),
    // IMAP Message-ID or WhatsApp message id; makes webhook retries idempotent.
    sourceMessageId: text("source_message_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    supplierId: uuid("supplier_id").references(() => suppliersTable.id, { onDelete: "set null" }),
    supplierNameRaw: text("supplier_name_raw"),
    propertyId: uuid("property_id").references(() => propertiesTable.id, { onDelete: "set null" }),
    propertyTextRaw: text("property_text_raw"),
    receiptDate: date("receipt_date"),
    netAmount: money("net_amount"),
    vatAmount: money("vat_amount"),
    grossAmount: money("gross_amount"),
    currency: text("currency").notNull().default("GBP"),
    parsed: jsonb("parsed"),
    parseConfidence: numeric("parse_confidence", { precision: 4, scale: 3 }),
    status: receiptStatusEnum("status").notNull().default("pending"),
    xeroBillId: text("xero_bill_id").unique(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("supplier_receipts_source_message_uq").on(t.source, t.sourceMessageId),
    index("supplier_receipts_status_idx").on(t.status),
    index("supplier_receipts_supplier_id_idx").on(t.supplierId),
    index("supplier_receipts_property_id_idx").on(t.propertyId),
  ],
).enableRLS();

export const paymentBatchStatusEnum = pgEnum("payment_batch_status", [
  "draft",
  "previewed",
  "approved",
  "sent_to_xero",
  "cancelled",
]);

// Supplier payment runs. Previews and approvals are audit-logged; the actual
// payment happens in Xero.
export const paymentBatchesTable = pgTable("payment_batches", {
  id: id(),
  entityId: uuid("entity_id")
    .notNull()
    .references(() => entitiesTable.id, { onDelete: "restrict" }),
  status: paymentBatchStatusEnum("status").notNull().default("draft"),
  paymentDate: date("payment_date"),
  totalAmount: money("total_amount").notNull().default("0"),
  createdBy: text("created_by").notNull(),
  previewedAt: timestamp("previewed_at", { withTimezone: true }),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  xeroBatchPaymentId: text("xero_batch_payment_id").unique(),
  ...timestamps,
},
  (t) => [index("payment_batches_entity_id_idx").on(t.entityId)],
).enableRLS();

export const paymentBatchItemsTable = pgTable(
  "payment_batch_items",
  {
    id: id(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => paymentBatchesTable.id, { onDelete: "cascade" }),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliersTable.id, { onDelete: "restrict" }),
    // The exact bank details shown in the preview, so a later change can't
    // silently redirect an approved payment.
    bankDetailsId: uuid("bank_details_id")
      .notNull()
      .references(() => supplierBankDetailsTable.id, { onDelete: "restrict" }),
    contractorInvoiceId: uuid("contractor_invoice_id").references(() => contractorInvoicesTable.id, { onDelete: "restrict" }),
    supplierReceiptId: uuid("supplier_receipt_id").references(() => supplierReceiptsTable.id, { onDelete: "restrict" }),
    amount: money("amount").notNull(),
    ...timestamps,
  },
  (t) => [
    index("payment_batch_items_batch_id_idx").on(t.batchId),
    index("payment_batch_items_supplier_id_idx").on(t.supplierId),
    index("payment_batch_items_bank_details_id_idx").on(t.bankDetailsId),
    index("payment_batch_items_invoice_id_idx").on(t.contractorInvoiceId),
    index("payment_batch_items_receipt_id_idx").on(t.supplierReceiptId),
    check(
      "payment_batch_items_one_source_chk",
      sql`num_nonnulls(${t.contractorInvoiceId}, ${t.supplierReceiptId}) = 1`,
    ),
  ],
).enableRLS();

export const insertSupplierReceiptSchema = createInsertSchema(supplierReceiptsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPaymentBatchSchema = createInsertSchema(paymentBatchesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPaymentBatchItemSchema = createInsertSchema(paymentBatchItemsTable).omit({ id: true, createdAt: true, updatedAt: true });

export type SupplierReceipt = typeof supplierReceiptsTable.$inferSelect;
export type InsertSupplierReceipt = z.infer<typeof insertSupplierReceiptSchema>;
export type PaymentBatch = typeof paymentBatchesTable.$inferSelect;
export type InsertPaymentBatch = z.infer<typeof insertPaymentBatchSchema>;
export type PaymentBatchItem = typeof paymentBatchItemsTable.$inferSelect;
export type InsertPaymentBatchItem = z.infer<typeof insertPaymentBatchItemSchema>;

// --- Receivables follow-up (Xero sales invoices) ------------------------------
// Xero holds the invoices; these tables only hold our chasing: the current state
// per invoice and an append-only log of what was done. Nothing here is sent to Xero.

export const invoiceFollowUpOutcomeEnum = pgEnum("invoice_follow_up_outcome", [
  "not_contacted",
  "chased",
  "promised",
  "disputed",
  "paid_elsewhere",
  "write_off_review",
]);

export const xeroInvoiceFollowUpsTable = pgTable(
  "xero_invoice_follow_ups",
  {
    id: id(),
    xeroTenantId: text("xero_tenant_id").notNull(),
    xeroInvoiceId: uuid("xero_invoice_id").notNull(),
    invoiceNumber: text("invoice_number"),
    contactName: text("contact_name"),
    outcome: invoiceFollowUpOutcomeEnum("outcome").notNull().default("not_contacted"),
    nextChaseDate: date("next_chase_date"),
    promisedDate: date("promised_date"),
    // Stops automatic reminders for this invoice (set by staff on the Invoices page).
    remindersPaused: boolean("reminders_paused").notNull().default(false),
    updatedBy: text("updated_by"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("xero_invoice_follow_ups_invoice_idx").on(t.xeroTenantId, t.xeroInvoiceId),
    index("xero_invoice_follow_ups_next_chase_idx").on(t.nextChaseDate),
  ],
).enableRLS();

export const xeroInvoiceFollowUpNotesTable = pgTable(
  "xero_invoice_follow_up_notes",
  {
    id: id(),
    followUpId: uuid("follow_up_id")
      .notNull()
      .references(() => xeroInvoiceFollowUpsTable.id, { onDelete: "cascade" }),
    outcome: invoiceFollowUpOutcomeEnum("outcome").notNull(),
    note: text("note"),
    authorEmail: text("author_email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("xero_invoice_follow_up_notes_follow_up_idx").on(t.followUpId, t.createdAt)],
).enableRLS();

export type XeroInvoiceFollowUp = typeof xeroInvoiceFollowUpsTable.$inferSelect;
export type XeroInvoiceFollowUpNote = typeof xeroInvoiceFollowUpNotesTable.$inferSelect;

// --- Payment reminders (Phase 2) -----------------------------------------------
// The app decides who gets a reminder; the n8n workflow "Xero overdue reminders"
// writes and sends it (Outlook) and reports back. One settings row, id "default".

export const reminderModeEnum = pgEnum("reminder_mode", ["test", "live"]);

export const xeroReminderSettingsTable = pgTable("xero_reminder_settings", {
  id: text("id").primaryKey(),
  // Master switch for the daily automatic reminders. Off by default.
  autoEnabled: boolean("auto_enabled").notNull().default(false),
  // Test: every reminder goes to internalEmail instead of the customer.
  mode: reminderModeEnum("mode").notNull().default("test"),
  internalEmail: text("internal_email").notNull().default("accounts@hinkleyhomes.co.uk"),
  // Days overdue at which stages 1..n become due; a reminder moves up one stage at a time.
  stageDays: integer("stage_days").array().notNull().default(sql`'{1,7,14,30}'::integer[]`),
  // Older invoices are left for a phone call rather than emailed automatically.
  maxOverdueDays: integer("max_overdue_days").notNull().default(60),
  minDaysBetween: integer("min_days_between").notNull().default(5),
  manualChaseCooldownDays: integer("manual_chase_cooldown_days").notNull().default(5),
  xeroReminderCooldownDays: integer("xero_reminder_cooldown_days").notNull().default(7),
  weekdaysOnly: boolean("weekdays_only").notNull().default(true),
  // Add a note to the invoice's History in Xero after each live reminder.
  xeroHistoryNotes: boolean("xero_history_notes").notNull().default(false),
  // Xero tenant ids whose customers may receive automatic reminders.
  companies: text("companies").array().notNull().default(sql`'{}'::text[]`),
  updatedBy: text("updated_by"),
  ...timestamps,
}).enableRLS();

export const reminderKindEnum = pgEnum("reminder_kind", ["auto_reminder", "manual_reminder", "xero_resend", "xero_note"]);
export const reminderStatusEnum = pgEnum("reminder_status", ["sent", "failed", "skipped"]);

export const xeroInvoiceRemindersTable = pgTable(
  "xero_invoice_reminders",
  {
    id: id(),
    xeroTenantId: text("xero_tenant_id").notNull(),
    xeroInvoiceId: uuid("xero_invoice_id").notNull(),
    invoiceNumber: text("invoice_number"),
    contactName: text("contact_name"),
    kind: reminderKindEnum("kind").notNull(),
    stage: integer("stage"),
    testMode: boolean("test_mode").notNull(),
    sentTo: text("sent_to"),
    status: reminderStatusEnum("status").notNull(),
    detail: text("detail"),
    requestedBy: text("requested_by"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("xero_invoice_reminders_invoice_idx").on(t.xeroTenantId, t.xeroInvoiceId, t.sentAt)],
).enableRLS();

export type XeroReminderSettings = typeof xeroReminderSettingsTable.$inferSelect;
export type XeroInvoiceReminder = typeof xeroInvoiceRemindersTable.$inferSelect;

// --- Supplier bill checks (n8n "Xero watcher") ---------------------------------
// One row per Xero bill (fetched daily by the app, or sent by an n8n watcher):
// the history later bills and monthly spend are compared with. Amounts are net
// of VAT; unitPrice is per unit. Bank details seen on bills go to
// supplier_bank_details, and flags to exception_queue.

export type BillHistoryLine = { key: string; unitPrice: number | null; accountCode: string | null; net: number };

export const xeroBillHistoryTable = pgTable(
  "xero_bill_history",
  {
    id: id(),
    xeroTenantId: text("xero_tenant_id").notNull(),
    xeroBillId: uuid("xero_bill_id").notNull(),
    company: text("company").notNull(),
    supplierName: text("supplier_name").notNull(),
    supplierKey: text("supplier_key").notNull(),
    billNumber: text("bill_number"),
    billDate: date("bill_date"),
    total: money("total"),
    subTotal: money("sub_total"),
    currency: text("currency").notNull().default("GBP"),
    status: text("status").notNull(),
    lines: jsonb("lines").$type<BillHistoryLine[]>().notNull().default([]),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("xero_bill_history_bill_idx").on(t.xeroTenantId, t.xeroBillId),
    index("xero_bill_history_supplier_idx").on(t.supplierKey, t.billDate),
    index("xero_bill_history_date_idx").on(t.billDate),
  ],
).enableRLS();

export type XeroBillHistory = typeof xeroBillHistoryTable.$inferSelect;

// --- Overdue tracking (daily checks) -------------------------------------------
// One row per overdue Xero invoice or bill, so the Finance checks page can say
// what is new, what got more urgent and what is still unpaid since it was first
// seen. clearedOn is set when it is no longer overdue (paid, credited, voided).

export const overdueLedgerEnum = pgEnum("overdue_ledger", ["receivable", "payable"]);

export const xeroOverdueTrackingTable = pgTable(
  "xero_overdue_tracking",
  {
    id: id(),
    xeroTenantId: text("xero_tenant_id").notNull(),
    xeroInvoiceId: uuid("xero_invoice_id").notNull(),
    ledger: overdueLedgerEnum("ledger").notNull(),
    invoiceNumber: text("invoice_number"),
    contactName: text("contact_name"),
    amountDue: money("amount_due").notNull(),
    firstSeenOn: date("first_seen_on").notNull(),
    lastSeenOn: date("last_seen_on").notNull(),
    // 1 = act now, 2 = chase this week, 3 = monitor.
    priority: integer("priority").notNull(),
    previousPriority: integer("previous_priority"),
    clearedOn: date("cleared_on"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("xero_overdue_tracking_invoice_idx").on(t.xeroTenantId, t.xeroInvoiceId),
    index("xero_overdue_tracking_cleared_idx").on(t.clearedOn),
  ],
).enableRLS();

export type XeroOverdueTracking = typeof xeroOverdueTrackingTable.$inferSelect;

// --- Bill coding (n8n "Route A: Xero-first") ------------------------------------
// The app picks the draft and submitted supplier bills to check, applies the
// property rules and decides what to write to Xero; n8n downloads each bill's
// file, reads it with the AI, writes the draft bills and reports back.

export const billReviewStatusEnum = pgEnum("bill_review_status", [
  "held",
  "shadow_planned",
  "pending_xero",
  "created_draft",
  "updated_draft",
  "create_failed",
  "not_invoice",
  "read_failed",
]);

// One row per bill per run (the latest row is the bill's current state).
export const billCodingReviewsTable = pgTable(
  "bill_coding_reviews",
  {
    id: id(),
    // xero::<tenant id>::<bill id>
    idempotencyKey: text("idempotency_key").notNull(),
    xeroTenantId: text("xero_tenant_id").notNull(),
    xeroBillId: uuid("xero_bill_id").notNull(),
    company: text("company").notNull(),
    status: billReviewStatusEnum("status").notNull(),
    fingerprint: text("fingerprint"),
    supplierName: text("supplier_name"),
    invoiceNumber: text("invoice_number"),
    invoiceDate: date("invoice_date"),
    currency: text("currency"),
    total: money("total"),
    documentType: text("document_type"),
    legibility: numeric("legibility", { precision: 4, scale: 3 }),
    sourceType: text("source_type"),
    filename: text("filename"),
    docHash: text("doc_hash"),
    provider: text("provider"),
    model: text("model"),
    extractionError: text("extraction_error"),
    shadowMode: boolean("shadow_mode").notNull(),
    // Hold reasons and other flags: { code, severity, message }.
    reasons: jsonb("reasons").$type<Record<string, unknown>[]>().notNull().default([]),
    // Lines that need a property: description, amount, answerKey, suggestions.
    needs: jsonb("needs").$type<Record<string, unknown>[]>().notNull().default([]),
    allocation: jsonb("allocation").$type<Record<string, unknown>[]>().notNull().default([]),
    // Planned Xero writes (one per company) and what n8n reported for each.
    plans: jsonb("plans").$type<Record<string, unknown>[]>().notNull().default([]),
    xeroInvoiceIds: text("xero_invoice_ids").array().notNull().default(sql`'{}'::text[]`),
    error: text("error"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    answeredBy: text("answered_by"),
    ...timestamps,
  },
  (t) => [
    index("bill_coding_reviews_bill_idx").on(t.xeroTenantId, t.xeroBillId, t.createdAt),
    index("bill_coding_reviews_fingerprint_idx").on(t.fingerprint),
    index("bill_coding_reviews_status_idx").on(t.status),
  ],
).enableRLS();

// Each document is read by the AI once: the reading is kept by file fingerprint.
// Shared with the n8n intake check, which looks readings up and adds its own.
export const documentReadingsTable = pgTable("document_readings", {
  docHash: text("doc_hash").primaryKey(),
  extraction: jsonb("extraction").$type<Record<string, unknown>>().notNull(),
  model: text("model"),
  provider: text("provider"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, () => [
  pgPolicy("document_readings_n8n_read", { for: "select", to: n8nIntakeWriterRole, using: sql`true` }),
  pgPolicy("document_readings_n8n_insert", { for: "insert", to: n8nIntakeWriterRole, withCheck: sql`true` }),
]).enableRLS();

// One settings row, id "default". Shadow mode on: nothing is written to Xero.
export const billCodingSettingsTable = pgTable("bill_coding_settings", {
  id: text("id").primaryKey(),
  shadowMode: boolean("shadow_mode").notNull().default(true),
  // Split a bill whose lines belong to several companies into draft bills in each.
  autoSplit: boolean("auto_split").notNull().default(false),
  maxBillsPerRun: integer("max_bills_per_run").notNull().default(10),
  checkStatuses: text("check_statuses").array().notNull().default(sql`'{DRAFT,SUBMITTED}'::text[]`),
  trackingCategory: text("tracking_category").notNull().default("Property"),
  payingCompanyName: text("paying_company_name").notNull().default("Hinkley Homes Ltd"),
  defaultAccountCode: text("default_account_code").notNull().default(""),
  // Line category (e.g. "Cleaning") -> Xero account code.
  categoryAccountMap: jsonb("category_account_map").$type<Record<string, string>>().notNull().default({}),
  legibilityMin: numeric("legibility_min", { precision: 3, scale: 2 }).notNull().default("0.80"),
  dateOutlierDays: integer("date_outlier_days").notNull().default(21),
  dupLineMinAmount: integer("dup_line_min_amount").notNull().default(100),
  // Check held bills again every run, not only after an answer or a Xero edit.
  reprocessHeld: boolean("reprocess_held").notNull().default(false),
  updatedBy: text("updated_by"),
  ...timestamps,
}).enableRLS();

export type BillCodingReview = typeof billCodingReviewsTable.$inferSelect;
export type BillCodingSettings = typeof billCodingSettingsTable.$inferSelect;

// --- Inbox intake check (n8n "Hinkley Intake check") ---------------------------
// Emails to accounts@ the intake check could not pass or bounce on its own
// (verdict "review"): a person looks at them on the Invoices page. One row per
// email; the supplier is never contacted from here. n8n inserts the rows
// itself (the app may be asleep) as n8n_intake_writer (see ./roles.ts).

// Every email the intake check looked at, with its verdict: the workflow skips
// emails already here and counts earlier bounce requests from it.
export const invoiceIntakeChecksTable = pgTable(
  "invoice_intake_checks",
  {
    id: id(),
    internetMessageId: text("internet_message_id").notNull(),
    outlookMessageId: text("outlook_message_id"),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
    senderEmail: text("sender_email"),
    subject: text("subject"),
    supplierName: text("supplier_name"),
    invoiceNumber: text("invoice_number"),
    invoiceDate: date("invoice_date"),
    totalGross: money("total_gross"),
    billTo: text("bill_to"),
    // pass | bounce | review | not_invoice
    verdict: text("verdict").notNull(),
    issueCodes: text("issue_codes"),
    // none | shadow_proposed | draft_created | bounce_sent
    action: text("action"),
    mode: text("mode"),
    bounceKey: text("bounce_key"),
    // { issues: [...per document], review: [...] }, as the workflow builds it.
    issues: jsonb("issues").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    uniqueIndex("invoice_intake_checks_message_uq").on(t.internetMessageId),
    index("invoice_intake_checks_action_idx").on(t.action, t.processedAt),
    pgPolicy("invoice_intake_checks_n8n_read", { for: "select", to: n8nIntakeWriterRole, using: sql`true` }),
    pgPolicy("invoice_intake_checks_n8n_insert", { for: "insert", to: n8nIntakeWriterRole, withCheck: sql`true` }),
  ],
).enableRLS();

export type InvoiceIntakeCheck = typeof invoiceIntakeChecksTable.$inferSelect;

// Where to open each checked invoice: the file the workflow saved to SharePoint
// (kind "file"), or the invoice link in the email when it came from Xero,
// QuickBooks and the like (kind "link"). Matched to the check by message id.
export const invoiceIntakeFilesTable = pgTable(
  "invoice_intake_files",
  {
    id: id(),
    internetMessageId: text("internet_message_id").notNull(),
    kind: text("kind").notNull(),
    name: text("name"),
    url: text("url").notNull(),
    driveItemId: text("drive_item_id"),
    mimeType: text("mime_type"),
    size: integer("size"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("invoice_intake_files_message_url_uq").on(t.internetMessageId, t.url),
    check("invoice_intake_files_kind_chk", sql`${t.kind} in ('file', 'link')`),
    pgPolicy("invoice_intake_files_n8n_insert", { for: "insert", to: n8nIntakeWriterRole, withCheck: sql`true` }),
  ],
).enableRLS();

export type InvoiceIntakeFile = typeof invoiceIntakeFilesTable.$inferSelect;

export const intakeReviewStatusEnum = pgEnum("intake_review_status", ["open", "done", "dismissed"]);

export const invoiceIntakeReviewsTable = pgTable(
  "invoice_intake_reviews",
  {
    id: id(),
    internetMessageId: text("internet_message_id").notNull(),
    outlookMessageId: text("outlook_message_id"),
    webLink: text("web_link"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    senderEmail: text("sender_email"),
    senderName: text("sender_name"),
    subject: text("subject"),
    supplierName: text("supplier_name"),
    invoiceNumber: text("invoice_number"),
    invoiceDate: date("invoice_date"),
    total: money("total"),
    currency: text("currency"),
    billTo: text("bill_to"),
    // The company the bill-to matched (Xero organisation name), if any.
    billToCompany: text("bill_to_company"),
    // Why a person must look: { code, message }.
    reasons: jsonb("reasons").$type<{ code: string; message: string }[]>().notNull().default([]),
    // What is missing on the invoice itself (would have been bounced): { code, message, lines? }.
    issues: jsonb("issues").$type<Record<string, unknown>[]>().notNull().default([]),
    status: intakeReviewStatusEnum("status").notNull().default("open"),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolution: text("resolution"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("invoice_intake_reviews_message_uq").on(t.internetMessageId),
    index("invoice_intake_reviews_status_idx").on(t.status, t.createdAt),
    // New open reviews only: n8n can't read, change or close existing ones.
    pgPolicy("invoice_intake_reviews_n8n_insert", {
      for: "insert",
      to: n8nIntakeWriterRole,
      withCheck: sql`${t.status} = 'open' and ${t.resolvedBy} is null and ${t.resolvedAt} is null`,
    }),
  ],
).enableRLS();

export type InvoiceIntakeReview = typeof invoiceIntakeReviewsTable.$inferSelect;
