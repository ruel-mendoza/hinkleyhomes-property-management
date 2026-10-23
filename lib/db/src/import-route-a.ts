// Imports the old n8n "Route A" OneDrive CSV files into Supabase. Safe to re-run:
// rows already imported are left alone.
//   company_aliases.csv  -> company_aliases
//   property_aliases.csv -> property_aliases (optional; kind text or line)
//   invoice_runs.csv     -> bill_coding_reviews (only rows for Xero bills)
//   reading_cache.csv    -> document_readings
// Run after the database push, from the repo root, with the folder holding the files:
//   pnpm --filter @workspace/db run import:route-a -- import/route-a
// The files hold supplier bank details: keep them out of git (import/ is ignored).
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { billCodingReviewsTable, companyAliasesTable, documentReadingsTable, getDb, getPool, propertyAliasesTable } from "./index";

type Row = Record<string, string>;
type Json = Record<string, unknown>;

// The Xero organisation names used by Route A, and the app's own names, to tenant ids.
const TENANTS: Record<string, string> = {
  "hinkley homes management": "0a290129-b001-4bfb-903d-d27a8ac55738",
  management: "0a290129-b001-4bfb-903d-d27a8ac55738",
  lettings: "47f65b32-d0d7-4417-bb5c-89ff2d93651e",
  "hinkley homes lettings": "47f65b32-d0d7-4417-bb5c-89ff2d93651e",
  "hinkley homes stays ltd": "4c807578-e0a7-49ad-9644-8e705aec0c2a",
  "hinkley homes stays": "4c807578-e0a7-49ad-9644-8e705aec0c2a",
  stays: "4c807578-e0a7-49ad-9644-8e705aec0c2a",
  "hinkley homes ltd": "9d1fee42-4203-47d8-87aa-6fa8e8ac0fef",
  "hinkley homes holdings": "3ae8a283-c7e0-4287-9bcd-4c2561295890",
  holdings: "3ae8a283-c7e0-4287-9bcd-4c2561295890",
};
const COMPANY_NAMES: Record<string, string> = {
  "0a290129-b001-4bfb-903d-d27a8ac55738": "Hinkley Homes Management",
  "47f65b32-d0d7-4417-bb5c-89ff2d93651e": "Hinkley Homes Lettings",
  "4c807578-e0a7-49ad-9644-8e705aec0c2a": "Hinkley Homes Stays",
  "9d1fee42-4203-47d8-87aa-6fa8e8ac0fef": "Hinkley Homes Ltd",
  "3ae8a283-c7e0-4287-9bcd-4c2561295890": "Hinkley Homes Holdings",
};
const tenantOf = (name: string | undefined) => TENANTS[String(name ?? "").trim().toLowerCase()];

// Same as companyKey in artifacts/api-server/src/lib/bill-coding-rules.ts.
const companyKey = (s: string) =>
  s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w && !["ltd", "limited", "plc", "llp", "the"].includes(w)).join(" ");

function parseCsv(text: string): Row[] {
  text = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((v) => v.trim() !== ""));
  if (!header) return [];
  const cols = header.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? ""])));
}

const json = (text: string): unknown => { try { return text ? JSON.parse(text) : null; } catch { return null; } };
const num = (text: string) => (text !== "" && Number.isFinite(Number(text)) ? Number(text) : null);
const day = (text: string) => (/^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null);
const when = (text: string) => { const t = Date.parse(text); return Number.isNaN(t) ? new Date() : new Date(t); };

const folder = resolve(process.env.INIT_CWD ?? process.cwd(), process.argv[2] ?? "import/route-a");
const read = (name: string) => { const path = join(folder, name); return existsSync(path) ? parseCsv(readFileSync(path, "utf8")) : null; };
const db = getDb();
const report: string[] = [];
console.log(`Reading CSV files from ${folder}`);

// --- company_aliases.csv -----------------------------------------------------------------
const companies = read("company_aliases.csv");
if (companies) {
  let added = 0;
  const skipped: string[] = [];
  for (const r of companies) {
    const tenantId = tenantOf(r.xero_organisation);
    const key = companyKey(r.name_on_invoice ?? "");
    if (!tenantId || !key) { skipped.push(`${r.name_on_invoice} -> ${r.xero_organisation}`); continue; }
    const rows = await db.insert(companyAliasesTable).values({ alias: r.name_on_invoice.trim(), normalizedAlias: key, xeroTenantId: tenantId, notes: r.notes?.trim() || null, createdBy: "Route A import" }).onConflictDoNothing().returning();
    added += rows.length;
  }
  report.push(`company_aliases.csv: ${added} added of ${companies.length}${skipped.length ? `; skipped (unknown company): ${skipped.join("; ")}` : ""}`);
}

// --- property_aliases.csv ------------------------------------------------------------------
const aliases = read("property_aliases.csv");
if (aliases) {
  let added = 0;
  const skipped: string[] = [];
  for (const r of aliases) {
    const tenantId = tenantOf(r.tenant_name);
    const kind = r.kind === "line" ? "line" : "text";
    const key = String(r.alias_key ?? "").trim();
    const option = String(r.option_name ?? "").trim();
    if (!tenantId || !key || !option) { skipped.push(`${key || "(no key)"} -> ${r.tenant_name}`); continue; }
    const overhead = option === "__overhead__";
    const rows = await db
      .insert(propertyAliasesTable)
      .values({ kind, alias: kind === "line" ? `Bill line answer (Route A): ${key}` : key, normalizedAlias: key, xeroTenantId: tenantId, xeroTrackingOption: overhead ? null : option, overhead, source: kind === "line" ? "invoice" : "xero", verified: true, createdBy: r.added_by || "Route A import" })
      .onConflictDoNothing()
      .returning();
    added += rows.length;
  }
  report.push(`property_aliases.csv: ${added} added of ${aliases.length}${skipped.length ? `; skipped: ${skipped.join("; ")}` : ""}`);
} else {
  report.push("property_aliases.csv: not found (nothing to import)");
}

// --- invoice_runs.csv -----------------------------------------------------------------------
const STATUSES = ["held", "shadow_planned", "pending_xero", "created_draft", "updated_draft", "create_failed", "not_invoice", "read_failed"] as const;
const runs = read("invoice_runs.csv");
if (runs) {
  let added = 0, skipped = 0;
  for (const r of runs) {
    const m = /^xero::([0-9a-f-]{36})::([0-9a-f-]{36})$/i.exec(r.idempotency_key ?? "");
    const status = STATUSES.find((s) => s === r.app_status);
    if (!m || !status || !COMPANY_NAMES[m[1].toLowerCase()]) { skipped++; continue; }
    const tenantId = m[1].toLowerCase();
    const billId = m[2].toLowerCase();
    const createdAt = when(r.processed_at);
    const [exists] = await db.select({ id: billCodingReviewsTable.id }).from(billCodingReviewsTable).where(and(eq(billCodingReviewsTable.idempotencyKey, `xero::${tenantId}::${billId}`), eq(billCodingReviewsTable.createdAt, createdAt))).limit(1);
    if (exists) continue;
    const info = (json(r.app_reasons_json) ?? {}) as Json;
    const reasons = (Array.isArray(info.reasons) ? info.reasons : []).map((x: Json) => ({ code: String(x.code ?? ""), severity: String(x.severity ?? "warn"), message: String(x.message ?? "") }));
    for (const issue of Array.isArray(info.org_issues) ? info.org_issues : []) reasons.push({ code: "xero_setup", severity: "info", message: String(issue) });
    const allocation = (Array.isArray(info.allocation) ? info.allocation : []).map((a: Json) => ({ tenantId: String(a.tenant_id ?? ""), tenantName: String(a.tenant_name ?? ""), lineCount: Number(a.line_count ?? 0), amount: Number(a.amount ?? 0), pays: String(a.pays ?? "") }));
    const total = num(r.total_gross);
    const legibility = num(r.legibility_confidence);
    await db.insert(billCodingReviewsTable).values({
      idempotencyKey: `xero::${tenantId}::${billId}`,
      xeroTenantId: tenantId,
      xeroBillId: billId,
      company: COMPANY_NAMES[tenantId],
      status,
      fingerprint: (r.invoice_fingerprint ?? "").replace(/^(held|shadow|failed)::/, "") || null,
      supplierName: r.supplier_name || null,
      invoiceNumber: r.invoice_number || null,
      invoiceDate: day(r.invoice_date),
      currency: r.currency || null,
      total: total === null ? null : total.toFixed(2),
      documentType: r.document_type || null,
      legibility: legibility === null ? null : legibility.toFixed(3),
      sourceType: r.source_type || null,
      filename: r.filename || null,
      provider: r.extraction_provider || null,
      model: r.model || null,
      extractionError: r.extraction_error || null,
      shadowMode: r.shadow_mode === "true",
      reasons,
      allocation,
      xeroInvoiceIds: (status === "created_draft" || status === "updated_draft") && r.app_invoice_id ? [r.app_invoice_id.toLowerCase()] : [],
      error: r.app_error || null,
      createdAt,
      updatedAt: createdAt,
    });
    added++;
  }
  report.push(`invoice_runs.csv: ${added} reviews added of ${runs.length}${skipped ? `; ${skipped} skipped (not a Xero bill or unknown status)` : ""}`);
}

// --- reading_cache.csv ------------------------------------------------------------------------
const readings = read("reading_cache.csv");
if (readings) {
  const values = readings
    .map((r) => ({ docHash: r.doc_hash?.trim(), extraction: json(r.extraction_json) as Json | null, model: r.model || null, provider: r.provider || null, createdAt: when(r.extracted_at) }))
    .filter((v): v is { docHash: string; extraction: Json; model: string | null; provider: string | null; createdAt: Date } => Boolean(v.docHash && v.extraction && typeof v.extraction === "object"));
  let added = 0;
  for (let i = 0; i < values.length; i += 200) {
    const rows = await db.insert(documentReadingsTable).values(values.slice(i, i + 200)).onConflictDoNothing().returning({ docHash: documentReadingsTable.docHash });
    added += rows.length;
  }
  report.push(`reading_cache.csv: ${added} readings added of ${readings.length}${values.length < readings.length ? ` (${readings.length - values.length} unreadable rows skipped)` : ""}`);
}

for (const line of report) console.log(line);
await getPool().end();
