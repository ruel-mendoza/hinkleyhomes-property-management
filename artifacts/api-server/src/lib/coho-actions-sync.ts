import { createHash } from "node:crypto";
import { and, eq, isNull, like, sql } from "drizzle-orm";
import { cohoActionsTable, getDb, integrationSyncRunsTable, type InsertCohoAction } from "@workspace/db";
import { cohoGet } from "./coho-api";
import { logger } from "./logger";

// Mirrors every COHO action into Supabase (coho_actions). COHO has no webhooks,
// so new and changed actions are picked up by running this regularly: from the
// Actions page, the "Sync now" button, and the n8n schedule.

export type SyncTrigger = "manual" | "page-open" | "schedule";
export type CohoActionSyncResult = {
  status: "succeeded" | "failed" | "skipped";
  fetched: number;
  created: number;
  updated: number;
  removed: number;
  startedAt: Date;
  finishedAt: Date;
  error: string | null;
};

type Category = InsertCohoAction["category"];
type Status = InsertCohoAction["status"];
type RecordValue = Record<string, unknown>;

// Bump when toRow's mapping changes so the next sync rewrites every row.
const MAPPING_VERSION = 2;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const UPSERT_BATCH = 200;
// Sync runs are stored in integration_sync_runs with this trigger prefix.
export const ACTIONS_SYNC_TRIGGER_PREFIX = "actions:";

const asRecord = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const date = (value: unknown): Date | null => {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const guid = (value: unknown): string | null =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : null;

// The spec documents SCREAMING_SNAKE enums, but COHO actually sends camelCase
// ("fireSafetyAddItem", "new"); normalise both to SCREAMING_SNAKE.
export const normaliseEnum = (value: unknown): string =>
  String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toUpperCase();

const STATUS: Record<string, Status> = {
  NOT_SET_OR_NOT_APPLICABLE: "not_set",
  NEW: "new",
  IN_PROGRESS: "in_progress",
  ON_HOLD: "on_hold",
  COMPLETED: "completed",
};
const CATEGORIES: readonly Category[] = ["property", "tenancy", "maintenance", "onboarding", "viewing", "other"];

// COHO only says which tab an action belongs to for the actions on its
// overview; for the rest, infer the tab from the action type.
const PROPERTY_TYPES = /^(FIRE_SAFETY|HMO_LICENCE|ENERGY_PERFORMANCE|GAS_SAFETY|ELECTRICAL_INSTALLATION|PORTABLE_APPLIANCE|INSPECTION|BOILER_SERVIC|BUILDING_INSURANCE|MORTGAGE_RENEWAL|HEALTH_AND_SAFETY|CUSTOM_CERTIFICATE|RENT_REVIEW|PROPERTY_ACCESS)/;
const TENANCY_TYPES = /^(RENT_COLLECTION|TENANCY_|DEPOSIT_MANAGEMENT|FINISH_DEPOSIT|RIGHT_TO_RENT|MISC_TENANCY|MISC_INVITE_TENANT|MISC_TENANT_|MISC_HOW_TO_RENT|MANUALLY_TRIGGERED_TENANCY|GO_CARDLESS|MANAGER_GO_CARDLESS|INVENTORY_TENANT)/;
export function inferCategory(type: string): Category {
  if (type.startsWith("MAINTENANCE")) return "maintenance";
  if (type.startsWith("MISC_ONBOARDING") || type === "MANUALLY_TRIGGERED_ONBOARDING_CREATED") return "onboarding";
  if (type.startsWith("TENANT_FIND")) return "viewing";
  if (PROPERTY_TYPES.test(type)) return "property";
  if (TENANCY_TYPES.test(type)) return "tenancy";
  return "other";
}

async function fetchAllPages(path: string, extra: Record<string, string>): Promise<RecordValue[]> {
  const items: RecordValue[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = new URLSearchParams({ ...extra, page: String(page), pageSize: String(PAGE_SIZE) });
    const payload = asRecord(await cohoGet(`${path}?${query}`));
    const pageItems = Array.isArray(payload.items) ? payload.items : [];
    items.push(...pageItems.map(asRecord));
    if (payload.hasNextPage !== true || pageItems.length === 0) return items;
  }
  throw new Error(`COHO ${path} returned more than ${MAX_PAGES} pages; stopping to avoid an endless sync.`);
}

async function fetchNames() {
  const properties = await fetchAllPages("/properties", { includeRooms: "true" });
  const propertyNames = new Map<string, string>();
  const roomNames = new Map<string, string>();
  for (const property of properties) {
    const reference = str(property.reference);
    const name = str(property.name);
    if (reference && name) propertyNames.set(reference, name);
    for (const room of Array.isArray(property.rooms) ? property.rooms.map(asRecord) : []) {
      const roomReference = str(room.reference);
      const roomName = str(room.name);
      if (roomReference && roomName) roomNames.set(roomReference, roomName);
    }
  }
  return { propertyNames, roomNames };
}

async function fetchOverviewCategories(): Promise<Map<string, Category>> {
  const overview = asRecord(await cohoGet("/actions/overview"));
  const byReference = new Map<string, Category>();
  for (const category of Array.isArray(overview.categories) ? overview.categories.map(asRecord) : []) {
    const name = String(category.reference ?? "").toLowerCase() as Category;
    if (!CATEGORIES.includes(name)) continue;
    for (const action of Array.isArray(category.actions) ? category.actions.map(asRecord) : []) {
      const reference = str(action.reference);
      if (reference) byReference.set(reference.toUpperCase(), name);
    }
  }
  return byReference;
}

function toRow(
  item: RecordValue,
  names: Awaited<ReturnType<typeof fetchNames>>,
  overviewCategories: Map<string, Category>,
): InsertCohoAction | null {
  const reference = str(item.reference);
  if (!reference) return null;
  const type = normaliseEnum(str(item.type) ?? "UNKNOWN");
  // COHO leaves status at "new" on completed actions; the completed date is what counts.
  const completedAt = date(item.completed);
  const cohoCategory = overviewCategories.get(reference.toUpperCase());
  const assigned = asRecord(item.assignedTo);
  const assignedName = [str(assigned.forename), str(assigned.surname)].filter(Boolean).join(" ") || null;
  const propertyReference = str(item.propertyReference);
  const roomReference = str(item.roomReference);
  const row = {
    reference,
    title: str(item.title),
    message: str(item.message),
    notes: str(item.notes),
    status: completedAt ? "completed" : (STATUS[normaliseEnum(item.status)] ?? "not_set"),
    type,
    typeName: str(item.typeName),
    category: cohoCategory ?? inferCategory(type),
    categoryFromCoho: Boolean(cohoCategory),
    dueDate: date(item.dueDate),
    overdue: item.overdue === true,
    archived: item.archived === true,
    snoozed: item.snoozed === true,
    snoozedUntil: date(item.snoozedDate),
    completedAt,
    canManuallyComplete: item.canManuallyComplete === true,
    cohoPropertyReference: propertyReference,
    propertyName: propertyReference ? (names.propertyNames.get(propertyReference) ?? null) : null,
    cohoRoomReference: roomReference,
    roomName: roomReference ? (names.roomNames.get(roomReference) ?? null) : null,
    tenancyGuid: guid(item.tenancyGuid),
    assignedToGuid: guid(assigned.guid),
    assignedToName: assignedName,
    tags: Array.isArray(item.tagStrings) ? item.tagStrings.filter((tag): tag is string => typeof tag === "string") : [],
    progressionStepsCompleted: Number.isInteger(item.progressionStepsCompleted) ? (item.progressionStepsCompleted as number) : 0,
    progressionStepsCount: Number.isInteger(item.progressionStepsCount) ? (item.progressionStepsCount as number) : 0,
    raw: item,
  };
  // The category is compared separately (see setWhere) so a kept COHO
  // category doesn't make the row look changed on every sync.
  const contentHash = createHash("sha256")
    .update(JSON.stringify([MAPPING_VERSION, item, row.propertyName, row.roomName]))
    .digest("hex");
  return { ...row, contentHash };
}

// Columns refreshed from COHO on every real change.
const UPDATABLE = [
  "title", "message", "notes", "status", "type", "typeName", "dueDate", "overdue", "archived", "snoozed",
  "snoozedUntil", "completedAt", "canManuallyComplete", "cohoPropertyReference", "propertyName",
  "cohoRoomReference", "roomName", "tenancyGuid", "assignedToGuid", "assignedToName", "tags",
  "progressionStepsCompleted", "progressionStepsCount", "raw", "contentHash",
] as const;
const excluded = (key: (typeof UPDATABLE)[number] | "category" | "categoryFromCoho") =>
  sql.raw(`excluded."${cohoActionsTable[key].name}"`);

async function saveRows(rows: InsertCohoAction[]) {
  const db = getDb();
  let created = 0;
  let updated = 0;
  for (let start = 0; start < rows.length; start += UPSERT_BATCH) {
    const batch = rows.slice(start, start + UPSERT_BATCH);
    const result = await db
      .insert(cohoActionsTable)
      .values(batch)
      .onConflictDoUpdate({
        target: cohoActionsTable.reference,
        set: {
          ...Object.fromEntries(UPDATABLE.map((key) => [key, excluded(key)])),
          // A category COHO itself gave is kept over a later inferred one.
          category: sql`case when ${excluded("categoryFromCoho")} or not ${cohoActionsTable.categoryFromCoho} then ${excluded("category")} else ${cohoActionsTable.category} end`,
          categoryFromCoho: sql`${excluded("categoryFromCoho")} or ${cohoActionsTable.categoryFromCoho}`,
          removedFromCohoAt: sql`null`,
          lastChangedAt: sql`now()`,
          updatedAt: sql`now()`,
        },
        setWhere: sql`${cohoActionsTable.contentHash} is distinct from ${excluded("contentHash")}
          or ${cohoActionsTable.removedFromCohoAt} is not null
          or (${excluded("categoryFromCoho")} and ${cohoActionsTable.category} is distinct from ${excluded("category")})`,
      })
      // xmax = 0 only for freshly inserted rows; skipped (unchanged) rows aren't returned.
      .returning({ inserted: sql<boolean>`(${sql.raw('"coho_actions"."xmax"')} = 0)` });
    for (const row of result) row.inserted ? created++ : updated++;
  }
  return { created, updated };
}

async function markRemoved(seenReferences: string[]): Promise<number> {
  if (seenReferences.length === 0) return 0; // never treat an empty COHO response as "everything deleted"
  const result = await getDb()
    .update(cohoActionsTable)
    .set({ removedFromCohoAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        isNull(cohoActionsTable.removedFromCohoAt),
        sql`${cohoActionsTable.reference} <> all(${sql.param(seenReferences)}::text[])`,
      ),
    )
    .returning({ id: cohoActionsTable.id });
  return result.length;
}

let running: Promise<CohoActionSyncResult> | null = null;

export function syncCohoActions(trigger: SyncTrigger): Promise<CohoActionSyncResult> {
  // One sync at a time per server; callers that arrive mid-sync get "skipped".
  if (running) {
    const now = new Date();
    return Promise.resolve({ status: "skipped", fetched: 0, created: 0, updated: 0, removed: 0, startedAt: now, finishedAt: now, error: null });
  }
  running = runSync(trigger).finally(() => {
    running = null;
  });
  return running;
}

async function runSync(trigger: SyncTrigger): Promise<CohoActionSyncResult> {
  const db = getDb();
  const startedAt = new Date();
  const [run] = await db
    .insert(integrationSyncRunsTable)
    .values({ integration: "coho", trigger: `${ACTIONS_SYNC_TRIGGER_PREFIX}${trigger}`, startedAt })
    .returning({ id: integrationSyncRunsTable.id });

  try {
    const [names, overviewCategories, items] = await Promise.all([
      fetchNames(),
      fetchOverviewCategories(),
      fetchAllPages("/actions", { includeCompleted: "true", showSnoozed: "true", orgPersonDefaultFilter: "preset:all" }),
    ]);
    // Paging can repeat an item if COHO changes mid-sync; keep the last copy.
    const rows = [...new Map(
      items.map((item) => toRow(item, names, overviewCategories)).filter((row): row is InsertCohoAction => row !== null).map((row) => [row.reference, row]),
    ).values()];
    const { created, updated } = await saveRows(rows);
    const removed = await markRemoved(rows.map((row) => row.reference));
    const finishedAt = new Date();
    await db
      .update(integrationSyncRunsTable)
      .set({ status: "succeeded", finishedAt, recordsProcessed: rows.length })
      .where(eq(integrationSyncRunsTable.id, run.id));
    logger.info({ trigger, fetched: rows.length, created, updated, removed }, "COHO actions sync finished");
    return { status: "succeeded", fetched: rows.length, created, updated, removed, startedAt, finishedAt, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const finishedAt = new Date();
    await db
      .update(integrationSyncRunsTable)
      .set({ status: "failed", finishedAt, error: message.slice(0, 1000) })
      .where(eq(integrationSyncRunsTable.id, run.id))
      .catch(() => undefined);
    logger.warn({ trigger, err: error }, "COHO actions sync failed");
    return { status: "failed", fetched: 0, created: 0, updated: 0, removed: 0, startedAt, finishedAt, error: message };
  }
}

export async function lastSuccessfulActionsSync() {
  const [last] = await getDb()
    .select()
    .from(integrationSyncRunsTable)
    .where(
      and(
        eq(integrationSyncRunsTable.integration, "coho"),
        eq(integrationSyncRunsTable.status, "succeeded"),
        like(integrationSyncRunsTable.trigger, `${ACTIONS_SYNC_TRIGGER_PREFIX}%`),
      ),
    )
    .orderBy(sql`${integrationSyncRunsTable.startedAt} desc`)
    .limit(1);
  return last ?? null;
}
