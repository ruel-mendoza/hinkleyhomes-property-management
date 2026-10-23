import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  auditLogTable,
  exceptionQueueTable,
  getDb,
  integrationSyncRunsTable,
  isDatabaseConfigured,
  xeroInvoiceRemindersTable,
  type ExceptionItem,
  type XeroOverdueTracking,
} from "@workspace/db";
import {
  GetOverdueReportResponse,
  ListCheckRunsResponse,
  ListFinanceAlertsQueryParams,
  ListFinanceAlertsResponse,
  ListReminderLogResponse,
  RunChecksNowResponse,
  UpdateFinanceAlertBody,
  UpdateFinanceAlertParams,
  UpdateFinanceAlertResponse,
} from "@workspace/api-zod";
import { readXeroGatewayEnv } from "../lib/integrations-env";
import { DAILY_CHECKS_TRIGGER, firstCheckDay, lastCheckRuns, loadTracking, overdueChange, overdueInputs, runDailyChecks } from "../lib/finance-checks";
import { rankOverdue } from "../lib/overdue-ranking";
import { COMPANIES } from "./money";
import { receivablesSnapshot } from "./receivables";

// Finance checks page: the overdue ranking, the alerts the daily checks raised
// (bill prices, bank details, spend trends), the reminder log and check runs.
// The checks themselves run in lib/finance-checks.ts.

const router: IRouter = Router();
const ALERT_KINDS = ["bank_detail_change", "invoice_variance"] as const;
const companyName = (tenantId: string | null | undefined) => COMPANIES.find((company) => company.tenantId === tenantId)?.name ?? null;

const notConfigured = (res: Response) => res.status(503).json({ error: "The database is not configured." });

async function audit(req: Request, res: Response, action: string, recordId: string, before: unknown, after: unknown) {
  const staff = res.locals.staff as { userId?: string; email?: string } | undefined;
  await getDb()
    .insert(auditLogTable)
    .values({
      actorEmail: staff?.email ?? null,
      actorUserId: staff?.userId ?? null,
      action,
      tableName: "exception_queue",
      recordId,
      before: before ?? null,
      after: after ?? null,
      requestId: req.id !== undefined && req.id !== null ? String(req.id) : null,
      ipAddress: req.ip ?? null,
    })
    .catch((error: unknown) => req.log.error({ err: error }, "Could not write the audit log entry"));
}

router.get("/checks/overdue", async (req, res): Promise<void> => {
  if (readXeroGatewayEnv().status !== "configured") {
    res.status(503).json({ error: "The n8n Xero gateway is not configured." });
    return;
  }
  let snapshot;
  try {
    snapshot = await receivablesSnapshot(false, req.log);
  } catch (error) {
    req.log.warn({ err: error }, "Overdue report: Xero could not be read");
    res.status(502).json({ error: "Xero could not be read; try again shortly." });
    return;
  }
  let tracking = new Map<string, XeroOverdueTracking>();
  let trackingAvailable = isDatabaseConfigured();
  let lastRunAt: string | null = null;
  let firstDay: string | null = null;
  if (trackingAvailable) {
    try {
      tracking = await loadTracking();
      lastRunAt = (await lastCheckRuns(10)).find((run) => run.status === "succeeded")?.startedAt.toISOString() ?? null;
      firstDay = await firstCheckDay();
    } catch {
      trackingAvailable = false;
    }
  }
  const items = rankOverdue(overdueInputs(snapshot)).map((item) => {
    const row = tracking.get(`${item.tenantId}|${item.invoiceId}`);
    return {
      ledger: item.ledger,
      tenantId: item.tenantId,
      company: item.company,
      invoiceId: item.invoiceId,
      number: item.number,
      contactName: item.contactName,
      dueDate: item.dueDate,
      daysOverdue: item.daysOverdue,
      amountDue: item.amountDue,
      amountPaid: item.amountPaid,
      valueBand: item.valueBand,
      ageBucket: item.ageBucket,
      riskScore: item.riskScore,
      riskProfile: item.riskProfile,
      riskReasons: item.riskReasons,
      priority: item.priority,
      valueAtRisk: item.valueAtRisk,
      contactExposure: item.contactExposure,
      contactOverdueCount: item.contactOverdueCount,
      // Before the first daily check nothing is "new" yet.
      change: lastRunAt ? overdueChange(item, row, firstDay) : ("ongoing" as const),
      firstSeenOn: row?.firstSeenOn ?? null,
    };
  });
  res.json(GetOverdueReportResponse.parse({
    asOf: snapshot.asOf,
    complete: snapshot.complete,
    trackingAvailable,
    lastRunAt,
    problems: snapshot.companies.filter((company) => company.error).map((company) => `${company.name}: ${company.error}`),
    items,
  }));
});

function alertView(row: ExceptionItem) {
  const details = (row.details ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof details[key] === "string" && details[key] ? (details[key] as string) : null);
  const severity = text("severity");
  return {
    id: row.id,
    kind: row.kind,
    code: text("code") ?? row.kind,
    severity: severity === "high" || severity === "warn" || severity === "info" ? severity : "warn",
    status: row.status,
    summary: row.summary,
    tenantId: text("tenantId"),
    company: text("company") ?? companyName(text("tenantId")),
    supplier: text("supplier"),
    number: text("number"),
    billId: text("billId"),
    createdAt: row.createdAt.toISOString(),
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolution: row.resolution,
  };
}

router.get("/checks/alerts", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    notConfigured(res);
    return;
  }
  const query = ListFinanceAlertsQueryParams.safeParse(req.query);
  const status = query.success ? query.data.status ?? "open" : "open";
  const q = exceptionQueueTable;
  const kinds = inArray(q.kind, [...ALERT_KINDS]);
  try {
    const [rows, [counts]] = await Promise.all([
      getDb()
        .select()
        .from(q)
        .where(status === "all" ? kinds : and(kinds, eq(q.status, status)))
        .orderBy(desc(q.createdAt))
        .limit(500),
      getDb()
        .select({
          open: sql<number>`count(*)::int`,
          high: sql<number>`(count(*) filter (where ${q.details}->>'severity' = 'high'))::int`,
        })
        .from(q)
        .where(and(kinds, eq(q.status, "open"))),
    ]);
    res.json(ListFinanceAlertsResponse.parse({ items: rows.map(alertView), openCount: counts?.open ?? 0, openHighCount: counts?.high ?? 0 }));
  } catch (error) {
    req.log.error({ err: error }, "Finance alerts could not be read");
    res.status(503).json({ error: "Alerts aren't set up yet: run the database push." });
  }
});

router.put("/checks/alerts/:id", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    notConfigured(res);
    return;
  }
  const params = UpdateFinanceAlertParams.safeParse(req.params);
  const body = UpdateFinanceAlertBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Choose open, resolved or ignored; a note can be up to 1,000 characters." });
    return;
  }
  const q = exceptionQueueTable;
  const [before] = await getDb().select().from(q).where(eq(q.id, params.data.id)).limit(1);
  if (!before || !ALERT_KINDS.includes(before.kind as (typeof ALERT_KINDS)[number])) {
    res.status(404).json({ error: "Alert not found." });
    return;
  }
  const staff = res.locals.staff as { email?: string } | undefined;
  const reopened = body.data.status === "open";
  const note = body.data.note?.trim() || null;
  const [after] = await getDb()
    .update(q)
    .set({
      status: body.data.status,
      resolvedBy: reopened ? null : staff?.email ?? null,
      resolvedAt: reopened ? null : new Date(),
      resolution: reopened ? null : note,
    })
    .where(eq(q.id, before.id))
    .returning();
  await audit(req, res, `finance_alert.${body.data.status}`, before.id, { status: before.status, resolution: before.resolution }, { status: after.status, resolution: after.resolution });
  res.json(UpdateFinanceAlertResponse.parse(alertView(after)));
});

router.get("/checks/reminders", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    notConfigured(res);
    return;
  }
  const t = xeroInvoiceRemindersTable;
  try {
    const rows = await getDb().select().from(t).orderBy(desc(t.sentAt)).limit(500);
    res.json(ListReminderLogResponse.parse({
      items: rows.map((row) => ({
        id: row.id,
        tenantId: row.xeroTenantId,
        company: companyName(row.xeroTenantId) ?? row.xeroTenantId,
        invoiceId: row.xeroInvoiceId,
        invoiceNumber: row.invoiceNumber,
        contactName: row.contactName,
        kind: row.kind,
        stage: row.stage,
        testMode: row.testMode,
        sentTo: row.sentTo,
        status: row.status,
        detail: row.detail,
        requestedBy: row.requestedBy,
        sentAt: row.sentAt.toISOString(),
      })),
    }));
  } catch (error) {
    req.log.error({ err: error }, "Reminder log could not be read");
    res.status(503).json({ error: "The reminder log isn't set up yet: run the database push." });
  }
});

type RunRow = typeof integrationSyncRunsTable.$inferSelect;
const runView = (run: RunRow) => ({
  id: run.id,
  trigger: run.trigger.slice(DAILY_CHECKS_TRIGGER.length) === "manual" ? ("manual" as const) : ("schedule" as const),
  status: run.status,
  startedAt: run.startedAt.toISOString(),
  finishedAt: run.finishedAt?.toISOString() ?? null,
  error: run.error,
  summary: run.details ?? null,
});

router.get("/checks/runs", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    notConfigured(res);
    return;
  }
  try {
    res.json(ListCheckRunsResponse.parse({ items: (await lastCheckRuns(15)).map(runView) }));
  } catch (error) {
    req.log.error({ err: error }, "Check runs could not be read");
    res.status(503).json({ error: "Check runs aren't set up yet: run the database push." });
  }
});

router.post("/checks/runs", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured() || readXeroGatewayEnv().status !== "configured") {
    res.status(503).json({ error: "The database or the Xero gateway is not configured." });
    return;
  }
  const result = await runDailyChecks("manual", req.id !== undefined && req.id !== null ? String(req.id) : null);
  if (result.status === "skipped" || !result.runId) {
    res.status(409).json({ error: result.error ?? "A check run is already in progress." });
    return;
  }
  const [run] = await getDb().select().from(integrationSyncRunsTable).where(eq(integrationSyncRunsTable.id, result.runId)).limit(1);
  res.json(RunChecksNowResponse.parse(runView(run)));
});

export default router;
