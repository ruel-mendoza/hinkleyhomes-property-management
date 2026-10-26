import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { auditLogTable, getDb, invoiceIntakeReviewsTable, isDatabaseConfigured } from "@workspace/db";
import {
  ListIntakeReviewsQueryParams,
  ListIntakeReviewsResponse,
  UpdateIntakeReviewBody,
  UpdateIntakeReviewParams,
  UpdateIntakeReviewResponse,
} from "@workspace/api-zod";
import { intakeReviewView } from "../lib/intake-reviews";

// Invoices page, "For review" tab: emails the n8n intake check could not pass
// or bounce on its own. See lib/intake-reviews.ts.

const router: IRouter = Router();

router.get("/invoices/intake-reviews", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  const query = ListIntakeReviewsQueryParams.safeParse(req.query);
  const status = query.success ? query.data.status ?? "open" : "open";
  const t = invoiceIntakeReviewsTable;
  try {
    const [rows, [counts]] = await Promise.all([
      getDb()
        .select()
        .from(t)
        .where(status === "all" ? undefined : eq(t.status, status))
        .orderBy(desc(t.createdAt))
        .limit(500),
      getDb().select({ open: sql<number>`count(*)::int` }).from(t).where(eq(t.status, "open")),
    ]);
    res.json(ListIntakeReviewsResponse.parse({ items: rows.map(intakeReviewView), openCount: counts?.open ?? 0 }));
  } catch (error) {
    req.log.error({ err: error }, "Intake reviews could not be read");
    res.status(503).json({ error: "Intake reviews aren't set up yet: run the database push." });
  }
});

router.put("/invoices/intake-reviews/:id", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  const params = UpdateIntakeReviewParams.safeParse(req.params);
  const body = UpdateIntakeReviewBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Choose open, done or dismissed; a note can be up to 1,000 characters." });
    return;
  }
  const t = invoiceIntakeReviewsTable;
  const [before] = await getDb().select().from(t).where(eq(t.id, params.data.id)).limit(1);
  if (!before) {
    res.status(404).json({ error: "Review not found." });
    return;
  }
  const staff = res.locals.staff as { userId?: string; email?: string } | undefined;
  const reopened = body.data.status === "open";
  const [after] = await getDb()
    .update(t)
    .set({
      status: body.data.status,
      resolvedBy: reopened ? null : staff?.email ?? null,
      resolvedAt: reopened ? null : new Date(),
      resolution: reopened ? null : body.data.note?.trim() || null,
    })
    .where(eq(t.id, before.id))
    .returning();
  await getDb()
    .insert(auditLogTable)
    .values({
      actorEmail: staff?.email ?? null,
      actorUserId: staff?.userId ?? null,
      action: `intake_review.${body.data.status}`,
      tableName: "invoice_intake_reviews",
      recordId: before.id,
      before: { status: before.status, resolution: before.resolution },
      after: { status: after.status, resolution: after.resolution },
      requestId: req.id !== undefined && req.id !== null ? String(req.id) : null,
      ipAddress: req.ip ?? null,
    })
    .catch((error: unknown) => req.log.error({ err: error }, "Could not write the audit log entry"));
  res.json(UpdateIntakeReviewResponse.parse(intakeReviewView(after)));
});

export default router;
