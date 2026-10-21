import { sql } from "drizzle-orm";
import { check, date, index, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
}).enableRLS();

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
