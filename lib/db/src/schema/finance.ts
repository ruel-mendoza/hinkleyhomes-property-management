import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { id, money, timestamps } from "./columns";
import { contractorInvoicesTable } from "./maintenance";
import { entitiesTable, propertiesTable } from "./properties";
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
