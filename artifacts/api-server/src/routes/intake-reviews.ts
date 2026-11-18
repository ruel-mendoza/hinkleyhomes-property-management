import { Router, type IRouter } from "express";
import { desc, eq, inArray, ne, sql } from "drizzle-orm";
import { auditLogTable, getDb, invoiceIntakeChecksTable, invoiceIntakeReviewsTable, isDatabaseConfigured } from "@workspace/db";
import {
  ClearNotInvoiceIntakeChecksResponse,
  GetIntakeFallbackStatusResponse,
  ListIntakeChecksQueryParams,
  ListIntakeChecksResponse,
  ListIntakeReviewsResponse,
  ResolveIntakeReviewBody,
  ResolveIntakeReviewParams,
  ResolveIntakeReviewResponse,
  RunIntakeFallbackResponse,
} from "@workspace/api-zod";
import { intakeFallbackStatus, runIntakeFallback } from "../lib/intake-fallback";
import { aliasFixesFor, loadAliasLookup } from "../lib/intake-alias-fixes";
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
  // "fixed" is a bounce whose every problem is now covered by an alias
  // (lib/intake-alias-fixes.ts); "bounce" lists only the ones still waiting.
  const stored = verdict === "fixed" ? "bounce" : verdict;
  const where = stored === "all" ? undefined : stored === "invoices" ? ne(t.verdict, "not_invoice") : eq(t.verdict, stored);
  try {
    const [found, counted, bounces, lookup] = await Promise.all([
      getDb().select().from(t).where(where).orderBy(desc(t.processedAt)).limit(500),
      getDb().select({ verdict: t.verdict, n: sql<number>`count(*)::int` }).from(t).where(inArray(t.verdict, [...VERDICTS])).groupBy(t.verdict),
      getDb().select({ verdict: t.verdict, billTo: t.billTo, issues: t.issues }).from(t).where(eq(t.verdict, "bounce")),
      loadAliasLookup(),
    ]);
    const withFixes = found.map((row) => ({ row, ...aliasFixesFor(row, lookup) }));
    const rows = verdict === "fixed" ? withFixes.filter((item) => item.fixedByAlias) : verdict === "bounce" ? withFixes.filter((item) => !item.fixedByAlias) : withFixes;
    const files = await intakeFilesFor(rows.map(({ row }) => row.internetMessageId));
    const fixed = bounces.filter((row) => aliasFixesFor(row, lookup).fixedByAlias).length;
    const counts = { ...Object.fromEntries(VERDICTS.map((key) => [key, counted.find((row) => row.verdict === key)?.n ?? 0])), fixed } as Record<string, number>;
    counts.bounce = Math.max(0, counts.bounce - fixed);
    res.json(ListIntakeChecksResponse.parse({
      items: rows.map(({ row, aliasFixes, fixedByAlias }) => ({
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
        checkedBy: row.checkedBy,
        files: files.get(row.internetMessageId) ?? [],
        aliasFixes,
        fixedByAlias,
      })),
      counts,
    }));
  } catch (error) {
    req.log.error({ err: error }, "Intake checks could not be read");
    res.status(503).json({ error: "The inbox log isn't set up yet: run the database push." });
  }
});

// Deletes every "Not invoices" row. Safe because the n8n intake check skips any
// email tagged "n8n: not an invoice" in Outlook, so they are not checked
// again. What was deleted (sender, subject) goes to the audit log.
router.post("/invoices/intake-checks/clear-not-invoices", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  const t = invoiceIntakeChecksTable;
  const staff = res.locals.staff as { userId?: string; email?: string } | undefined;
  try {
    const cleared = await getDb().transaction(async (tx) => {
      const rows = await tx.delete(t).where(eq(t.verdict, "not_invoice")).returning({ internetMessageId: t.internetMessageId, senderEmail: t.senderEmail, subject: t.subject });
      if (rows.length) {
        await tx.insert(auditLogTable).values({
          actorEmail: staff?.email ?? null,
          actorUserId: staff?.userId ?? null,
          action: "intake_check.clear_not_invoices",
          tableName: "invoice_intake_checks",
          recordId: "not_invoice",
          before: { emails: rows },
          after: { deleted: rows.length },
          requestId: req.id !== undefined && req.id !== null ? String(req.id) : null,
          ipAddress: req.ip ?? null,
        });
      }
      return rows.length;
    });
    res.json(ClearNotInvoiceIntakeChecksResponse.parse({ cleared }));
  } catch (error) {
    req.log.error({ err: error }, "Not-invoice intake checks could not be cleared");
    res.status(503).json({ error: "The list could not be cleared. Try again in a minute." });
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

// Backup for the n8n intake check (lib/intake-fallback.ts): its status, and a
// manual run for emails n8n has not dealt with. Runs are audit-logged.
router.get("/invoices/intake-fallback", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  try {
    res.json(GetIntakeFallbackStatusResponse.parse(await intakeFallbackStatus()));
  } catch (error) {
    req.log.error({ err: error }, "Backup intake check status could not be read");
    res.status(503).json({ error: "The backup check isn't set up yet: run the database push." });
  }
});

router.post("/invoices/intake-fallback/run", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  const result = await runIntakeFallback("manual");
  const staff = res.locals.staff as { userId?: string; email?: string } | undefined;
  await getDb().insert(auditLogTable).values({
    actorEmail: staff?.email ?? null,
    actorUserId: staff?.userId ?? null,
    action: "intake_fallback.run",
    tableName: "invoice_intake_checks",
    recordId: "accounts_inbox",
    after: { status: result.status, waiting: result.waiting, checked: result.checked, verdicts: result.verdicts, error: result.error },
    requestId: req.id !== undefined && req.id !== null ? String(req.id) : null,
    ipAddress: req.ip ?? null,
  }).catch((error: unknown) => req.log.warn({ err: error }, "Backup intake run could not be audit-logged"));
  res.json(RunIntakeFallbackResponse.parse(result));
});

export default router;
