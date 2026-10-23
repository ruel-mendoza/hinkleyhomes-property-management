import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  auditLogTable,
  billCodingReviewsTable,
  billCodingSettingsTable,
  companyAliasesTable,
  documentReadingsTable,
  getDb,
  propertyAliasesTable,
  type BillCodingReview,
  type BillCodingSettings,
} from "@workspace/db";
import { COMPANIES } from "../routes/money";
import { checkAndRecordBills } from "./bill-checks-store";
import type { IncomingBill } from "./bill-checks";
import {
  aliasKey,
  billText,
  companyKey,
  dupKey,
  invoiceFingerprint,
  normaliseExtraction,
  pickBills,
  planBill,
  trackingProps,
  xeroBillBody,
  type CodingSettings,
  type CodingTarget,
  type CompanyAlias,
  type LastReview,
  type Org,
  type Reason,
  type TextAlias,
  type XeroBill,
} from "./bill-coding-rules";
import { xeroGatewayRequest } from "./xero-gateway";

// Bill coding (the n8n "Route A: Xero-first" workflow, PMS-controlled).
// 1. n8n asks for the bills to check (codingPlan): the app reads draft and
//    submitted supplier bills through the Xero gateway and skips anything
//    already coded, handled, duplicated or waiting for an answer.
// 2. n8n downloads each bill's file, reads it with the AI (asking first for a
//    saved reading of the same file) and sends the reading (recordReview). The
//    app keeps the reading, checks the bank details and prices, matches every
//    line to a property and records the review: held for a person, planned
//    (shadow mode) or a draft bill for n8n to write.
// 3. n8n writes the draft bill in Xero and reports back (recordResult).
// Held bills are answered on the Finance checks page; answers are kept in
// property_aliases and the next hourly run checks the bill again.

type Json = Record<string, unknown>;
const SETTINGS_ID = "default";

const asRecord = (value: unknown): Json => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.map(asRecord) : []);
const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : "");
const orgs: Org[] = COMPANIES.map((company) => ({ tenantId: company.tenantId, tenantName: company.name }));
export const companyName = (tenantId: string | null | undefined) => orgs.find((org) => org.tenantId === tenantId)?.tenantName ?? null;

// --- Settings -----------------------------------------------------------------------

export async function getCodingSettings(): Promise<BillCodingSettings> {
  const db = getDb();
  const t = billCodingSettingsTable;
  const [row] = await db.select().from(t).where(eq(t.id, SETTINGS_ID)).limit(1);
  if (row) return row;
  // First use: shadow mode on, so nothing is written to Xero.
  const [created] = await db.insert(t).values({ id: SETTINGS_ID }).onConflictDoNothing().returning();
  return created ?? (await db.select().from(t).where(eq(t.id, SETTINGS_ID)).limit(1))[0];
}

export type CodingSettingsPatch = Partial<Pick<BillCodingSettings,
  "shadowMode" | "autoSplit" | "maxBillsPerRun" | "checkStatuses" | "trackingCategory" | "payingCompanyName" | "defaultAccountCode" | "categoryAccountMap" | "legibilityMin" | "dateOutlierDays" | "dupLineMinAmount" | "reprocessHeld">>;

export async function saveCodingSettings(patch: CodingSettingsPatch, updatedBy: string | null) {
  const before = await getCodingSettings();
  const [after] = await getDb().update(billCodingSettingsTable).set({ ...patch, updatedBy }).where(eq(billCodingSettingsTable.id, SETTINGS_ID)).returning();
  return { before, after };
}

const rulesSettings = (s: BillCodingSettings): CodingSettings => ({
  autoSplit: s.autoSplit,
  payingCompanyName: s.payingCompanyName,
  trackingCategory: s.trackingCategory,
  legibilityMin: Number(s.legibilityMin),
  dateOutlierDays: s.dateOutlierDays,
  dupLineMinAmount: s.dupLineMinAmount,
  defaultAccountCode: s.defaultAccountCode,
  categoryAccountMap: s.categoryAccountMap ?? {},
});

// --- Xero tracking options (cached 10 minutes) ---------------------------------------

type OrgCategories = Org & { categories: Json[] | null; error: string | null };
let trackingCache: { at: number; orgs: OrgCategories[] } | null = null;

export async function trackingCategories(refresh = false): Promise<OrgCategories[]> {
  if (!refresh && trackingCache && Date.now() - trackingCache.at < 10 * 60_000) return trackingCache.orgs;
  const result = await Promise.all(
    orgs.map(async (org) => {
      try {
        const response = await xeroGatewayRequest({ tenantId: org.tenantId, resource: "trackingCategories" });
        if (!response.ok) return { ...org, categories: null, error: `Xero returned HTTP ${response.status}` };
        return { ...org, categories: list(asRecord(response.data).TrackingCategories), error: null };
      } catch (error) {
        return { ...org, categories: null, error: (error as Error).message };
      }
    }),
  );
  if (result.every((org) => !org.error)) trackingCache = { at: Date.now(), orgs: result };
  return result;
}

// Property options per company, for the pickers on the app's pages.
export async function trackingOptions(refresh = false) {
  const settings = await getCodingSettings();
  const categories = await trackingCategories(refresh);
  const { props, orgIssues } = trackingProps(categories, settings.trackingCategory);
  return {
    trackingCategory: settings.trackingCategory,
    problems: orgIssues,
    companies: orgs.map((org) => ({ tenantId: org.tenantId, name: org.tenantName, options: props.filter((p) => p.tenantId === org.tenantId).map((p) => p.option).sort((a, b) => a.localeCompare(b, "en-GB", { numeric: true })) })),
  };
}

// --- Aliases ------------------------------------------------------------------------

async function loadAliases(category: string) {
  const rows = await getDb().select().from(propertyAliasesTable);
  const aliases: TextAlias[] = [];
  const lineAnswers = new Map<string, CodingTarget>();
  let answersAt = 0;
  for (const row of rows) {
    answersAt = Math.max(answersAt, row.updatedAt.getTime());
    const tenantName = companyName(row.xeroTenantId);
    if (!row.xeroTenantId || !tenantName || (!row.xeroTrackingOption && !row.overhead)) continue;
    const target: CodingTarget = { tenantId: row.xeroTenantId, tenantName, category, option: row.overhead ? null : row.xeroTrackingOption };
    if (row.kind === "line") lineAnswers.set(row.normalizedAlias, target);
    else aliases.push({ tokens: row.normalizedAlias.split(" ").filter(Boolean), target });
  }
  return { aliases, lineAnswers, answersAt };
}

// The five companies' own names, plus the spellings kept in company_aliases.
async function loadCompanyAliases(): Promise<CompanyAlias[]> {
  const rows = await getDb().select().from(companyAliasesTable);
  const own = orgs.map((org) => ({ key: companyKey(org.tenantName), tenantId: org.tenantId }));
  return [...own, ...rows.map((row) => ({ key: row.normalizedAlias, tenantId: row.xeroTenantId }))]
    .filter((a) => a.key && companyName(a.tenantId))
    .map((a) => ({ tokens: a.key.split(" "), tenantId: a.tenantId, tenantName: companyName(a.tenantId)! }));
}

// --- 1. Bills to check -----------------------------------------------------------------

function xeroBill(org: Org, b: Json): XeroBill {
  const invoiceId = String(b.InvoiceID).toLowerCase();
  return {
    key: `xero::${org.tenantId}::${invoiceId}`,
    tenantId: org.tenantId,
    tenantName: org.tenantName,
    invoiceId,
    number: str(b.InvoiceNumber),
    status: str(b.Status),
    supplierName: str(asRecord(b.Contact).Name),
    currency: str(b.CurrencyCode) || "GBP",
    date: String(b.DateString ?? "").slice(0, 10),
    dueDate: String(b.DueDateString ?? "").slice(0, 10),
    total: typeof b.Total === "number" ? b.Total : null,
    lineAmountTypes: str(b.LineAmountTypes),
    url: `https://go.xero.com/AccountsPayable/View.aspx?invoiceID=${invoiceId}`,
    lines: list(b.LineItems).map((l) => ({ description: str(l.Description), lineAmount: typeof l.LineAmount === "number" ? l.LineAmount : null, accountCode: str(l.AccountCode), taxType: str(l.TaxType) })),
  };
}

async function reviewState() {
  const r = billCodingReviewsTable;
  const rows = await getDb()
    .select({ key: r.idempotencyKey, status: r.status, createdAt: r.createdAt, supplier: r.supplierName, number: r.invoiceNumber, total: r.total, ids: r.xeroInvoiceIds })
    .from(r)
    .orderBy(desc(r.createdAt));
  const latest = new Map<string, LastReview>();
  const handled = new Map<string, string>();
  const ownInvoiceIds = new Set<string>();
  for (const row of rows) {
    const current = latest.get(row.key);
    if (!current) latest.set(row.key, { status: row.status, at: row.createdAt.getTime(), readFailures: 0 });
    if (row.status === "created_draft" || row.status === "updated_draft") for (const id of row.ids) ownInvoiceIds.add(id.toLowerCase());
    if (row.supplier && row.number && row.total !== null && ["created_draft", "updated_draft", "shadow_planned", "held"].includes(row.status)) handled.set(dupKey(row.supplier, row.number, row.total), row.key);
  }
  // Consecutive read failures, newest first, per bill.
  const streak = new Map<string, number>();
  const broken = new Set<string>();
  for (const row of rows) {
    if (broken.has(row.key)) continue;
    if (row.status === "read_failed") streak.set(row.key, (streak.get(row.key) ?? 0) + 1);
    else broken.add(row.key);
  }
  for (const [key, review] of latest) if (review.status === "read_failed") review.readFailures = streak.get(key) ?? 1;
  return { latest, handled, ownInvoiceIds };
}

export async function codingPlan() {
  const settings = await getCodingSettings();
  const statuses = settings.checkStatuses.map((s) => s.trim().toUpperCase()).filter(Boolean);
  const where = `Type=="ACCPAY"`;
  const fetched: { org: Org; bill: Json }[] = [];
  const problems: string[] = [];
  for (const org of orgs) {
    try {
      for (let page = 1; page <= 10; page++) {
        const response = await xeroGatewayRequest({ tenantId: org.tenantId, resource: "invoices", query: { where, Statuses: statuses.join(","), page, pageSize: 100 } });
        if (!response.ok) throw new Error(response.status === 429 ? "Xero is rate limiting" : `Xero returned HTTP ${response.status}`);
        const batch = list(asRecord(response.data).Invoices);
        fetched.push(...batch.map((bill) => ({ org, bill })));
        if (batch.length < 100) break;
      }
    } catch (error) {
      problems.push(`${org.tenantName}: ${(error as Error).message}`);
    }
  }
  const state = await reviewState();
  const { answersAt } = await loadAliases(settings.trackingCategory);
  const { picked, found, skipped } = pickBills(fetched, {
    statuses,
    trackingCategory: settings.trackingCategory,
    maxBills: settings.maxBillsPerRun,
    reprocessHeld: settings.reprocessHeld,
    shadowMode: settings.shadowMode,
    ownInvoiceIds: state.ownInvoiceIds,
    latest: state.latest,
    handled: state.handled,
    answersAt,
    now: Date.now(),
  });
  return {
    shadow_mode: settings.shadowMode,
    found,
    skipped,
    problems,
    bills: picked.map(({ org, bill }) => {
      const xero = xeroBill(org, bill);
      return {
        key: xero.key,
        xero,
        message_id: `xero-${xero.invoiceId}`,
        subject: `Xero bill ${xero.number || "(no number)"} - ${xero.supplierName} (${org.tenantName})`,
        from: xero.supplierName,
        received_at: xero.date,
        filename: `xero-bill-${(xero.number || xero.invoiceId).replace(/[^\w.-]+/g, "_")}.txt`,
        want_file: bill.HasAttachments === true,
        xero_text: billText(org, bill),
      };
    }),
  };
}

// --- 2. A reading of one bill -----------------------------------------------------------

export async function savedReading(docHash: string) {
  const [row] = await getDb().select().from(documentReadingsTable).where(eq(documentReadingsTable.docHash, docHash)).limit(1);
  return row ?? null;
}

export type ReviewInput = {
  xero: XeroBill;
  docHash: string;
  fromCache: boolean;
  provider: string;
  model: string;
  extraction: Json | null;
  extractionError: string | null;
  source: { filename: string; mimeType: string; sourceType: string };
};

export type PlannedWrite = { plan_index: number; tenant_id: string; tenant_name: string; update_id: string; idem_key: string; xero_body: Json; attach: boolean; plan_total: number };

export async function recordReview(input: ReviewInput, requestId: string | null) {
  const db = getDb();
  const settings = await getCodingSettings();
  const xr = input.xero;
  const extraction = normaliseExtraction(input.extraction ? structuredClone(input.extraction) : null);
  const base = {
    idempotencyKey: xr.key,
    xeroTenantId: xr.tenantId,
    xeroBillId: xr.invoiceId,
    company: xr.tenantName,
    supplierName: xr.supplierName || null,
    invoiceNumber: xr.number || null,
    currency: xr.currency,
    total: xr.total === null ? null : xr.total.toFixed(2),
    sourceType: input.source.sourceType || null,
    filename: input.source.filename || null,
    docHash: input.docHash || null,
    provider: input.provider || null,
    model: input.model || null,
    shadowMode: settings.shadowMode,
  };

  // Each document is read once.
  if (!input.fromCache && extraction && !input.extractionError && input.docHash) {
    await db.insert(documentReadingsTable).values({ docHash: input.docHash, extraction, model: input.model || null, provider: input.provider || null }).onConflictDoNothing();
  }
  if (input.extractionError || !extraction) {
    const [row] = await db.insert(billCodingReviewsTable).values({ ...base, status: "read_failed", extractionError: (input.extractionError ?? "No reading returned").slice(0, 1000) }).returning({ id: billCodingReviewsTable.id });
    return { action: "none" as const, status: "read_failed", review_id: row.id, plans: [] as PlannedWrite[] };
  }
  if (extraction.is_invoice !== true) {
    const [row] = await db.insert(billCodingReviewsTable).values({ ...base, status: "not_invoice", documentType: str(extraction.document_type) || "other" }).returning({ id: billCodingReviewsTable.id });
    return { action: "none" as const, status: "not_invoice", review_id: row.id, plans: [] as PlannedWrite[] };
  }

  const fingerprint = invoiceFingerprint(extraction, `xero-${xr.invoiceId}`, input.source.filename);
  const r = billCodingReviewsTable;
  const [done] = await db.select({ id: r.id }).from(r).where(and(eq(r.fingerprint, fingerprint), inArray(r.status, ["created_draft", "updated_draft"]))).limit(1);
  if (done) return { action: "none" as const, status: "already_written", review_id: done.id, plans: [] as PlannedWrite[] };

  const { props, orgIssues } = trackingProps(await trackingCategories(), settings.trackingCategory);
  const { aliases, lineAnswers } = await loadAliases(settings.trackingCategory);
  const rules = rulesSettings(settings);
  const companyAliases = await loadCompanyAliases();
  const plan = planBill({ extraction, xero: xr, messageId: `xero-${xr.invoiceId}` }, { settings: rules, props, orgIssues, aliases, lineAnswers, orgs, companyAliases });

  // Bank details and prices: the reading has the supplier's bank account, which Xero doesn't hold.
  const extra: Reason[] = [];
  try {
    const bank = asRecord(asRecord(extraction.supplier).bank);
    const bill: IncomingBill = {
      tenantId: xr.tenantId,
      company: xr.tenantName,
      billId: xr.invoiceId,
      number: xr.number || plan.invoiceNumber || null,
      supplier: xr.supplierName || plan.supplierName || "Unknown supplier",
      contactId: null,
      date: xr.date || plan.invoiceDate || null,
      total: xr.total,
      subTotal: null,
      currency: xr.currency.toUpperCase(),
      status: xr.status.toUpperCase() || "DRAFT",
      lineAmountTypes: xr.lineAmountTypes === "Inclusive" || xr.lineAmountTypes === "NoTax" ? xr.lineAmountTypes : "Exclusive",
      lines: xr.lines.map((l) => ({ description: l.description, quantity: null, unitAmount: null, lineAmount: l.lineAmount, taxAmount: null, accountCode: l.accountCode || null })),
      bank: { accountName: str(bank.account_name) || null, sortCode: str(bank.sort_code) || null, accountNumber: str(bank.account_number) || null, iban: str(bank.iban) || null },
    };
    const flags = await checkAndRecordBills([bill], undefined, requestId);
    for (const flag of flags) extra.push({ code: flag.code, severity: flag.severity === "high" ? "high" : flag.severity === "warn" ? "warn" : "info", message: flag.message });
  } catch (error) {
    extra.push({ code: "bank_check_failed", severity: "warn", message: `The bank and price checks could not run: ${(error as Error).message}` });
  }

  const reasons = [...plan.holds, ...plan.flags, ...extra];
  const live = plan.planType === "ready" && !settings.shadowMode;
  const writes: PlannedWrite[] = live
    ? plan.groups.map((group, index) => {
        const { body, idempotencyKey } = xeroBillBody(plan, group, xr, fingerprint, rules);
        return { plan_index: index, tenant_id: group.tenantId, tenant_name: group.tenantName, update_id: group.updateId, idem_key: idempotencyKey, xero_body: body, attach: !group.sourceUpdate && input.source.sourceType === "attachment", plan_total: group.total };
      })
    : [];
  const status = plan.planType === "held" ? "held" : live ? "pending_xero" : "shadow_planned";
  const [row] = await db
    .insert(billCodingReviewsTable)
    .values({
      ...base,
      status,
      fingerprint,
      supplierName: xr.supplierName || plan.supplierName || null,
      invoiceNumber: plan.invoiceNumber || xr.number || null,
      invoiceDate: plan.invoiceDate || xr.date || null,
      currency: plan.currency,
      total: (plan.planType === "held" ? plan.invoiceTotal : plan.groups.reduce((sum, g) => sum + g.total, 0)).toFixed(2),
      documentType: plan.documentType,
      legibility: plan.legibility === null ? null : plan.legibility.toFixed(3),
      reasons,
      needs: plan.needs,
      allocation: plan.allocation,
      plans: plan.groups.map((group, index) => ({ index, tenantId: group.tenantId, tenantName: group.tenantName, sourceUpdate: group.sourceUpdate, total: group.total, lines: group.lines, result: null })),
    })
    .returning({ id: billCodingReviewsTable.id });
  return { action: plan.planType === "held" ? ("held" as const) : live ? ("write" as const) : ("shadow" as const), status, review_id: row.id, plans: writes.map((write) => ({ ...write, review_id: row.id })) };
}

// --- 3. What n8n did in Xero ------------------------------------------------------------

export type WriteResult = { reviewId: string; planIndex: number; ok: boolean; xeroInvoiceId: string | null; xeroStatus: string | null; error: string | null; attachment: string | null };

export async function recordResult(result: WriteResult) {
  return getDb().transaction(async (tx) => {
    const r = billCodingReviewsTable;
    const [review] = await tx.select().from(r).where(eq(r.id, result.reviewId)).for("update").limit(1);
    if (!review) return null;
    const plans = review.plans.map((plan) => (Number(plan.index) === result.planIndex ? { ...plan, result: { ok: result.ok, xeroInvoiceId: result.xeroInvoiceId, xeroStatus: result.xeroStatus, error: result.error, attachment: result.attachment, at: new Date().toISOString() } } : plan));
    const results = plans.map((plan) => plan.result as { ok: boolean; xeroInvoiceId: string | null; error: string | null } | null);
    const complete = results.every(Boolean);
    const failed = results.some((res) => res && !res.ok);
    const status = !complete ? review.status : failed ? "create_failed" : plans.some((plan) => !plan.sourceUpdate) ? "created_draft" : "updated_draft";
    const [updated] = await tx
      .update(r)
      .set({
        plans,
        status,
        xeroInvoiceIds: results.filter((res) => res?.ok && res.xeroInvoiceId).map((res) => res!.xeroInvoiceId!.toLowerCase()),
        error: results.map((res) => res?.error).filter(Boolean).join("; ").slice(0, 1000) || null,
      })
      .where(eq(r.id, review.id))
      .returning();
    return updated;
  });
}

// --- Staff: reviews and answers -----------------------------------------------------------

export async function latestReviews(days = 120): Promise<BillCodingReview[]> {
  const r = billCodingReviewsTable;
  const rows = await getDb().select().from(r).where(gte(r.createdAt, new Date(Date.now() - days * 86_400_000))).orderBy(desc(r.createdAt));
  const seen = new Set<string>();
  return rows.filter((row) => (seen.has(row.idempotencyKey) ? false : (seen.add(row.idempotencyKey), true)));
}

export type Answer = { answerKey: string; tenantId: string; option: string | null; remember: boolean };

export async function saveAnswers(reviewId: string, answers: Answer[], staff: { email?: string; userId?: string } | undefined, requestId: string | null) {
  const db = getDb();
  const [review] = await db.select().from(billCodingReviewsTable).where(eq(billCodingReviewsTable.id, reviewId)).limit(1);
  if (!review) return { error: "Review not found.", status: 404 as const };
  const needs = new Map(review.needs.map((need) => [String(need.answerKey), need]));
  for (const answer of answers) {
    if (!needs.has(answer.answerKey)) return { error: "An answer doesn't match a line of this bill; reload the page.", status: 400 as const };
    if (!companyName(answer.tenantId)) return { error: "Unknown company.", status: 400 as const };
  }
  const a = propertyAliasesTable;
  await db.transaction(async (tx) => {
    for (const answer of answers) {
      const need = needs.get(answer.answerKey)!;
      const target = { xeroTenantId: answer.tenantId, xeroTrackingOption: answer.option, overhead: answer.option === null };
      const rows: { kind: "line" | "text"; alias: string; normalizedAlias: string; source: "invoice" | "xero" }[] = [
        { kind: "line", alias: `${String(need.description ?? "").slice(0, 200)} (${review.supplierName ?? "supplier"} ${review.invoiceNumber ?? ""})`.trim(), normalizedAlias: answer.answerKey, source: "invoice" },
      ];
      const key = String(need.aliasKey ?? "");
      if (answer.remember && key) rows.push({ kind: "text", alias: String(need.referenceText ?? key), normalizedAlias: key, source: "xero" });
      for (const row of rows) {
        const [saved] = await tx
          .insert(a)
          .values({ ...row, ...target, createdBy: staff?.email ?? null })
          .onConflictDoUpdate({ target: a.normalizedAlias, set: { ...target, updatedAt: sql`now()` } })
          .returning();
        await tx.insert(auditLogTable).values({ actorEmail: staff?.email ?? null, actorUserId: staff?.userId ?? null, action: "property_alias.answer", tableName: "property_aliases", recordId: saved.id, before: null, after: saved, requestId });
      }
    }
    await tx.update(billCodingReviewsTable).set({ answeredAt: new Date(), answeredBy: staff?.email ?? null }).where(eq(billCodingReviewsTable.id, review.id));
  });
  return { ok: true as const };
}

export { aliasKey, companyKey };
