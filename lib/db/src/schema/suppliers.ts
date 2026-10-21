import { sql } from "drizzle-orm";
import { boolean, index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { id, timestamps } from "./columns";

export const supplierKindEnum = pgEnum("supplier_kind", [
  "contractor",
  "cleaner",
  "utility",
  "retailer",
  "other",
]);

// Contractors, cleaners, utilities and retailers (Amazon, Argos, British Gas, Octopus ...).
export const suppliersTable = pgTable("suppliers", {
  id: id(),
  name: text("name").notNull().unique(),
  kind: supplierKindEnum("kind").notNull(),
  trade: text("trade"),
  email: text("email"),
  phone: text("phone"),
  // Sender domain used to recognise e-receipts during email ingestion.
  emailDomain: text("email_domain"),
  xeroContactId: text("xero_contact_id").unique(),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps,
}).enableRLS();

// Bank details are a fraud target: rows are never edited in place. A change
// inserts a new row, deactivates the old one, writes audit_log, and raises a
// bank_detail_change exception that a second person must verify before use.
export const supplierBankDetailsTable = pgTable(
  "supplier_bank_details",
  {
    id: id(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliersTable.id, { onDelete: "restrict" }),
    accountName: text("account_name").notNull(),
    sortCode: text("sort_code").notNull(),
    accountNumber: text("account_number").notNull(),
    isActive: boolean("is_active").notNull().default(false),
    submittedBy: text("submitted_by").notNull(),
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("supplier_bank_details_supplier_id_idx").on(t.supplierId),
    uniqueIndex("supplier_bank_details_one_active_uq")
      .on(t.supplierId)
      .where(sql`${t.isActive}`),
  ],
).enableRLS();

export const insertSupplierSchema = createInsertSchema(suppliersTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertSupplierBankDetailsSchema = createInsertSchema(supplierBankDetailsTable).omit({
  id: true,
  isActive: true,
  verifiedBy: true,
  verifiedAt: true,
  createdAt: true,
  updatedAt: true,
});

export type Supplier = typeof suppliersTable.$inferSelect;
export type InsertSupplier = z.infer<typeof insertSupplierSchema>;
export type SupplierBankDetails = typeof supplierBankDetailsTable.$inferSelect;
export type InsertSupplierBankDetails = z.infer<typeof insertSupplierBankDetailsSchema>;
