import { bigserial, boolean, date, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { id, timestamps } from "./columns";
import { entitiesTable, propertiesTable } from "./properties";

export const exceptionKindEnum = pgEnum("exception_kind", [
  "unmatched_address",
  "unmatched_receipt",
  "invoice_variance",
  "duplicate",
  "bank_detail_change",
  "sync_error",
]);

export const exceptionStatusEnum = pgEnum("exception_status", ["open", "resolved", "ignored"]);

// Anything reconciliation couldn't settle automatically, waiting for a person.
export const exceptionQueueTable = pgTable(
  "exception_queue",
  {
    id: id(),
    kind: exceptionKindEnum("kind").notNull(),
    status: exceptionStatusEnum("status").notNull().default("open"),
    sourceTable: text("source_table").notNull(),
    sourceId: text("source_id").notNull(),
    summary: text("summary").notNull(),
    details: jsonb("details"),
    assignedTo: text("assigned_to"),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolution: text("resolution"),
    ...timestamps,
  },
  (t) => [
    index("exception_queue_status_kind_idx").on(t.status, t.kind),
    index("exception_queue_source_idx").on(t.sourceTable, t.sourceId),
  ],
).enableRLS();

// Append-only. Application code only inserts; never update or delete rows.
export const auditLogTable = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actorEmail: text("actor_email"),
    actorUserId: text("actor_user_id"),
    action: text("action").notNull(),
    tableName: text("table_name").notNull(),
    recordId: text("record_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    requestId: text("request_id"),
    ipAddress: text("ip_address"),
  },
  (t) => [
    index("audit_log_record_idx").on(t.tableName, t.recordId),
    index("audit_log_occurred_at_idx").on(t.occurredAt),
  ],
).enableRLS();

export const integrationEnum = pgEnum("integration", [
  "coho",
  "smoobu",
  "charge_automation",
  "xero",
  "n8n",
  "whatsapp",
]);

export const syncStatusEnum = pgEnum("sync_status", ["running", "succeeded", "failed"]);

// One row per sync job or inbound webhook batch, for troubleshooting.
export const integrationSyncRunsTable = pgTable(
  "integration_sync_runs",
  {
    id: id(),
    integration: integrationEnum("integration").notNull(),
    trigger: text("trigger").notNull(),
    status: syncStatusEnum("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    recordsProcessed: integer("records_processed").notNull().default(0),
    error: text("error"),
    // What the run found (e.g. the Xero daily checks' counts), for the page that shows runs.
    details: jsonb("details"),
  },
  (t) => [index("integration_sync_runs_integration_idx").on(t.integration, t.startedAt)],
).enableRLS();

export const reportStatusEnum = pgEnum("report_status", ["generating", "ready", "failed"]);

// Generated client management reports.
export const clientReportsTable = pgTable("client_reports", {
  id: id(),
  entityId: uuid("entity_id").references(() => entitiesTable.id, { onDelete: "restrict" }),
  propertyId: uuid("property_id").references(() => propertiesTable.id, { onDelete: "restrict" }),
  reportType: text("report_type").notNull(),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  status: reportStatusEnum("status").notNull().default("generating"),
  generatedBy: text("generated_by").notNull(),
  // Path in Supabase Storage once the file is rendered.
  storagePath: text("storage_path"),
  data: jsonb("data"),
  ...timestamps,
},
  (t) => [
    index("client_reports_entity_id_idx").on(t.entityId),
    index("client_reports_property_id_idx").on(t.propertyId),
  ],
).enableRLS();

export const insertExceptionSchema = createInsertSchema(exceptionQueueTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertAuditLogSchema = createInsertSchema(auditLogTable).omit({ id: true, occurredAt: true });
export const insertClientReportSchema = createInsertSchema(clientReportsTable).omit({ id: true, createdAt: true, updatedAt: true });

export type ExceptionItem = typeof exceptionQueueTable.$inferSelect;
export type InsertException = z.infer<typeof insertExceptionSchema>;
export type AuditLogEntry = typeof auditLogTable.$inferSelect;
export type InsertAuditLogEntry = z.infer<typeof insertAuditLogSchema>;
export type IntegrationSyncRun = typeof integrationSyncRunsTable.$inferSelect;
export type ClientReport = typeof clientReportsTable.$inferSelect;
export type InsertClientReport = z.infer<typeof insertClientReportSchema>;

// Who is using the app: one row per signed-in staff member, refreshed by a
// heartbeat from the browser about once a minute while the app is open.
export const staffPresenceTable = pgTable(
  "staff_presence",
  {
    userId: text("user_id").primaryKey(),
    email: text("email"),
    displayName: text("display_name"),
    // Page name only (e.g. "Invoices"); never the address bar's search or filters.
    currentPage: text("current_page"),
    tabVisible: boolean("tab_visible").notNull().default(true),
    sessionStartedAt: timestamp("session_started_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("staff_presence_last_seen_idx").on(t.lastSeenAt)],
).enableRLS();

export type StaffPresence = typeof staffPresenceTable.$inferSelect;
