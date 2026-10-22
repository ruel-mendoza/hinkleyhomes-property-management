import { boolean, date, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { id, money, timestamps } from "./columns";

// The six action tabs COHO shows (Property, Tenancy, Maintenance, Onboarding, Viewing, Other).
export const cohoActionCategoryEnum = pgEnum("coho_action_category", [
  "property",
  "tenancy",
  "maintenance",
  "onboarding",
  "viewing",
  "other",
]);

export const cohoActionStatusEnum = pgEnum("coho_action_status", [
  "not_set",
  "new",
  "in_progress",
  "on_hold",
  "completed",
]);

// Local mirror of every COHO action (GET /v1.1/public/actions), kept current by
// the actions sync. COHO stays the source of truth; rows are upserted by reference.
export const cohoActionsTable = pgTable(
  "coho_actions",
  {
    id: id(),
    reference: text("reference").notNull().unique(),
    title: text("title"),
    message: text("message"),
    notes: text("notes"),
    status: cohoActionStatusEnum("status").notNull(),
    type: text("type").notNull(),
    typeName: text("type_name"),
    category: cohoActionCategoryEnum("category").notNull(),
    // True when the category came from COHO's own overview rather than being
    // inferred from the action type; a COHO-given category is never overwritten.
    categoryFromCoho: boolean("category_from_coho").notNull().default(false),
    dueDate: timestamp("due_date", { withTimezone: true }),
    overdue: boolean("overdue").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    snoozed: boolean("snoozed").notNull().default(false),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    canManuallyComplete: boolean("can_manually_complete").notNull().default(false),
    cohoPropertyReference: text("coho_property_reference"),
    propertyName: text("property_name"),
    cohoRoomReference: text("coho_room_reference"),
    roomName: text("room_name"),
    tenancyGuid: uuid("tenancy_guid"),
    assignedToGuid: uuid("assigned_to_guid"),
    assignedToName: text("assigned_to_name"),
    tags: text("tags").array().notNull().default([]),
    progressionStepsCompleted: integer("progression_steps_completed").notNull().default(0),
    progressionStepsCount: integer("progression_steps_count").notNull().default(0),
    // The COHO item as received, for fields not mapped to columns.
    raw: jsonb("raw").notNull(),
    // Hash of the mapped fields; the sync only rewrites a row when this changes.
    contentHash: text("content_hash").notNull(),
    lastChangedAt: timestamp("last_changed_at", { withTimezone: true }).notNull().defaultNow(),
    // Set when a full sync no longer returns the action (deleted in COHO).
    removedFromCohoAt: timestamp("removed_from_coho_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("coho_actions_category_status_idx").on(t.category, t.status),
    index("coho_actions_due_date_idx").on(t.dueDate),
    index("coho_actions_property_idx").on(t.cohoPropertyReference),
    index("coho_actions_created_at_idx").on(t.createdAt),
  ],
).enableRLS();

export type CohoAction = typeof cohoActionsTable.$inferSelect;
export type InsertCohoAction = typeof cohoActionsTable.$inferInsert;

export const unitSnapshotStatusEnum = pgEnum("unit_snapshot_status", ["let", "vacant"]);

// One row per COHO unit per UK day, recorded by the Performance page and a
// daily n8n call. COHO's API returns no past tenancies, so occupancy over
// time, tenancy length and days to fill voids are worked out from these rows.
export const cohoUnitSnapshotsTable = pgTable(
  "coho_unit_snapshots",
  {
    id: id(),
    snapshotDate: date("snapshot_date").notNull(),
    cohoPropertyReference: text("coho_property_reference").notNull(),
    propertyName: text("property_name").notNull(),
    cohoUnitReference: text("coho_unit_reference").notNull(),
    status: unitSnapshotStatusEnum("status").notNull(),
    tenancyGuid: uuid("tenancy_guid"),
    tenancyStartDate: date("tenancy_start_date"),
    rent: money("rent"),
    advertisedRent: money("advertised_rent"),
    ...timestamps,
  },
  (t) => [
    // Also serves date-range reads, since snapshot_date leads.
    uniqueIndex("coho_unit_snapshots_day_unit_idx").on(t.snapshotDate, t.cohoPropertyReference, t.cohoUnitReference),
    index("coho_unit_snapshots_property_idx").on(t.cohoPropertyReference, t.snapshotDate),
  ],
).enableRLS();

export type CohoUnitSnapshot = typeof cohoUnitSnapshotsTable.$inferSelect;
export type InsertCohoUnitSnapshot = typeof cohoUnitSnapshotsTable.$inferInsert;
