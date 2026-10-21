import { sql } from "drizzle-orm";
import { check, date, index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { id, money, timestamps } from "./columns";
import { shortStayBookingsTable, tenanciesTable } from "./occupancy";
import { entitiesTable, propertiesTable, roomsTable } from "./properties";
import { suppliersTable } from "./suppliers";

export const maintenanceStatusEnum = pgEnum("maintenance_status", [
  "reported",
  "approved",
  "in_progress",
  "completed",
  "cancelled",
]);

// Local mirror of COHO maintenance issues, plus jobs raised outside COHO.
export const maintenanceJobsTable = pgTable(
  "maintenance_jobs",
  {
    id: id(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => propertiesTable.id, { onDelete: "restrict" }),
    roomId: uuid("room_id").references(() => roomsTable.id, { onDelete: "set null" }),
    cohoMaintenanceGuid: text("coho_maintenance_guid").unique(),
    title: text("title").notNull(),
    category: text("category"),
    severity: text("severity"),
    status: maintenanceStatusEnum("status").notNull().default("reported"),
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("maintenance_jobs_property_id_idx").on(t.propertyId),
    index("maintenance_jobs_room_id_idx").on(t.roomId),
  ],
).enableRLS();

export const chargeToEnum = pgEnum("charge_to", [
  "tenant",
  "guest",
  "landlord",
  "entity",
  "none",
]);

// A manager's sign-off on a contractor and a spend limit for a job.
export const maintenanceApprovalsTable = pgTable(
  "maintenance_approvals",
  {
    id: id(),
    maintenanceJobId: uuid("maintenance_job_id")
      .notNull()
      .references(() => maintenanceJobsTable.id, { onDelete: "cascade" }),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliersTable.id, { onDelete: "restrict" }),
    approvedAmount: money("approved_amount").notNull(),
    chargeTo: chargeToEnum("charge_to").notNull().default("entity"),
    approvedBy: text("approved_by").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [
    index("maintenance_approvals_job_id_idx").on(t.maintenanceJobId),
    index("maintenance_approvals_supplier_id_idx").on(t.supplierId),
  ],
).enableRLS();

export const invoiceMatchStatusEnum = pgEnum("invoice_match_status", [
  "unmatched",
  "matched",
  "variance",
  "rejected",
]);

// Contractor bills. The bill itself lives in Xero (xero_bill_id / xero_status);
// this row records which approval it was matched against.
export const contractorInvoicesTable = pgTable(
  "contractor_invoices",
  {
    id: id(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliersTable.id, { onDelete: "restrict" }),
    maintenanceJobId: uuid("maintenance_job_id").references(() => maintenanceJobsTable.id, { onDelete: "set null" }),
    approvalId: uuid("approval_id").references(() => maintenanceApprovalsTable.id, { onDelete: "set null" }),
    invoiceNumber: text("invoice_number").notNull(),
    invoiceDate: date("invoice_date").notNull(),
    netAmount: money("net_amount").notNull(),
    vatAmount: money("vat_amount").notNull().default("0"),
    grossAmount: money("gross_amount").notNull(),
    matchStatus: invoiceMatchStatusEnum("match_status").notNull().default("unmatched"),
    xeroBillId: text("xero_bill_id").unique(),
    xeroStatus: text("xero_status"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("contractor_invoices_supplier_number_uq").on(t.supplierId, t.invoiceNumber),
    index("contractor_invoices_job_id_idx").on(t.maintenanceJobId),
    index("contractor_invoices_approval_id_idx").on(t.approvalId),
    check("contractor_invoices_gross_chk", sql`${t.grossAmount} = ${t.netAmount} + ${t.vatAmount}`),
  ],
).enableRLS();

// Cleaning allowance earned by a short-stay changeover, calculated
// automatically and deducted before anything is on-charged.
export const cleaningAllowancesTable = pgTable("cleaning_allowances", {
  id: id(),
  bookingId: uuid("booking_id")
    .notNull()
    .unique()
    .references(() => shortStayBookingsTable.id, { onDelete: "cascade" }),
  amount: money("amount").notNull(),
  // Which rule produced the amount, e.g. "flat £35 per changeover".
  rule: text("rule").notNull(),
  calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull().defaultNow(),
  ...timestamps,
}).enableRLS();

export const onChargeStatusEnum = pgEnum("on_charge_status", [
  "draft",
  "approved",
  "posted",
  "void",
]);

// A cost passed on to whoever should bear it, after allowances.
export const onChargesTable = pgTable(
  "on_charges",
  {
    id: id(),
    contractorInvoiceId: uuid("contractor_invoice_id")
      .notNull()
      .references(() => contractorInvoicesTable.id, { onDelete: "restrict" }),
    chargeTo: chargeToEnum("charge_to").notNull(),
    tenancyId: uuid("tenancy_id").references(() => tenanciesTable.id, { onDelete: "restrict" }),
    bookingId: uuid("booking_id").references(() => shortStayBookingsTable.id, { onDelete: "restrict" }),
    entityId: uuid("entity_id").references(() => entitiesTable.id, { onDelete: "restrict" }),
    cleaningAllowanceId: uuid("cleaning_allowance_id").references(() => cleaningAllowancesTable.id, { onDelete: "restrict" }),
    grossAmount: money("gross_amount").notNull(),
    allowanceAmount: money("allowance_amount").notNull().default("0"),
    chargeAmount: money("charge_amount").notNull(),
    status: onChargeStatusEnum("status").notNull().default("draft"),
    xeroInvoiceId: text("xero_invoice_id").unique(),
    ...timestamps,
  },
  (t) => [
    index("on_charges_invoice_id_idx").on(t.contractorInvoiceId),
    index("on_charges_tenancy_id_idx").on(t.tenancyId),
    index("on_charges_booking_id_idx").on(t.bookingId),
    index("on_charges_entity_id_idx").on(t.entityId),
    index("on_charges_cleaning_allowance_id_idx").on(t.cleaningAllowanceId),
    check("on_charges_amount_chk", sql`${t.chargeAmount} = ${t.grossAmount} - ${t.allowanceAmount}`),
  ],
).enableRLS();

export const insertMaintenanceJobSchema = createInsertSchema(maintenanceJobsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertMaintenanceApprovalSchema = createInsertSchema(maintenanceApprovalsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertContractorInvoiceSchema = createInsertSchema(contractorInvoicesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertCleaningAllowanceSchema = createInsertSchema(cleaningAllowancesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertOnChargeSchema = createInsertSchema(onChargesTable).omit({ id: true, createdAt: true, updatedAt: true });

export type MaintenanceJob = typeof maintenanceJobsTable.$inferSelect;
export type InsertMaintenanceJob = z.infer<typeof insertMaintenanceJobSchema>;
export type MaintenanceApproval = typeof maintenanceApprovalsTable.$inferSelect;
export type InsertMaintenanceApproval = z.infer<typeof insertMaintenanceApprovalSchema>;
export type ContractorInvoice = typeof contractorInvoicesTable.$inferSelect;
export type InsertContractorInvoice = z.infer<typeof insertContractorInvoiceSchema>;
export type CleaningAllowance = typeof cleaningAllowancesTable.$inferSelect;
export type InsertCleaningAllowance = z.infer<typeof insertCleaningAllowanceSchema>;
export type OnCharge = typeof onChargesTable.$inferSelect;
export type InsertOnCharge = z.infer<typeof insertOnChargeSchema>;
