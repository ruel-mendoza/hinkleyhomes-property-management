import { Router, type IRouter } from "express";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { cohoActionsTable, getDb, isDatabaseConfigured } from "@workspace/db";
import { ListCohoActionsQueryParams, ListCohoActionsResponse, SyncCohoActionsResponse } from "@workspace/api-zod";
import { cohoApiKey } from "../lib/integrations-env";
import { lastSuccessfulActionsSync, syncCohoActions } from "../lib/coho-actions-sync";

const router: IRouter = Router();
const CATEGORIES = ["property", "tenancy", "maintenance", "onboarding", "viewing", "other"] as const;
const OPEN_STATUSES = ["not_set", "new", "in_progress", "on_hold"] as const;

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (ch) => `\\${ch}`);

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
    items: rows.map((row) => ({
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
    })),
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

export default router;
