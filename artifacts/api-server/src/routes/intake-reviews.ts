import { Router, type IRouter } from "express";
import { desc, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb, invoiceIntakeChecksTable, invoiceIntakeReviewsTable, isDatabaseConfigured } from "@workspace/db";
import {
  ListIntakeChecksQueryParams,
  ListIntakeChecksResponse,
  ListIntakeReviewsResponse,
  ResolveIntakeReviewBody,
  ResolveIntakeReviewParams,
  ResolveIntakeReviewResponse,
} from "@workspace/api-zod";
import { clearResolvedIntakeReviews, intakeFilesFor, intakeReviewView, removeIntakeReview } from "../lib/intake-reviews";

// Invoices page, "Inbox" and "For review" tabs: what the n8n intake check made
// of each email to accounts@, and the ones it could not pass or bounce on its
// own. Only open reviews are kept; see lib/intake-reviews.ts.

const router: IRouter = Router();

router.get("/invoices/intake-reviews", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  const t = invoiceIntakeReviewsTable;
  try {
    await clearResolvedIntakeReviews().catch((error: unknown) => req.log.warn({ err: error }, "Intake reviews already in Xero could not be cleared"));
    const [rows, [counts]] = await Promise.all([
      getDb().select().from(t).where(eq(t.status, "open")).orderBy(desc(t.createdAt)).limit(500),
      getDb().select({ open: sql<number>`count(*)::int` }).from(t).where(eq(t.status, "open")),
    ]);
    const files = await intakeFilesFor(rows.map((row) => row.internetMessageId));
    res.json(ListIntakeReviewsResponse.parse({ items: rows.map((row) => intakeReviewView(row, files.get(row.internetMessageId))), openCount: counts?.open ?? 0 }));
  } catch (error) {
    req.log.error({ err: error }, "Intake reviews could not be read");
    res.status(503).json({ error: "Intake reviews aren't set up yet: run the database push." });
  }
});

const VERDICTS = ["pass", "bounce", "review", "not_invoice"] as const;

router.get("/invoices/intake-checks", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  const query = ListIntakeChecksQueryParams.safeParse(req.query);
  const verdict = query.success ? query.data.verdict ?? "invoices" : "invoices";
  const t = invoiceIntakeChecksTable;
  const where = verdict === "all" ? undefined : verdict === "invoices" ? ne(t.verdict, "not_invoice") : eq(t.verdict, verdict);
  try {
    const [rows, counted] = await Promise.all([
      getDb().select().from(t).where(where).orderBy(desc(t.processedAt)).limit(500),
      getDb().select({ verdict: t.verdict, n: sql<number>`count(*)::int` }).from(t).where(inArray(t.verdict, [...VERDICTS])).groupBy(t.verdict),
    ]);
    const files = await intakeFilesFor(rows.map((row) => row.internetMessageId));
    const counts = Object.fromEntries(VERDICTS.map((key) => [key, counted.find((row) => row.verdict === key)?.n ?? 0]));
    res.json(ListIntakeChecksResponse.parse({
      items: rows.map((row) => ({
        id: row.id,
        processedAt: row.processedAt.toISOString(),
        senderEmail: row.senderEmail,
        subject: row.subject,
        supplierName: row.supplierName,
        invoiceNumber: row.invoiceNumber,
        invoiceDate: row.invoiceDate,
        total: row.totalGross === null ? null : Number(row.totalGross),
        billTo: row.billTo,
        verdict: row.verdict,
        issueCodes: row.issueCodes,
        action: row.action,
        files: files.get(row.internetMessageId) ?? [],
      })),
      counts,
    }));
  } catch (error) {
    req.log.error({ err: error }, "Intake checks could not be read");
    res.status(503).json({ error: "The inbox log isn't set up yet: run the database push." });
  }
});

// Done or dismissed: the review is deleted; who, the outcome and the note go to the audit log.
router.post("/invoices/intake-reviews/:id/resolve", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  const params = ResolveIntakeReviewParams.safeParse(req.params);
  const body = ResolveIntakeReviewBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Choose done or dismissed; a note can be up to 1,000 characters." });
    return;
  }
  const t = invoiceIntakeReviewsTable;
  const [review] = await getDb().select().from(t).where(eq(t.id, params.data.id)).limit(1);
  const staff = res.locals.staff as { userId?: string; email?: string } | undefined;
  const removed = review
    ? await removeIntakeReview(review, `intake_review.${body.data.outcome}`, { outcome: body.data.outcome, note: body.data.note?.trim() || null }, {
      email: staff?.email ?? null,
      userId: staff?.userId ?? null,
      requestId: req.id !== undefined && req.id !== null ? String(req.id) : null,
      ipAddress: req.ip ?? null,
    })
    : false;
  if (!removed) {
    res.status(404).json({ error: "This review has already been dealt with." });
    return;
  }
  res.json(ResolveIntakeReviewResponse.parse({ id: params.data.id }));
});

export default router;
