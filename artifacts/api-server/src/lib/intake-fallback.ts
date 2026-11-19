import { and, desc, eq, inArray, isNull, gte, sql } from "drizzle-orm";
import {
  companyAliasesTable,
  documentReadingsTable,
  getDb,
  integrationSyncRunsTable,
  invoiceIntakeChecksTable,
  invoiceIntakeFilesTable,
  invoiceIntakeReviewsTable,
  isDatabaseConfigured,
} from "@workspace/db";
import { readIntakeFallbackEnv } from "./integrations-env";
import { logger } from "./logger";
import { graphGet, graphSend, graphUpload } from "./ms-graph";
import { readInvoice } from "./intake-ai";
import {
  INTAKE_CONFIG,
  XERO_ORGANISATION_NAMES,
  aiRequest,
  amount,
  checkEmail,
  invoiceFiles,
  invoiceLink,
  isFromAccountsAndNotForward,
  normaliseExtraction,
  replyBody,
  shadowMail,
  splitDocuments,
  validDate,
  type CheckResult,
  type Extraction,
  type GraphAttachment,
  type GraphMessage,
  type IntakeHistoryRow,
  type Mode,
  type ReadDocument,
} from "./intake-rules";

// Backup for the n8n intake check of accounts@. Any email n8n has not dealt
// with 15 minutes after it arrived (no "n8n:" category in Outlook and no row in
// invoice_intake_checks) is checked here instead, with the same rules
// (lib/intake-rules.ts), the same AI reading cache and the same outputs:
// Outlook category, bounce by mode, review row, SharePoint copy, invoice link.
// Rows it writes have checked_by = "pms". The email is claimed in
// invoice_intake_checks before anything is sent, so n8n and the app never both act.

const GRACE_MINUTES = 15;
const LOOKBACK_DAYS = 3;
const MAX_PER_RUN = 10;
const INTERVAL_MS = 10 * 60_000;
const SENT_ACTIONS = ["bounce_sent", "draft_created", "shadow_proposed"];

export type IntakeFallbackRun = {
  status: "succeeded" | "failed" | "skipped";
  checkedAt: string;
  waiting: number;
  checked: number;
  verdicts: Record<string, number>;
  warnings: string[];
  error: string | null;
};

let running: Promise<IntakeFallbackRun> | null = null;
let lastRun: IntakeFallbackRun | null = null;
// Emails with nothing to read are tagged "not an invoice" (as n8n does) but not logged. If the
// tag can't be set, remember them so they aren't fetched every run.
const nothingToRead = new Set<string>();
// Logged emails that are missing their Outlook tag (the tag failed, e.g. Microsoft throttling)
// get it back from the logged verdict. Cheap, so more of these are done per run.
const MAX_RETAG_PER_RUN = 50;

const upn = () => encodeURIComponent(INTAKE_CONFIG.accountsMailbox);

export function runIntakeFallback(trigger: "schedule" | "manual"): Promise<IntakeFallbackRun> {
  if (running) return running.then((run) => ({ ...run, status: "skipped" as const }));
  running = run(trigger).finally(() => {
    running = null;
  });
  return running;
}

async function run(trigger: "schedule" | "manual"): Promise<IntakeFallbackRun> {
  const env = readIntakeFallbackEnv();
  const started = new Date();
  const result: IntakeFallbackRun = { status: "succeeded", checkedAt: started.toISOString(), waiting: 0, checked: 0, verdicts: {}, warnings: [], error: null };
  if (env.mode === "off" || env.missing.length || !isDatabaseConfigured()) {
    result.status = "skipped";
    result.error = env.mode === "off" ? "The backup check is switched off (INTAKE_FALLBACK_MODE=off)." : env.missing.length ? `Not set up: ${env.missing.join(", ")}.` : "The database is not configured.";
    lastRun = result;
    return result;
  }
  const mode = env.mode as Mode;
  let runId: string | null = null;
  try {
    const { waiting, untagged } = await missedEmails();
    result.waiting = waiting.length + untagged.length;
    for (const row of untagged.slice(0, MAX_RETAG_PER_RUN)) {
      try {
        await graphSend("PATCH", `/users/${upn()}/messages/${encodeURIComponent(row.message.id)}`, { categories: withCategory(row.message.categories, categoryFor(row.verdict, row.action)) }, "The Outlook category could not be set");
        result.checked += 1;
        result.verdicts.retagged = (result.verdicts.retagged ?? 0) + 1;
      } catch (error) {
        result.warnings.push(`Tag not restored (${row.message.subject ?? "no subject"}): ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
      }
    }
    if (waiting.length) {
      const [row] = await getDb().insert(integrationSyncRunsTable).values({ integration: "accounts_inbox", trigger: `intake_fallback:${trigger}` }).returning({ id: integrationSyncRunsTable.id });
      runId = row?.id ?? null;
      const aliases = await loadAliases();
      const history = await loadHistory();
      for (const message of waiting.slice(0, MAX_PER_RUN)) {
        const outcome = await checkOne(message, { mode, apiKey: env.openAiKey!, model: env.model, aliases, history, warnings: result.warnings });
        if (!outcome) continue;
        if (outcome === "nothing_to_read") {
          result.checked += 1;
          result.verdicts.not_invoice = (result.verdicts.not_invoice ?? 0) + 1;
          continue;
        }
        result.checked += 1;
        result.verdicts[outcome] = (result.verdicts[outcome] ?? 0) + 1;
      }
      if (runId) {
        await getDb().update(integrationSyncRunsTable)
          .set({ status: "succeeded", finishedAt: new Date(), recordsProcessed: result.checked, details: { waiting: result.waiting, verdicts: result.verdicts, warnings: result.warnings.slice(0, 20), mode } })
          .where(eq(integrationSyncRunsTable.id, runId));
      }
    }
    if (result.checked) {
      if (!runId) {
        const [row] = await getDb().insert(integrationSyncRunsTable).values({ integration: "accounts_inbox", trigger: `intake_fallback:${trigger}`, status: "succeeded", finishedAt: new Date(), recordsProcessed: result.checked, details: { waiting: result.waiting, verdicts: result.verdicts, warnings: result.warnings.slice(0, 20), mode } }).returning({ id: integrationSyncRunsTable.id });
        runId = row?.id ?? null;
      }
      logger.warn({ checked: result.checked, verdicts: result.verdicts }, "Backup intake check handled emails n8n had not checked");
    }
  } catch (error) {
    result.status = "failed";
    result.error = error instanceof Error ? error.message : String(error);
    logger.warn({ err: error }, "Backup intake check failed");
    if (runId) {
      await getDb().update(integrationSyncRunsTable).set({ status: "failed", finishedAt: new Date(), recordsProcessed: result.checked, error: result.error.slice(0, 1000) }).where(eq(integrationSyncRunsTable.id, runId)).catch(() => undefined);
    }
  }
  lastRun = result;
  return result;
}

type LoggedUntagged = { message: GraphMessage; verdict: string; action: string | null };

// Inbox emails from the last few days, older than the grace period, with no "n8n:" tag:
// those never logged (waiting to be checked) and those logged whose tag was never set (untagged).
async function missedEmails(): Promise<{ waiting: GraphMessage[]; untagged: LoggedUntagged[] }> {
  const to = new Date(Date.now() - GRACE_MINUTES * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const from = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const query = [
    `$filter=${encodeURIComponent(`receivedDateTime ge ${from} and receivedDateTime le ${to}`)}`,
    `$orderby=${encodeURIComponent("receivedDateTime asc")}`,
    "$top=100",
    "$select=id,subject,from,receivedDateTime,internetMessageId,hasAttachments,categories,webLink",
  ].join("&");
  const messages: GraphMessage[] = [];
  let next: string | undefined = `/users/${upn()}/mailFolders/inbox/messages?${query}`;
  for (let page = 0; next && page < 5; page += 1) {
    const body: { value?: GraphMessage[]; "@odata.nextLink"?: string } = await graphGet(next, "The accounts inbox could not be read");
    messages.push(...(body.value ?? []));
    next = body["@odata.nextLink"];
  }
  const candidates = messages.filter((m) =>
    m.internetMessageId &&
    !nothingToRead.has(m.internetMessageId) &&
    !(m.categories ?? []).some((c) => c.startsWith("n8n:")) &&
    !isFromAccountsAndNotForward(m));
  if (!candidates.length) return { waiting: [], untagged: [] };
  const t = invoiceIntakeChecksTable;
  const logged = await getDb().select({ id: t.internetMessageId, verdict: t.verdict, action: t.action }).from(t).where(inArray(t.internetMessageId, candidates.map((m) => m.internetMessageId!)));
  const done = new Map(logged.map((row) => [row.id, row]));
  const waiting: GraphMessage[] = [];
  const untagged: LoggedUntagged[] = [];
  for (const m of candidates) {
    const row = done.get(m.internetMessageId!);
    if (!row) waiting.push(m);
    else if (categoryFor(row.verdict, row.action)) untagged.push({ message: m, verdict: row.verdict, action: row.action });
  }
  return { waiting, untagged };
}

// The Outlook category for a logged verdict, as the check sets it.
function categoryFor(verdict: string, action: string | null): string {
  const cat = INTAKE_CONFIG.categories;
  if (verdict === "pass") return cat.pass;
  if (verdict === "not_invoice") return cat.notInvoice;
  if (verdict === "review") return cat.review;
  if (verdict === "bounce") return action === "bounce_sent" ? cat.bounced : action === "draft_created" ? cat.drafted : cat.shadow;
  return "";
}

// The email's own categories with any old "n8n:" one replaced.
function withCategory(existing: string[] | undefined, category: string): string[] {
  return (existing ?? []).filter((c) => !c.startsWith("n8n:")).concat(category ? [category] : []);
}

async function loadAliases(): Promise<{ alias: string; organisation: string }[] | null> {
  try {
    const rows = await getDb().select({ alias: companyAliasesTable.alias, tenant: companyAliasesTable.xeroTenantId }).from(companyAliasesTable);
    return rows.map((row) => ({ alias: row.alias, organisation: XERO_ORGANISATION_NAMES[row.tenant] ?? "" })).filter((row) => row.organisation);
  } catch (error) {
    logger.warn({ err: error }, "Company aliases could not be read for the backup intake check");
    return null;
  }
}

async function loadHistory(): Promise<IntakeHistoryRow[]> {
  const t = invoiceIntakeChecksTable;
  return getDb().select({ processedAt: t.processedAt, senderEmail: t.senderEmail, bounceKey: t.bounceKey, action: t.action }).from(t).where(inArray(t.action, SENT_ACTIONS));
}

type Context = { mode: Mode; apiKey: string; model: string; aliases: { alias: string; organisation: string }[] | null; history: IntakeHistoryRow[]; warnings: string[] };

async function checkOne(listed: GraphMessage, ctx: Context): Promise<CheckResult["verdict"] | "nothing_to_read" | null> {
  const base = `/users/${upn()}/messages/${encodeURIComponent(listed.id)}`;
  const message: GraphMessage = await graphGet(`${base}?$select=id,subject,from,receivedDateTime,internetMessageId,hasAttachments,body,categories,webLink`, "An email could not be read");
  const attachments: GraphAttachment[] = message.hasAttachments ? ((await graphGet<{ value?: GraphAttachment[] }>(`${base}/attachments`, "The email's attachments could not be read")).value ?? []) : [];
  const docs = splitDocuments(message, attachments);
  if (!docs.length) {
    // Nothing to read: tag it "not an invoice" like n8n, without logging it.
    try {
      await graphSend("PATCH", base, { categories: withCategory(message.categories, INTAKE_CONFIG.categories.notInvoice) }, "The Outlook category could not be set");
      return "nothing_to_read";
    } catch (error) {
      ctx.warnings.push(`Tag not set (${message.subject ?? "no subject"}): ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
      nothingToRead.add(message.internetMessageId!);
      return null;
    }
  }

  // Read each document: a saved reading if this exact file was read before, otherwise the AI.
  const prepared = docs.map((doc) => ({ doc, ...aiRequest(doc) }));
  const saved = await getDb().select().from(documentReadingsTable).where(inArray(documentReadingsTable.docHash, prepared.map((p) => p.docHash)));
  const cache = new Map(saved.map((row) => [row.docHash, row.extraction as Extraction]));
  const read: ReadDocument[] = [];
  for (const p of prepared) {
    let extraction: Extraction | null = cache.get(p.docHash) ?? null;
    let extractionError: string | null = null;
    if (!extraction) {
      try {
        extraction = await readInvoice(p.input, { apiKey: ctx.apiKey, model: ctx.model });
        await getDb().insert(documentReadingsTable).values({ docHash: p.docHash, extraction, model: ctx.model, provider: "openai" }).onConflictDoNothing();
        cache.set(p.docHash, extraction);
      } catch (error) {
        extractionError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      }
    }
    read.push({ source: p.doc, ...normaliseExtraction(extraction), extractionError, docHash: p.docHash, base64: p.base64 });
  }

  const result = checkEmail({ source: docs[0], categories: message.categories ?? [], docs: read, mode: ctx.mode, aliases: ctx.aliases, history: ctx.history });
  const processedAt = new Date();
  const internetMessageId = message.internetMessageId!;

  // Claim the email first: if n8n (or another run) logged it meanwhile, do nothing.
  const t = invoiceIntakeChecksTable;
  const claimed = await getDb().insert(t).values({
    processedAt,
    internetMessageId,
    outlookMessageId: message.id,
    senderEmail: result.senderEmail || null,
    subject: result.source.subject || null,
    supplierName: result.supplierName || null,
    invoiceNumber: result.invoiceNumber || null,
    invoiceDate: validDate(result.invoiceDate),
    totalGross: amount(result.totalGross)?.toFixed(2) ?? null,
    billTo: result.billTo || null,
    verdict: result.verdict,
    issueCodes: result.issueCodes || null,
    action: result.action,
    mode: ctx.mode,
    bounceKey: result.bounceKey || null,
    issues: { issues: result.issues, review: result.reviewReasons },
    checkedBy: "pms",
  }).onConflictDoNothing().returning({ id: t.id });
  if (!claimed.length) return null;
  if (result.action !== "none") ctx.history.push({ processedAt, senderEmail: result.senderEmail, bounceKey: result.bounceKey, action: result.action });

  const warn = (what: string, error: unknown) => {
    const message = `${what} (${result.senderEmail || "unknown sender"}): ${error instanceof Error ? error.message : String(error)}`;
    ctx.warnings.push(message.slice(0, 300));
    logger.warn({ err: error, internetMessageId }, what);
  };

  await graphSend("PATCH", base, result.categories, "The Outlook category could not be set").catch((error) => warn("Outlook category not set", error));

  if (result.bounce) {
    try {
      if (ctx.mode === "shadow") await graphSend("POST", `/users/${encodeURIComponent(INTAKE_CONFIG.noreplyAddress || INTAKE_CONFIG.accountsMailbox)}/sendMail`, shadowMail(result), "The shadow email could not be sent");
      else if (ctx.mode === "draft") await graphSend("POST", `${base}/createReply`, replyBody(result), "The reply could not be drafted");
      else await graphSend("POST", `${base}/reply`, replyBody(result), "The reply could not be sent");
    } catch (error) {
      warn("Bounce not sent", error);
    }
  }

  if (result.verdict === "review") {
    const docIssues = result.issues;
    const issues = docIssues.flatMap((d) => d.issues.map((x) => ({
      code: x.code || "other",
      message: `${docIssues.length > 1 && d.filename ? `${d.filename}: ` : ""}${x.message}`.slice(0, 1000),
      lines: (x.lines ?? []).slice(0, 40).map((l) => ({ text: String(l.text || "(no description)").slice(0, 500), amount: amount(l.amount) })),
    })));
    const link = message.webLink && /^https:\/\/outlook\.(office365|office|live)\.com\//i.test(message.webLink) && message.webLink.length <= 2000 ? message.webLink : null;
    await getDb().insert(invoiceIntakeReviewsTable).values({
      internetMessageId,
      outlookMessageId: message.id,
      webLink: link,
      receivedAt: message.receivedDateTime ? new Date(message.receivedDateTime) : null,
      senderEmail: result.senderEmail || null,
      senderName: result.senderName.slice(0, 300) || null,
      subject: result.source.subject.slice(0, 500) || null,
      supplierName: result.supplierName.slice(0, 300) || null,
      invoiceNumber: result.invoiceNumber.slice(0, 100) || null,
      invoiceDate: validDate(result.invoiceDate),
      total: amount(result.totalGross)?.toFixed(2) ?? null,
      currency: /^[A-Za-z]{3}$/.test(result.currency) ? result.currency.toUpperCase() : "GBP",
      billTo: result.billTo.slice(0, 300) || null,
      billToCompany: result.billToCompany.slice(0, 200) || null,
      reasons: result.reviewReasons.slice(0, 50).map((r) => ({ code: r.code || "other", message: r.message.slice(0, 1000) })),
      issues,
    }).onConflictDoNothing().catch((error) => warn("Review not saved", error));
  }

  if (result.verdict !== "not_invoice") {
    for (const file of invoiceFiles(read, processedAt)) {
      try {
        const saved = await graphUpload<{ id?: string; name?: string; webUrl?: string; size?: number }>(
          `/drives/${encodeURIComponent(INTAKE_CONFIG.invoiceFilesDriveId)}/root:/${file.path}:/content?@microsoft.graph.conflictBehavior=rename`, file.data, file.mime, "The invoice could not be saved to SharePoint");
        if (saved.webUrl) {
          await getDb().insert(invoiceIntakeFilesTable).values({ internetMessageId, kind: "file", name: saved.name ?? file.name, url: saved.webUrl, driveItemId: saved.id ?? null, mimeType: file.mime, size: Number.isFinite(saved.size) ? saved.size! : null }).onConflictDoNothing();
        }
      } catch (error) {
        warn("Invoice not saved to SharePoint", error);
      }
    }
    const url = invoiceLink(String(message.body?.content ?? ""));
    if (url) await getDb().insert(invoiceIntakeFilesTable).values({ internetMessageId, kind: "link", name: null, url }).onConflictDoNothing().catch((error) => warn("Invoice link not saved", error));
  }
  return result.verdict;
}

// For the Inbox tab: whether the backup is set up, when n8n last logged an
// email, what the backup did lately.
export async function intakeFallbackStatus(): Promise<{
  configured: boolean;
  missing: string[];
  mode: string;
  running: boolean;
  lastRun: IntakeFallbackRun | null;
  lastN8nCheckAt: string | null;
  checkedByAppLastWeek: number;
}> {
  const env = readIntakeFallbackEnv();
  const t = invoiceIntakeChecksTable;
  const [n8n] = await getDb().select({ at: sql<Date | null>`max(${t.processedAt})` }).from(t).where(isNull(t.checkedBy));
  const [pms] = await getDb().select({ n: sql<number>`count(*)::int` }).from(t).where(and(eq(t.checkedBy, "pms"), gte(t.processedAt, new Date(Date.now() - 7 * 86_400_000))));
  let last = lastRun;
  if (!last) {
    // After a restart: the latest recorded run that found emails.
    const r = integrationSyncRunsTable;
    const [row] = await getDb().select().from(r).where(eq(r.integration, "accounts_inbox")).orderBy(desc(r.startedAt)).limit(1);
    if (row) {
      const details = (row.details ?? {}) as { waiting?: number; verdicts?: Record<string, number>; warnings?: string[] };
      last = { status: row.status === "running" ? "succeeded" : row.status, checkedAt: row.startedAt.toISOString(), waiting: details.waiting ?? 0, checked: row.recordsProcessed ?? 0, verdicts: details.verdicts ?? {}, warnings: details.warnings ?? [], error: row.error };
    }
  }
  const at = n8n?.at ? new Date(n8n.at) : null;
  return { configured: !env.missing.length && env.mode !== "off", missing: env.missing, mode: env.mode, running: running !== null, lastRun: last, lastN8nCheckAt: at ? at.toISOString() : null, checkedByAppLastWeek: pms?.n ?? 0 };
}

// Every 10 minutes while the server is up (first run a minute after start).
export function startIntakeFallbackTimer(): void {
  const env = readIntakeFallbackEnv();
  if (env.mode === "off" || env.missing.length || !isDatabaseConfigured()) return;
  const tick = () => void runIntakeFallback("schedule").catch((error) => logger.warn({ err: error }, "Backup intake check failed"));
  setTimeout(tick, 60_000).unref();
  setInterval(tick, INTERVAL_MS).unref();
}
