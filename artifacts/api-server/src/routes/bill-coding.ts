import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import {
  auditLogTable,
  companyAliasesTable,
  getDb,
  isDatabaseConfigured,
  propertiesTable,
  propertyAliasesTable,
  type BillCodingReview,
  type BillCodingSettings,
} from "@workspace/db";
import {
  CreateCompanyAliasBody,
  CreateCompanyAliasResponse,
  DeleteCompanyAliasParams,
  DeleteCompanyAliasResponse,
  ListCompanyAliasesResponse,
  UpdateCompanyAliasParams,
  UpdateCompanyAliasResponse,
  AnswerBillReviewBody,
  AnswerBillReviewParams,
  AnswerBillReviewResponse,
  CreatePropertyAliasBody,
  CreatePropertyAliasResponse,
  DeletePropertyAliasParams,
  DeletePropertyAliasResponse,
  GetBillCodingSettingsResponse,
  GetTrackingOptionsResponse,
  ListBillReviewsQueryParams,
  ListBillReviewsResponse,
  ListPropertyAliasesResponse,
  UpdateBillCodingSettingsBody,
  UpdateBillCodingSettingsResponse,
  UpdatePropertyAliasBody,
  UpdatePropertyAliasParams,
  UpdatePropertyAliasResponse,
} from "@workspace/api-zod";
import { readXeroGatewayEnv } from "../lib/integrations-env";
import { aliasKey, companyKey, companyName, getCodingSettings, latestReviews, saveAnswers, saveCodingSettings, trackingOptions } from "../lib/bill-coding";

// Bill coding (Finance checks > Bill coding) and the Property aliases page.
// The hourly n8n workflow does the reading and the Xero writes; see lib/bill-coding.ts.

const router: IRouter = Router();
type Json = Record<string, unknown>;
const staffOf = (res: Response) => res.locals.staff as { userId?: string; email?: string } | undefined;
const requestIdOf = (req: Request) => (req.id !== undefined && req.id !== null ? String(req.id) : null);

async function audit(req: Request, res: Response, action: string, tableName: string, recordId: string, before: unknown, after: unknown) {
  const staff = staffOf(res);
  await getDb()
    .insert(auditLogTable)
    .values({ actorEmail: staff?.email ?? null, actorUserId: staff?.userId ?? null, action, tableName, recordId, before: before ?? null, after: after ?? null, requestId: requestIdOf(req), ipAddress: req.ip ?? null })
    .catch((error: unknown) => req.log.error({ err: error }, "Could not write the audit log entry"));
}

const notConfigured = (res: Response) => res.status(503).json({ error: "The database is not configured." });
const setupNeeded = (req: Request, res: Response, error: unknown, what: string) => {
  req.log.error({ err: error }, `${what} could not be read`);
  res.status(503).json({ error: `${what} isn't set up yet: run the database push.` });
};

// --- Reviews -------------------------------------------------------------------------

const VIEWS: Record<string, BillCodingReview["status"][]> = {
  action: ["held", "create_failed", "read_failed"],
  planned: ["shadow_planned", "pending_xero"],
  done: ["created_draft", "updated_draft"],
  ignored: ["not_invoice"],
};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const numOrNull = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

function reviewView(row: BillCodingReview) {
  return {
    id: row.id,
    tenantId: row.xeroTenantId,
    company: row.company,
    billId: row.xeroBillId,
    status: row.status,
    supplierName: row.supplierName,
    invoiceNumber: row.invoiceNumber,
    invoiceDate: row.invoiceDate,
    total: row.total === null ? null : Number(row.total),
    documentType: row.documentType,
    filename: row.filename,
    sourceType: row.sourceType,
    shadowMode: row.shadowMode,
    reasons: row.reasons.map((r) => ({ code: text(r.code), severity: text(r.severity), message: text(r.message) })),
    needs: row.needs.map((n) => ({
      answerKey: text(n.answerKey),
      description: text(n.description),
      serviceDate: text(n.serviceDate),
      amount: numOrNull(n.amount),
      reason: text(n.reason),
      referenceText: text(n.referenceText),
      aliasKey: text(n.aliasKey),
      suggestions: (Array.isArray(n.suggestions) ? n.suggestions : []).map((s: Json) => ({ tenantId: text(s.tenantId), tenantName: text(s.tenantName), option: text(s.option) })),
    })),
    allocation: row.allocation.map((a) => ({ tenantName: text(a.tenantName), lineCount: Number(a.lineCount ?? 0), amount: Number(a.amount ?? 0), pays: text(a.pays) })),
    plans: row.plans.map((p) => {
      const result = (p.result ?? null) as Json | null;
      return { tenantName: text(p.tenantName), total: Number(p.total ?? 0), sourceUpdate: p.sourceUpdate === true, ok: result ? result.ok === true : null, error: result && typeof result.error === "string" ? result.error : null };
    }),
    xeroUrl: `https://go.xero.com/AccountsPayable/View.aspx?invoiceID=${row.xeroBillId}`,
    error: row.error ?? row.extractionError,
    answeredAt: row.answeredAt?.toISOString() ?? null,
    answeredBy: row.answeredBy,
    createdAt: row.createdAt.toISOString(),
  };
}

router.get("/bill-coding/reviews", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    notConfigured(res);
    return;
  }
  const query = ListBillReviewsQueryParams.safeParse(req.query);
  const view = query.success ? query.data.view ?? "action" : "action";
  try {
    const [rows, settings] = await Promise.all([latestReviews(), getCodingSettings()]);
    const count = (key: string) => rows.filter((row) => VIEWS[key].includes(row.status)).length;
    res.json(ListBillReviewsResponse.parse({
      items: rows.filter((row) => view === "all" || VIEWS[view].includes(row.status)).slice(0, 300).map(reviewView),
      counts: { action: count("action"), planned: count("planned"), done: count("done"), ignored: count("ignored") },
      shadowMode: settings.shadowMode,
    }));
  } catch (error) {
    setupNeeded(req, res, error, "Bill coding");
  }
});

router.post("/bill-coding/reviews/:id/answers", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    notConfigured(res);
    return;
  }
  const params = AnswerBillReviewParams.safeParse(req.params);
  const body = AnswerBillReviewBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Choose a company and a property (or no property) for each line." });
    return;
  }
  const result = await saveAnswers(params.data.id, body.data.answers.map((a) => ({ answerKey: a.answerKey, tenantId: a.tenantId.toLowerCase(), option: a.option?.trim() || null, remember: a.remember })), staffOf(res), requestIdOf(req));
  if ("error" in result) {
    res.status(result.status ?? 400).json({ error: result.error });
    return;
  }
  res.json(AnswerBillReviewResponse.parse({ ok: true }));
});

// --- Settings and tracking options ---------------------------------------------------------

const settingsView = (s: BillCodingSettings) => ({
  shadowMode: s.shadowMode,
  autoSplit: s.autoSplit,
  maxBillsPerRun: s.maxBillsPerRun,
  checkStatuses: s.checkStatuses,
  trackingCategory: s.trackingCategory,
  payingCompanyName: s.payingCompanyName,
  defaultAccountCode: s.defaultAccountCode,
  categoryAccountMap: s.categoryAccountMap ?? {},
  legibilityMin: Number(s.legibilityMin),
  dateOutlierDays: s.dateOutlierDays,
  dupLineMinAmount: s.dupLineMinAmount,
  reprocessHeld: s.reprocessHeld,
  updatedBy: s.updatedBy,
  updatedAt: s.updatedAt.toISOString(),
});

router.get("/bill-coding/settings", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    notConfigured(res);
    return;
  }
  try {
    res.json(GetBillCodingSettingsResponse.parse(settingsView(await getCodingSettings())));
  } catch (error) {
    setupNeeded(req, res, error, "Bill coding settings");
  }
});

router.put("/bill-coding/settings", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    notConfigured(res);
    return;
  }
  const body = UpdateBillCodingSettingsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Check the settings: numbers must be in range and account codes short." });
    return;
  }
  const { legibilityMin, ...rest } = body.data;
  const { before, after } = await saveCodingSettings({ ...rest, ...(legibilityMin !== undefined ? { legibilityMin: legibilityMin.toFixed(2) } : {}) }, staffOf(res)?.email ?? null);
  await audit(req, res, "bill_coding_settings.update", "bill_coding_settings", after.id, settingsView(before), settingsView(after));
  res.json(UpdateBillCodingSettingsResponse.parse(settingsView(after)));
});

router.get("/bill-coding/tracking-options", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured() || readXeroGatewayEnv().status !== "configured") {
    res.status(503).json({ error: "The database or the Xero gateway is not configured." });
    return;
  }
  try {
    res.json(GetTrackingOptionsResponse.parse(await trackingOptions(req.query.refresh === "1")));
  } catch (error) {
    req.log.warn({ err: error }, "Tracking options could not be read");
    res.status(503).json({ error: "Xero's property options could not be read; try again shortly." });
  }
});

// --- Property aliases ------------------------------------------------------------------

type AliasRow = typeof propertyAliasesTable.$inferSelect;
const aliasView = (row: AliasRow, propertyName: string | null) => ({
  id: row.id,
  kind: row.kind,
  alias: row.alias,
  normalizedAlias: row.normalizedAlias,
  tenantId: row.xeroTenantId,
  company: companyName(row.xeroTenantId),
  option: row.xeroTrackingOption,
  overhead: row.overhead,
  propertyName,
  source: row.source,
  createdBy: row.createdBy,
  updatedAt: row.updatedAt.toISOString(),
});

router.get("/property-aliases", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    notConfigured(res);
    return;
  }
  try {
    const rows = await getDb()
      .select({ alias: propertyAliasesTable, propertyName: propertiesTable.name })
      .from(propertyAliasesTable)
      .leftJoin(propertiesTable, eq(propertiesTable.id, propertyAliasesTable.propertyId));
    const items = rows.map((row) => aliasView(row.alias, row.propertyName)).sort((a, b) => a.kind.localeCompare(b.kind) * -1 || a.alias.localeCompare(b.alias, "en-GB", { numeric: true }));
    res.json(ListPropertyAliasesResponse.parse({ items }));
  } catch (error) {
    setupNeeded(req, res, error, "Property aliases");
  }
});

// The target must be a known company and, unless it's an overhead, one of its
// Property options in Xero (when Xero can be read).
async function checkTarget(tenantId: string, option: string | null): Promise<string | null> {
  if (!companyName(tenantId)) return "Choose one of the five companies.";
  if (option === null || readXeroGatewayEnv().status !== "configured") return null;
  try {
    const options = await trackingOptions();
    const company = options.companies.find((c) => c.tenantId === tenantId);
    if (company && company.options.length && !company.options.includes(option)) return `"${option}" is not a Property option in ${company.name}'s Xero.`;
  } catch {
    // Xero unreachable: accept the option as typed.
  }
  return null;
}

const isUniqueViolation = (error: unknown) => (error as { code?: string; cause?: { code?: string } })?.code === "23505" || (error as { cause?: { code?: string } })?.cause?.code === "23505";

router.post("/property-aliases", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    notConfigured(res);
    return;
  }
  const body = CreatePropertyAliasBody.safeParse(req.body);
  const normalized = body.success ? aliasKey(body.data.alias) : "";
  if (!body.success || !normalized) {
    res.status(400).json({ error: "Write the property as it appears on invoices (with letters or numbers), and choose a company." });
    return;
  }
  const tenantId = body.data.tenantId.toLowerCase();
  const option = body.data.option?.trim() || null;
  const problem = await checkTarget(tenantId, option);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }
  try {
    const [row] = await getDb()
      .insert(propertyAliasesTable)
      .values({ kind: "text", alias: body.data.alias.trim(), normalizedAlias: normalized, xeroTenantId: tenantId, xeroTrackingOption: option, overhead: option === null, source: "manual", verified: true, createdBy: staffOf(res)?.email ?? null })
      .returning();
    await audit(req, res, "property_alias.create", "property_aliases", row.id, null, row);
    res.status(201).json(CreatePropertyAliasResponse.parse(aliasView(row, null)));
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: `An alias reading "${normalized}" already exists; edit that one instead.` });
      return;
    }
    throw error;
  }
});

router.put("/property-aliases/:id", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    notConfigured(res);
    return;
  }
  const params = UpdatePropertyAliasParams.safeParse(req.params);
  const body = UpdatePropertyAliasBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Write the property and choose a company." });
    return;
  }
  const [before] = await getDb().select().from(propertyAliasesTable).where(eq(propertyAliasesTable.id, params.data.id)).limit(1);
  if (!before) {
    res.status(404).json({ error: "Alias not found." });
    return;
  }
  const tenantId = body.data.tenantId.toLowerCase();
  const option = body.data.option?.trim() || null;
  const problem = await checkTarget(tenantId, option);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }
  // A bill line answer keeps its key; only its target changes.
  const normalized = before.kind === "line" ? before.normalizedAlias : aliasKey(body.data.alias);
  if (!normalized) {
    res.status(400).json({ error: "Write the property as it appears on invoices (with letters or numbers)." });
    return;
  }
  try {
    const [after] = await getDb()
      .update(propertyAliasesTable)
      .set({
        ...(before.kind === "line" ? {} : { alias: body.data.alias.trim(), normalizedAlias: normalized }),
        xeroTenantId: tenantId,
        xeroTrackingOption: option,
        overhead: option === null,
        verified: true,
      })
      .where(eq(propertyAliasesTable.id, before.id))
      .returning();
    await audit(req, res, "property_alias.update", "property_aliases", after.id, before, after);
    res.json(UpdatePropertyAliasResponse.parse(aliasView(after, null)));
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: `Another alias already reads "${normalized}".` });
      return;
    }
    throw error;
  }
});

router.delete("/property-aliases/:id", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    notConfigured(res);
    return;
  }
  const params = DeletePropertyAliasParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid alias." });
    return;
  }
  const [before] = await getDb().delete(propertyAliasesTable).where(eq(propertyAliasesTable.id, params.data.id)).returning();
  if (!before) {
    res.status(404).json({ error: "Alias not found." });
    return;
  }
  await audit(req, res, "property_alias.delete", "property_aliases", before.id, before, null);
  res.json(DeletePropertyAliasResponse.parse({ ok: true }));
});

// --- Company aliases --------------------------------------------------------------------

type CompanyAliasRow = typeof companyAliasesTable.$inferSelect;
const companyAliasView = (row: CompanyAliasRow) => ({
  id: row.id,
  alias: row.alias,
  normalizedAlias: row.normalizedAlias,
  tenantId: row.xeroTenantId,
  company: companyName(row.xeroTenantId),
  notes: row.notes,
  createdBy: row.createdBy,
  updatedAt: row.updatedAt.toISOString(),
});

router.get("/company-aliases", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    notConfigured(res);
    return;
  }
  try {
    const rows = await getDb().select().from(companyAliasesTable);
    res.json(ListCompanyAliasesResponse.parse({ items: rows.map(companyAliasView).sort((a, b) => a.alias.localeCompare(b.alias, "en-GB")) }));
  } catch (error) {
    setupNeeded(req, res, error, "Company aliases");
  }
});

function companyAliasInput(raw: unknown) {
  const body = CreateCompanyAliasBody.safeParse(raw);
  if (!body.success) return { error: "Write the company name as it appears on invoices and choose a company." };
  const normalized = companyKey(body.data.alias);
  const tenantId = body.data.tenantId.toLowerCase();
  if (!normalized) return { error: "Write the company name with letters or numbers (Ltd and Limited are ignored)." };
  if (!companyName(tenantId)) return { error: "Choose one of the five companies." };
  return { values: { alias: body.data.alias.trim(), normalizedAlias: normalized, xeroTenantId: tenantId, notes: body.data.notes?.trim() || null } };
}

router.post("/company-aliases", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    notConfigured(res);
    return;
  }
  const input = companyAliasInput(req.body);
  if (!input.values) {
    res.status(400).json({ error: input.error });
    return;
  }
  try {
    const [row] = await getDb().insert(companyAliasesTable).values({ ...input.values, createdBy: staffOf(res)?.email ?? null }).returning();
    await audit(req, res, "company_alias.create", "company_aliases", row.id, null, row);
    res.status(201).json(CreateCompanyAliasResponse.parse(companyAliasView(row)));
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: `"${input.values.normalizedAlias}" is already a company alias; edit that one instead.` });
      return;
    }
    throw error;
  }
});

router.put("/company-aliases/:id", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    notConfigured(res);
    return;
  }
  const params = UpdateCompanyAliasParams.safeParse(req.params);
  const input = companyAliasInput(req.body);
  if (!params.success || !input.values) {
    res.status(400).json({ error: input.error ?? "Invalid alias." });
    return;
  }
  const [before] = await getDb().select().from(companyAliasesTable).where(eq(companyAliasesTable.id, params.data.id)).limit(1);
  if (!before) {
    res.status(404).json({ error: "Alias not found." });
    return;
  }
  try {
    const [after] = await getDb().update(companyAliasesTable).set(input.values).where(eq(companyAliasesTable.id, before.id)).returning();
    await audit(req, res, "company_alias.update", "company_aliases", after.id, before, after);
    res.json(UpdateCompanyAliasResponse.parse(companyAliasView(after)));
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: `Another company alias already reads "${input.values.normalizedAlias}".` });
      return;
    }
    throw error;
  }
});

router.delete("/company-aliases/:id", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    notConfigured(res);
    return;
  }
  const params = DeleteCompanyAliasParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid alias." });
    return;
  }
  const [before] = await getDb().delete(companyAliasesTable).where(eq(companyAliasesTable.id, params.data.id)).returning();
  if (!before) {
    res.status(404).json({ error: "Alias not found." });
    return;
  }
  await audit(req, res, "company_alias.delete", "company_aliases", before.id, before, null);
  res.json(DeleteCompanyAliasResponse.parse({ ok: true }));
});

export default router;
