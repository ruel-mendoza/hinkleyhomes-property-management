import { Router, type IRouter, type Request, type Response } from "express";
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { auditLogTable, cohoActionsTable, getDb, isDatabaseConfigured, type CohoAction } from "@workspace/db";
import {
  AssignCohoActionBody,
  AssignCohoActionParams,
  CreateCohoActionBody,
  ListCohoActionAssigneesResponse,
  ListCohoActionsQueryParams,
  ListCohoActionsResponse,
  SnoozeCohoActionBody,
  SnoozeCohoActionParams,
  SyncCohoActionsResponse,
  UnsnoozeCohoActionParams,
  UpdateCohoActionBody,
  UpdateCohoActionParams,
  UpdateCohoActionResponse,
  UpdateCohoActionStatusBody,
  UpdateCohoActionStatusParams,
} from "@workspace/api-zod";
import { cohoApiKey } from "../lib/integrations-env";
import { CohoApiError, cohoGet, cohoRequest } from "../lib/coho-api";
import { lastSuccessfulActionsSync, refreshCohoAction, syncCohoActions } from "../lib/coho-actions-sync";

const router: IRouter = Router();
const CATEGORIES = ["property", "tenancy", "maintenance", "onboarding", "viewing", "other"] as const;
const OPEN_STATUSES = ["not_set", "new", "in_progress", "on_hold"] as const;
const CUSTOM_ACTION_TYPE = "MISC_CUSTOM_ACTION";

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (ch) => `\\${ch}`);

function toItem(row: CohoAction) {
  return {
    reference: row.reference,
    title: row.title,
    message: row.message,
    notes: row.notes,
    status: row.status,
    type: row.type,
    typeName: row.typeName,
    category: row.category,
    dueDate: row.dueDate,
    overdue: row.overdue,
    snoozed: row.snoozed,
    snoozedUntil: row.snoozedUntil,
    completedAt: row.completedAt,
    propertyReference: row.cohoPropertyReference,
    propertyName: row.propertyName,
    roomReference: row.cohoRoomReference,
    roomName: row.roomName,
    assignedToName: row.assignedToName,
    tags: row.tags,
    progressionStepsCompleted: row.progressionStepsCompleted,
    progressionStepsCount: row.progressionStepsCount,
    firstSeenAt: row.createdAt,
    lastChangedAt: row.lastChangedAt,
    removedFromCoho: row.removedFromCohoAt !== null,
    archived: row.archived,
    assignedToGuid: row.assignedToGuid,
    canManuallyComplete: row.canManuallyComplete,
    isCustom: row.type === CUSTOM_ACTION_TYPE,
  };
}

router.get("/coho/actions", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  // z.coerce.boolean() turns the string "false" into true, so read this one directly.
  const { includeSnoozed: rawSnoozed, ...rest } = req.query;
  const params = ListCohoActionsQueryParams.safeParse(rest);
  if (!params.success) {
    res.status(400).json({ error: "Invalid action filters." });
    return;
  }
  const includeSnoozed = rawSnoozed === "true";
  const { category, search, propertyReference } = params.data;
  const status = params.data.status ?? "open";
  const page = params.data.page ?? 1;
  const pageSize = params.data.pageSize ?? 50;
  const t = cohoActionsTable;

  const filters: SQL[] = [];
  if (status === "open") filters.push(inArray(t.status, [...OPEN_STATUSES]));
  if (status === "completed") filters.push(eq(t.status, "completed"));
  if (status !== "all") filters.push(eq(t.archived, false), isNull(t.removedFromCohoAt));
  if (!includeSnoozed) filters.push(eq(t.snoozed, false));
  if (propertyReference) filters.push(eq(t.cohoPropertyReference, propertyReference));
  const term = search?.trim();
  if (term) {
    const pattern = `%${escapeLike(term)}%`;
    filters.push(
      or(ilike(t.title, pattern), ilike(t.propertyName, pattern), ilike(t.roomName, pattern), ilike(t.typeName, pattern), ilike(t.assignedToName, pattern))!,
    );
  }
  const withCategory = category ? [...filters, eq(t.category, category)] : filters;

  const db = getDb();
  const [rows, [{ total }], counts, lastSync] = await Promise.all([
    db
      .select()
      .from(t)
      .where(and(...withCategory))
      .orderBy(
        status === "completed" ? sql`${t.completedAt} desc nulls last` : sql`${t.dueDate} asc nulls last`,
        desc(t.createdAt),
        asc(t.reference),
      )
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(t).where(and(...withCategory)),
    db.select({ category: t.category, count: sql<number>`count(*)::int` }).from(t).where(and(...filters)).groupBy(t.category),
    lastSuccessfulActionsSync(),
  ]);

  const categoryCounts = Object.fromEntries(CATEGORIES.map((name) => [name, 0])) as Record<(typeof CATEGORIES)[number], number>;
  for (const row of counts) categoryCounts[row.category] = row.count;

  const parsed = ListCohoActionsResponse.safeParse({
    items: rows.map(toItem),
    page,
    pageSize,
    totalCount: total,
    hasNextPage: page * pageSize < total,
    categoryCounts,
    lastSync: lastSync && {
      status: lastSync.status,
      trigger: lastSync.trigger,
      startedAt: lastSync.startedAt,
      finishedAt: lastSync.finishedAt,
      error: lastSync.error,
    },
  });
  if (!parsed.success) {
    req.log.warn({ issueCount: parsed.error.issues.length }, "Stored COHO actions did not match the response schema");
    res.status(500).json({ error: "Stored actions could not be read." });
    return;
  }
  res.json(parsed.data);
});

router.post("/coho/actions/sync", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured() || !cohoApiKey()) {
    res.status(503).json({ error: "COHO or the database is not configured." });
    return;
  }
  const trigger = req.query.trigger === "page-open" ? "page-open" : "manual";
  const result = await syncCohoActions(trigger);
  if (result.status === "failed") {
    res.status(502).json({ error: result.error ?? "The COHO actions sync failed." });
    return;
  }
  res.json(SyncCohoActionsResponse.parse(result));
});

// People who can be assigned. COHO's organisation/users route needs a scope
// our API key may not have, so also include everyone already assigned an action.
router.get("/coho/actions/assignees", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  const people = new Map<string, string>();
  try {
    const payload = (await cohoGet("/organisation/users")) as { items?: unknown };
    for (const user of Array.isArray(payload.items) ? payload.items : []) {
      const { guid, forename, surname, email } = user as Record<string, unknown>;
      const name =
        [forename, surname].filter((part): part is string => typeof part === "string" && part.trim() !== "").join(" ") ||
        (typeof email === "string" ? email : "");
      if (typeof guid === "string" && name) people.set(guid.toLowerCase(), name);
    }
  } catch (error) {
    req.log.debug({ err: error }, "COHO organisation users unavailable; using stored assignees");
  }
  const t = cohoActionsTable;
  const stored = await getDb()
    .selectDistinct({ guid: t.assignedToGuid, name: t.assignedToName })
    .from(t)
    .where(and(isNotNull(t.assignedToGuid), isNotNull(t.assignedToName)));
  for (const row of stored) if (row.guid && row.name && !people.has(row.guid)) people.set(row.guid, row.name);

  const items = [...people].map(([guid, name]) => ({ guid, name })).sort((a, b) => a.name.localeCompare(b.name));
  res.json(ListCohoActionAssigneesResponse.parse({ items }));
});

// --- Writes -----------------------------------------------------------------
// Every change goes to COHO first (COHO stays the source of truth for actions),
// then the action is re-read from COHO and saved to Supabase, and the change is
// written to audit_log with who made it.

const AUDITED_FIELDS = ["title", "message", "notes", "status", "dueDate", "snoozed", "snoozedUntil", "assignedToGuid", "assignedToName", "completedAt"] as const;
const snapshot = (row: CohoAction | null | undefined) =>
  row ? Object.fromEntries(AUDITED_FIELDS.map((key) => [key, row[key]])) : null;

async function audit(req: Request, res: Response, action: string, reference: string, before: unknown, after: unknown) {
  const staff = res.locals.staff as { userId?: string; email?: string } | undefined;
  await getDb()
    .insert(auditLogTable)
    .values({
      actorEmail: staff?.email ?? null,
      actorUserId: staff?.userId ?? null,
      action,
      tableName: "coho_actions",
      recordId: reference,
      before,
      after,
      requestId: req.id !== undefined && req.id !== null ? String(req.id) : null,
      ipAddress: req.ip ?? null,
    })
    .catch((error: unknown) => req.log.error({ err: error, action, reference }, "Could not write the audit log entry"));
}

function sendCohoError(req: Request, res: Response, error: unknown, fallback: string) {
  if (error instanceof CohoApiError && (error.status === 400 || error.status === 404 || error.status === 409)) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  req.log.warn({ err: error }, fallback);
  res.status(502).json({ error: error instanceof Error ? error.message : fallback });
}

function ready(res: Response): boolean {
  if (isDatabaseConfigured() && cohoApiKey()) return true;
  res.status(503).json({ error: "COHO or the database is not configured." });
  return false;
}

async function findAction(reference: string) {
  const [row] = await getDb().select().from(cohoActionsTable).where(eq(cohoActionsTable.reference, reference)).limit(1);
  return row ?? null;
}

// Runs a COHO write for an existing action, refreshes the stored copy and audits it.
async function changeAction(
  req: Request,
  res: Response,
  reference: string,
  auditAction: string,
  write: (current: CohoAction) => Promise<unknown>,
  validate?: (current: CohoAction) => string | null,
) {
  const current = await findAction(reference);
  if (!current) {
    res.status(404).json({ error: "Action not found. Run Sync now and try again." });
    return;
  }
  const problem = validate?.(current);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }
  try {
    await write(current);
  } catch (error) {
    sendCohoError(req, res, error, "COHO rejected the action change");
    return;
  }
  let saved: CohoAction;
  try {
    saved = await refreshCohoAction(reference);
  } catch (error) {
    await audit(req, res, auditAction, reference, snapshot(current), { refreshFailed: true });
    req.log.warn({ err: error, reference }, "Action changed in COHO but could not be re-read");
    res.status(502).json({ error: "The change was saved in COHO, but the app could not reload it. Run Sync now to see it." });
    return;
  }
  await audit(req, res, auditAction, reference, snapshot(current), snapshot(saved));
  res.json(UpdateCohoActionResponse.parse(toItem(saved)));
}

const actionPath = (reference: string, suffix = "") => `/actions/${encodeURIComponent(reference)}${suffix}`;

router.post("/coho/actions", async (req, res): Promise<void> => {
  if (!ready(res)) return;
  const body = CreateCohoActionBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Give the action a title (up to 100 characters); the message can be up to 400." });
    return;
  }
  const { title, message, notes, dueDate, propertyReference, roomReference, assignTo } = body.data;
  if (roomReference && !propertyReference) {
    res.status(400).json({ error: "Pick a property before a room." });
    return;
  }
  let reference: string;
  try {
    const created = (await cohoRequest("POST", "/actions", {
      title: title.trim(),
      message: message?.trim() || null,
      notes: notes?.trim() || null,
      dueDate: dueDate ? dueDate.toISOString() : null,
      status: "NEW",
      propertyReference: propertyReference || null,
      roomReference: roomReference || null,
      assignedTo: assignTo ?? null,
    })) as { reference?: unknown };
    if (typeof created.reference !== "string" || !created.reference) throw new CohoApiError("COHO did not return the new action's reference.");
    reference = created.reference;
  } catch (error) {
    sendCohoError(req, res, error, "COHO rejected the new action");
    return;
  }
  req.log.info({ reference }, "COHO custom action created");
  try {
    const saved = await refreshCohoAction(reference);
    await audit(req, res, "coho_action.create", reference, null, snapshot(saved));
    res.json(UpdateCohoActionResponse.parse(toItem(saved)));
  } catch (error) {
    await audit(req, res, "coho_action.create", reference, null, { title, refreshFailed: true });
    req.log.warn({ err: error, reference }, "Created action could not be re-read");
    res.status(502).json({ error: "The action was created in COHO, but the app could not load it yet. Run Sync now to see it." });
  }
});

router.patch("/coho/actions/:reference", async (req, res): Promise<void> => {
  if (!ready(res)) return;
  const params = UpdateCohoActionParams.safeParse(req.params);
  const body = UpdateCohoActionBody.safeParse(req.body);
  if (!params.success || !body.success || Object.keys(body.data).length === 0) {
    res.status(400).json({ error: "Check the title (1–100 characters), message (up to 400) and due date." });
    return;
  }
  const change = body.data;
  await changeAction(
    req,
    res,
    params.data.reference,
    "coho_action.edit",
    (current) => {
      // Send every field so COHO never clears one we didn't mean to touch.
      const title = change.title ?? current.title ?? "";
      const message = "message" in change ? change.message : current.message;
      const notes = "notes" in change ? change.notes : current.notes;
      const due = "dueDate" in change ? change.dueDate : current.dueDate;
      return cohoRequest("PATCH", actionPath(current.reference), {
        title: title.trim(),
        message: message?.trim() || null,
        notes: notes?.trim() || null,
        dueDate: due ? due.toISOString() : null,
      });
    },
    (current) =>
      current.type === CUSTOM_ACTION_TYPE ? null : "COHO only allows editing custom actions. Change the status, assignee or snooze instead.",
  );
});

router.patch("/coho/actions/:reference/status", async (req, res): Promise<void> => {
  if (!ready(res)) return;
  const params = UpdateCohoActionStatusParams.safeParse(req.params);
  const body = UpdateCohoActionStatusBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Choose New, In progress, On hold or Completed." });
    return;
  }
  const { status } = body.data;
  await changeAction(
    req,
    res,
    params.data.reference,
    `coho_action.status.${status}`,
    // COHO reads statuses as SCREAMING_SNAKE and rejects the camelCase it sends back.
    (current) => cohoRequest("PATCH", actionPath(current.reference, "/status"), { status: status.toUpperCase() }),
    (current) =>
      status === "completed" && !current.canManuallyComplete
        ? "COHO completes this action itself once the underlying task is done (for example when the certificate is uploaded), so it can't be marked completed here."
        : null,
  );
});

router.post("/coho/actions/:reference/assign", async (req, res): Promise<void> => {
  if (!ready(res)) return;
  const params = AssignCohoActionParams.safeParse(req.params);
  const body = AssignCohoActionBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Choose a person to assign, or unassign." });
    return;
  }
  const assignTo = body.data.assignTo ?? null;
  await changeAction(req, res, params.data.reference, assignTo ? "coho_action.assign" : "coho_action.unassign", (current) =>
    cohoRequest("POST", actionPath(current.reference, "/assign"), { assignTo }),
  );
});

router.post("/coho/actions/:reference/snooze", async (req, res): Promise<void> => {
  if (!ready(res)) return;
  const params = SnoozeCohoActionParams.safeParse(req.params);
  const body = SnoozeCohoActionBody.safeParse(req.body);
  if (!params.success || !body.success || Number.isNaN(body.data.until.getTime())) {
    res.status(400).json({ error: "Choose a date to snooze until." });
    return;
  }
  const { until } = body.data;
  if (until.getTime() <= Date.now()) {
    res.status(400).json({ error: "The snooze date must be in the future." });
    return;
  }
  await changeAction(req, res, params.data.reference, "coho_action.snooze", (current) =>
    cohoRequest("PATCH", actionPath(current.reference, "/snooze"), { date: until.toISOString() }),
  );
});

router.post("/coho/actions/:reference/unsnooze", async (req, res): Promise<void> => {
  if (!ready(res)) return;
  const params = UnsnoozeCohoActionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid action reference." });
    return;
  }
  await changeAction(
    req,
    res,
    params.data.reference,
    "coho_action.unsnooze",
    (current) => cohoRequest("PATCH", actionPath(current.reference, "/un-snooze")),
    (current) => (current.snoozed ? null : "This action isn't snoozed."),
  );
});

export default router;
