// Bill coding rules (moved from the n8n "Route A: Xero-first" workflow). Pure
// functions only: lib/bill-coding.ts loads Xero, the aliases and the settings.
// The AI only extracts text from the invoice; these rules decide which property
// (Xero company + Property tracking option) each line belongs to. Anything
// unclear is held for a person, never guessed.

type Json = Record<string, unknown>;

// --- Text matching ------------------------------------------------------------------

const SYN: Record<string, string> = { rd: "road", st: "street", ave: "avenue", av: "avenue", ln: "lane", pl: "place", dr: "drive", cl: "close", ct: "court", cres: "crescent", sq: "square", gdns: "gardens", terr: "terrace" };
const GENERIC = new Set(["road", "street", "avenue", "lane", "drive", "close", "place", "es", "e", "s"]);

export const tokens = (s: unknown): string[] =>
  String(s ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((t) => SYN[t] ?? t)
    .filter((t) => !GENERIC.has(t));
export const norm = (s: unknown) => tokens(s).join("");
// The stored matching form of a text alias.
export const aliasKey = (s: unknown) => tokens(s).join(" ");
const stripDate = (s: unknown) => String(s ?? "").replace(/^\s*\d{1,2}\s*[/.-]{1,2}\s*\d{1,2}(\s*[/.-]{1,2}\s*\d{2,4})?\s*/, "");
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const r2 = (v: number) => Math.round(v * 100) / 100;
const money = (n: number) => `£${Number(n).toFixed(2)}`;
const containsSeq = (hay: string[], needle: string[]) => {
  if (!needle.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
};
const ymd = (s: unknown) => (/^\d{4}-\d{2}-\d{2}/.test(String(s ?? "")) ? String(s).slice(0, 10) : "");
const day = (s: unknown) => { const d = ymd(s); return d ? Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000 : null; };

// --- Targets ----------------------------------------------------------------------

export type Org = { tenantId: string; tenantName: string };
export type TrackingProp = { tenantId: string; tenantName: string; category: string; option: string; tokens: string[]; key: string };
// option null = a company cost with no property ("overhead").
export type CodingTarget = { tenantId: string; tenantName: string; category: string; option: string | null };
export type TextAlias = { tokens: string[]; target: CodingTarget };

// "Property" and "Properties" are the same category (companies name it either way).
const singular = (s: unknown) => norm(s).replace(/ies$/, "y").replace(/s$/, "");
export const sameCategory = (a: unknown, b: unknown) => singular(a) === singular(b);
// A short code before a dash is not part of the address: "HH - 1 Valetta Place" is matched as "1 Valetta Place".
const optionTokens = (name: unknown) => tokens(String(name ?? "").replace(/^\s*[a-z]{1,4}\s*-\s+/i, ""));

// Active options of each company's Property tracking category.
export function trackingProps(orgs: (Org & { categories: Json[] | null; error?: string | null })[], categoryName: string) {
  const props: TrackingProp[] = [];
  const orgIssues: string[] = [];
  for (const org of orgs) {
    if (org.error || org.categories === null) { orgIssues.push(`${org.tenantName}: could not read tracking categories`); continue; }
    const cat = org.categories.find((c) => sameCategory(c.Name, categoryName) && String(c.Status ?? "ACTIVE").toUpperCase() === "ACTIVE");
    if (!cat) { orgIssues.push(`${org.tenantName}: no active tracking category named "${categoryName}" (or its plural)`); continue; }
    for (const op of (Array.isArray(cat.Options) ? cat.Options : []) as Json[]) {
      if (String(op.Status ?? "ACTIVE").toUpperCase() !== "ACTIVE") continue;
      const tk = optionTokens(op.Name);
      if (tk.length) props.push({ tenantId: org.tenantId, tenantName: org.tenantName, category: String(cat.Name), option: String(op.Name), tokens: tk, key: tk.join("") });
    }
  }
  return { props, orgIssues };
}

type Match = { kind: "match"; target: CodingTarget; via: "alias" | "name" } | { kind: "ambiguous" | "multi"; candidates: TrackingProp[] } | { kind: "none" };

function matchText(text: string, props: TrackingProp[], aliases: TextAlias[]): Match {
  const t = tokens(text);
  if (!t.length) return { kind: "none" };
  let best: TextAlias | null = null;
  for (const a of aliases) if (containsSeq(t, a.tokens) && (!best || a.tokens.length > best.tokens.length)) best = a;
  if (best) return { kind: "match", target: best.target, via: "alias" };
  let found = props.filter((p) => containsSeq(t, p.tokens));
  found = found.filter((p) => !found.some((q) => q !== p && q.tokens.length > p.tokens.length && containsSeq(q.tokens, p.tokens)));
  const distinct: TrackingProp[] = [];
  for (const p of found) if (!distinct.some((d) => d.tenantId === p.tenantId && d.option === p.option)) distinct.push(p);
  if (distinct.length === 1) return { kind: "match", target: distinct[0], via: "name" };
  if (distinct.length > 1) return { kind: distinct.every((p) => p.key === distinct[0].key) ? "ambiguous" : "multi", candidates: distinct };
  return { kind: "none" };
}

export type Suggestion = { tenantId: string; tenantName: string; option: string; score: number };
function suggest(text: string, props: TrackingProp[]): Suggestion[] {
  const set = new Set(tokens(stripDate(text)));
  const out: Suggestion[] = [];
  for (const p of props) {
    const nonNum = p.tokens.filter((x) => !/^\d+[a-z]?$/.test(x));
    const nums = p.tokens.filter((x) => /^\d+[a-z]?$/.test(x));
    const mNon = nonNum.filter((x) => set.has(x)).length;
    const mNum = nums.filter((x) => set.has(x)).length;
    if (!mNon && !mNum) continue;
    const score = (mNon + 0.5 * mNum) / (nonNum.length + 0.5 * nums.length);
    if (score >= 0.2) out.push({ tenantId: p.tenantId, tenantName: p.tenantName, option: p.option, score: r2(score) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}

// --- Who the invoice is addressed to ---------------------------------------------------

// "Hinkley Homes Lettings Ltd" -> "hinkley homes lettings": company forms and "the" dropped.
export const companyKey = (s: unknown) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !["ltd", "limited", "plc", "llp", "the"].includes(w))
    .join(" ");

export type CompanyAlias = { tokens: string[]; tenantId: string; tenantName: string };

// The company an "addressed to" name means: the longest alias or company name found in it.
export function addressedCompany(name: string, aliases: CompanyAlias[]): CompanyAlias | null {
  const t = companyKey(name).split(" ").filter(Boolean);
  let best: CompanyAlias | null = null;
  for (const a of aliases) if (containsSeq(t, a.tokens) && (!best || a.tokens.length > best.tokens.length)) best = a;
  return best;
}

// --- The bill as Xero holds it -------------------------------------------------------

export type XeroBill = {
  key: string; // xero::<tenant>::<bill>
  tenantId: string;
  tenantName: string;
  invoiceId: string;
  number: string;
  status: string;
  supplierName: string;
  currency: string;
  date: string;
  dueDate: string;
  total: number | null;
  lineAmountTypes: string;
  url: string;
  lines: { description: string; lineAmount: number | null; accountCode: string; taxType: string }[];
};

export type CodingSettings = {
  autoSplit: boolean;
  payingCompanyName: string;
  trackingCategory: string;
  legibilityMin: number;
  dateOutlierDays: number;
  dupLineMinAmount: number;
  defaultAccountCode: string;
  categoryAccountMap: Record<string, string>;
};

export type Reason = { code: string; severity: "hold" | "high" | "warn" | "info"; message: string };
export type PlanLine = {
  index: number;
  description: string;
  serviceDate: string;
  amount: number | null;
  category: string;
  jobType: string;
  tenantId?: string;
  tenantName?: string;
  option?: string | null;
  trackingCategory?: string;
  matchedBy?: string;
};
export type Need = PlanLine & { key: string; answerKey: string; aliasKey: string; referenceText: string; reason: string; suggestions: Suggestion[] };
export type Allocation = { tenantId: string; tenantName: string; lineCount: number; amount: number; pays: "self" | "intercompany" };
export type PlanGroup = { tenantId: string; tenantName: string; lines: PlanLine[]; total: number; sourceUpdate: boolean; updateId: string };

export type BillPlan = {
  planType: "held" | "ready";
  holds: Reason[];
  flags: Reason[];
  needs: Need[];
  allocation: Allocation[];
  lines: PlanLine[];
  groups: PlanGroup[];
  invoiceTotal: number;
  supplierName: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  currency: string;
  documentType: string;
  legibility: number | null;
  periodByMonth: Record<string, number>;
  orgIssues: string[];
};

// The answer key of one bill line: the staff answer for it is stored under this
// key (property_aliases, kind "line").
export const answerKeyFor = (messageId: string, description: string, amount: number | null) =>
  `@@${norm(messageId)}@@${norm(stripDate(description))}|${amount === null ? "na" : amount.toFixed(2)}`;

export function planBill(
  input: { extraction: Json; xero: XeroBill; messageId: string },
  ctx: { settings: CodingSettings; props: TrackingProp[]; orgIssues: string[]; aliases: TextAlias[]; lineAnswers: Map<string, CodingTarget>; orgs: Org[]; companyAliases?: CompanyAlias[] },
): BillPlan {
  const { settings: cfg, props, orgIssues } = ctx;
  const x = input.extraction;
  const xr = input.xero;
  const sup = (x.supplier ?? {}) as Json;
  const totals = (x.totals ?? {}) as Json;
  const holds: Reason[] = [];
  const flags: Reason[] = [];
  const hold = (code: string, message: string) => holds.push({ code, severity: "hold", message });
  const flag = (code: string, severity: Reason["severity"], message: string) => flags.push({ code, severity, message });
  const catName = cfg.trackingCategory || "Property";

  if (x.document_type === "credit_note") hold("credit_note_manual", "Supplier credit notes are not posted automatically yet: enter it in Xero by hand.");
  const legibility = num(x.legibility_confidence);
  if (legibility !== null && legibility < cfg.legibilityMin) hold("low_legibility", `The document was hard to read (confidence ${x.legibility_confidence}).`);
  const cur = String(x.currency || "GBP").toUpperCase();
  if (cur !== "GBP") hold("foreign_currency", `Invoice is in ${cur}: enter it in Xero by hand and keep it out of the GBP payment batch.`);
  if (!sup.name) hold("no_supplier", "No supplier name was read from the invoice.");
  if (!props.length) hold("no_properties_in_xero", `No property tracking options were found in Xero (${orgIssues.join("; ") || "check the tracking category name in the bill coding settings"}).`);

  const lines = (Array.isArray(x.lines) ? x.lines : []) as Json[];
  if (!lines.length) hold("no_lines", "No invoice lines were read from the document.");
  const amounts = lines.map((l) => {
    const g = num(l.gross);
    if (g !== null) return g;
    const n = num(l.net), v = num(l.vat);
    return n !== null ? r2(n + (v ?? 0)) : null;
  });
  const totalGross = num(totals.gross);
  if (lines.length === 1 && amounts[0] === null && totalGross !== null) amounts[0] = totalGross;
  if (lines.length && amounts.some((a) => a === null)) hold("no_line_amounts", `The invoice does not show an amount for each line${totalGross !== null ? ` (only a total of ${money(totalGross)})` : ""}. Ask the supplier to reissue it showing the amount for each property.`);
  const sum = r2(amounts.reduce<number>((a, b) => a + (b ?? 0), 0));
  const allAmounts = !amounts.some((a) => a === null);
  if (totalGross !== null && allAmounts && Math.abs(sum - totalGross) > 0.02) hold("totals_mismatch", `Lines add up to ${money(sum)} but the invoice total is ${money(totalGross)}.`);
  if (typeof xr.total === "number" && lines.length && allAmounts && Math.abs(sum - xr.total) > 0.02) hold("xero_total_mismatch", `The lines add up to ${money(sum)} but the bill in Xero is ${money(xr.total)}.`);
  if (totalGross === null) flag("no_total", "warn", "No invoice total was read, so the lines could not be checked against it.");
  if (!x.invoice_number) flag("missing_invoice_number", "warn", "No invoice number was read.");
  if (!x.invoice_date) flag("missing_invoice_date", "warn", "No invoice date was read; the bill's date in Xero will be used.");
  const bt = String(((x.addressed_to ?? {}) as Json).name ?? "");
  const billedTo = bt ? addressedCompany(bt, ctx.companyAliases ?? []) : null;
  if (bt && !billedTo && !/hinkley|hinckley/i.test(bt)) flag("bill_to_unexpected", "warn", `Billed to "${bt}", which does not look like a Hinkley company.`);
  if (billedTo && billedTo.tenantId !== xr.tenantId) flag("addressed_to_other_company", "info", `Addressed to "${bt.replace(/\s+/g, " ").trim()}", which is ${billedTo.tenantName}; the bill sits in ${xr.tenantName}.`);

  const resolved: PlanLine[] = [];
  const needs: Need[] = [];
  lines.forEach((l, li) => {
    const amount = amounts[li];
    const ref = l.property_reference_as_written ? String(l.property_reference_as_written) : "";
    const desc = stripDate(l.description ?? "");
    const answerKey = answerKeyFor(input.messageId, String(l.description ?? ""), amount);
    let target = ctx.lineAnswers.get(answerKey) ?? null;
    let via = target ? "answer" : "";
    let m: Match = { kind: "none" };
    if (!target) {
      m = ref ? matchText(ref, props, ctx.aliases) : { kind: "none" };
      if (m.kind === "none") m = matchText(desc, props, ctx.aliases);
      if (m.kind === "match") { target = m.target; via = m.via; }
    }
    const base: PlanLine = { index: li, description: String(l.description ?? ""), serviceDate: ymd(l.service_date), amount, category: String(l.suggested_category ?? ""), jobType: String(l.suggested_job_type ?? "") };
    // Written to Xero under that company's own category name ("Property" or "Properties").
    if (target) resolved.push({ ...base, tenantId: target.tenantId, tenantName: target.tenantName, option: target.option, trackingCategory: props.find((p) => p.tenantId === target!.tenantId)?.category ?? (target.category || catName), matchedBy: via });
    else needs.push({
      ...base,
      key: answerKey.split("@@")[2] ?? "",
      answerKey,
      aliasKey: ref ? aliasKey(ref) : "",
      referenceText: ref,
      reason: m.kind === "multi" ? "shared_line" : m.kind === "ambiguous" ? "ambiguous" : ref ? "no_match" : "no_property_text",
      suggestions: "candidates" in m ? m.candidates.slice(0, 3).map((c) => ({ tenantId: c.tenantId, tenantName: c.tenantName, option: c.option, score: 1 })) : suggest(ref || desc, props),
    });
  });
  if (needs.length) hold("needs_property", `${needs.length} of ${lines.length} lines need a property (${money(needs.reduce((a, n) => a + (n.amount ?? 0), 0))}).`);

  const all: PlanLine[] = [...resolved, ...needs];
  const dates = all.map((l) => day(l.serviceDate)).filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (dates.length >= 3) {
    const med = dates[Math.floor(dates.length / 2)];
    const far = all.filter((l) => day(l.serviceDate) !== null && Math.abs(day(l.serviceDate)! - med) > cfg.dateOutlierDays);
    if (far.length) flag("line_date_outlier", "warn", `${far.length} line(s) have dates far from the rest (${far.map((l) => l.serviceDate).join(", ")}): possible typos.`);
  }
  const byMonth: Record<string, number> = {};
  for (const l of all) { const k = ymd(l.serviceDate).slice(0, 7); if (k) byMonth[k] = r2((byMonth[k] ?? 0) + (l.amount ?? 0)); }
  const months = Object.keys(byMonth).sort();
  const invMonth = ymd(x.invoice_date).slice(0, 7);
  if (months.length > 1 || (months.length === 1 && invMonth && months[0] !== invMonth)) flag("period_split", "info", `Work dates span ${months.map((k) => `${k} ${money(byMonth[k])}`).join(", ")} but the invoice is dated ${x.invoice_date ?? "unknown"}. Accounting period to be decided.`);
  const seenDup: Record<string, string> = {};
  for (const l of resolved) {
    if (l.amount !== null && l.amount >= cfg.dupLineMinAmount) {
      const k = `${l.tenantId}|${norm(l.option)}|${l.amount.toFixed(2)}`;
      if (seenDup[k]) flag("possible_duplicate_lines", "warn", `Two lines for ${l.option ?? "the same company"} at ${money(l.amount)} (dates ${seenDup[k]} and ${l.serviceDate || "none"}).`);
      else seenDup[k] = l.serviceDate || "none";
    }
  }

  const groups = new Map<string, { tenantId: string; tenantName: string; lines: PlanLine[] }>();
  for (const l of resolved) {
    const g = groups.get(l.tenantId!) ?? { tenantId: l.tenantId!, tenantName: l.tenantName!, lines: [] };
    g.lines.push(l);
    groups.set(l.tenantId!, g);
  }
  const allocation: Allocation[] = [...groups.values()].map((g) => ({
    tenantId: g.tenantId,
    tenantName: g.tenantName,
    lineCount: g.lines.length,
    amount: r2(g.lines.reduce((a, b) => a + (b.amount ?? 0), 0)),
    pays: g.tenantName === cfg.payingCompanyName ? "self" : "intercompany",
  }));
  if (!needs.length && resolved.length) {
    const ids = [...groups.keys()];
    const names = allocation.map((a) => `${a.tenantName} ${money(a.amount)}`).join(", ");
    if (ids.length === 1 && ids[0] !== xr.tenantId) hold("bill_in_wrong_company", `Every line belongs to ${allocation[0].tenantName} but the bill sits in ${xr.tenantName}. Move or re-enter it in the right company.`);
    else if (ids.length > 1 && !cfg.autoSplit) hold("cross_company_split", `The lines belong to more than one company (${names}). Check the split, then switch on automatic splitting or enter the other part by hand.`);
    else if (ids.length > 1 && !groups.has(xr.tenantId)) hold("source_company_has_no_lines", `None of the lines belong to ${xr.tenantName} where the bill sits (${names}).`);
  }

  const common = {
    holds, flags, needs, lines: all,
    invoiceTotal: totalGross !== null ? totalGross : sum,
    supplierName: String(sup.name ?? ""),
    invoiceNumber: String(x.invoice_number ?? ""),
    invoiceDate: ymd(x.invoice_date),
    dueDate: ymd(x.due_date),
    currency: cur,
    documentType: String(x.document_type ?? "invoice"),
    legibility,
    periodByMonth: byMonth,
    orgIssues,
  };
  if (holds.length) return { planType: "held", allocation: needs.length ? [] : allocation, groups: [], ...common };
  return {
    planType: "ready",
    allocation,
    groups: [...groups.values()].map((g) => ({
      tenantId: g.tenantId,
      tenantName: g.tenantName,
      lines: g.lines,
      total: r2(g.lines.reduce((a, b) => a + (b.amount ?? 0), 0)),
      sourceUpdate: g.tenantId === xr.tenantId,
      updateId: g.tenantId === xr.tenantId ? xr.invoiceId : "",
    })),
    ...common,
  };
}

// --- Draft bills to write --------------------------------------------------------------

// One draft supplier bill (ACCPAY) per company. Bank details are never written
// and the status is always DRAFT. A bill in its own company only has its lines
// rewritten (property added); its status is left as it is.
export function xeroBillBody(plan: BillPlan, group: PlanGroup, xr: XeroBill, fingerprint: string, cfg: CodingSettings) {
  const upd = group.sourceUpdate;
  const exLines = upd ? xr.lines : [];
  const common = (k: "accountCode" | "taxType") => {
    const v = exLines.map((l) => l[k] || "");
    return v.length && v.every((z) => z && z === v[0]) ? v[0] : "";
  };
  const keepAcc = common("accountCode");
  const keepTax = common("taxType");
  const lineItems = group.lines.map((l) => {
    const li: Json = { Description: [l.serviceDate, l.description].filter(Boolean).join(" ").slice(0, 3900), Quantity: 1, UnitAmount: l.amount };
    const code = keepAcc || cfg.categoryAccountMap[l.category] || cfg.defaultAccountCode || "";
    if (code) li.AccountCode = code;
    if (keepTax) li.TaxType = keepTax;
    if (l.option) li.Tracking = [{ Name: l.trackingCategory, Option: l.option }];
    return li;
  });
  const split = plan.allocation.length > 1;
  const reference = split
    ? `Part of invoice ${plan.invoiceNumber || "(no number)"} total ${money(plan.invoiceTotal)}, split across ${plan.allocation.length} companies; source bill ${xr.number || xr.invoiceId} in ${xr.tenantName}`
    : `Created from bill ${xr.number || xr.invoiceId} in ${xr.tenantName}`;
  const inv: Json = {
    Type: "ACCPAY",
    Contact: { Name: xr.supplierName || plan.supplierName },
    Date: plan.invoiceDate || xr.date || new Date().toISOString().slice(0, 10),
    CurrencyCode: plan.currency,
    Status: "DRAFT",
    // Line amounts are gross (VAT included).
    LineAmountTypes: "Inclusive",
    LineItems: lineItems,
    Reference: reference,
  };
  if (plan.dueDate || xr.dueDate) inv.DueDate = plan.dueDate || xr.dueDate;
  if (plan.invoiceNumber) inv.InvoiceNumber = plan.invoiceNumber;
  const body = upd ? { InvoiceID: group.updateId, LineAmountTypes: "Inclusive", LineItems: lineItems } : inv;
  return { body: { Invoices: [body] }, idempotencyKey: `n8n-${upd ? "upd-" : ""}${fingerprint}-${group.tenantId}`.slice(0, 128) };
}

// --- Same invoice sent again -------------------------------------------------------

export function invoiceFingerprint(extraction: Json | null, base: string, filename: string): string {
  const n = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z0-9.]/g, "");
  let fp = `doc::${base}::${filename}`;
  if (extraction && extraction.is_invoice === true) {
    const sup = (extraction.supplier ?? {}) as Json;
    const bank = (sup.bank ?? {}) as Json;
    const supplierKey = n(bank.account_number) || n(sup.vat_number) || n(sup.name);
    const totals = (extraction.totals ?? {}) as Json;
    const gross = typeof totals.gross === "number" ? totals.gross.toFixed(2) : "";
    if (supplierKey && (n(extraction.invoice_number) || gross)) {
      const weak = !n(extraction.invoice_number) && !n(extraction.invoice_date);
      fp = `${extraction.document_type === "credit_note" ? "cn::" : "inv::"}${[supplierKey, n(extraction.invoice_number), n(extraction.invoice_date), gross].join("|")}${weak ? `|${n(filename)}` : ""}`;
    }
  }
  return fp;
}

// Normalises the AI's document type: invoice or credit_note for documents to code.
export function normaliseExtraction(extraction: Json | null): Json | null {
  if (!extraction || typeof extraction !== "object") return null;
  if (extraction.is_invoice === true) {
    const dt = String(extraction.document_type ?? "").toLowerCase().replace(/[^a-z]/g, "");
    extraction.document_type = dt === "creditnote" || dt === "credit" || dt === "creditmemo" ? "credit_note" : "invoice";
  }
  return extraction;
}

// --- Which bills to check ------------------------------------------------------------

export type LastReview = { status: string; at: number; readFailures: number };
export type PickState = {
  statuses: string[];
  trackingCategory: string;
  maxBills: number;
  reprocessHeld: boolean;
  shadowMode: boolean;
  ownInvoiceIds: Set<string>;
  latest: Map<string, LastReview>;
  // supplier|number|total -> review key, for bills already handled.
  handled: Map<string, string>;
  answersAt: number;
  now: number;
};

const msDate = (v: unknown) => { const m = /Date\((\d+)/.exec(String(v ?? "")); return m ? Number(m[1]) : 0; };
export const dupKey = (supplier: unknown, number: unknown, total: unknown) => `${norm(supplier)}|${norm(number)}|${Number(total ?? 0).toFixed(2)}`;

// One entry per bill that still needs checking, oldest first.
export function pickBills(bills: { org: Org; bill: Json }[], state: PickState) {
  const catName = state.trackingCategory;
  const skipped = { duplicate_bill: 0, already_coded: 0, own_or_done: 0, waiting_for_answer: 0, not_in_status: 0 };
  const batchSeen = new Set<string>();
  const found: { org: Org; bill: Json; key: string }[] = [];
  for (const { org, bill: b } of bills) {
    if (!b.InvoiceID || b.Type !== "ACCPAY") continue;
    if (!state.statuses.includes(String(b.Status ?? "").toUpperCase())) { skipped.not_in_status++; continue; }
    const invoiceId = String(b.InvoiceID).toLowerCase();
    if (state.ownInvoiceIds.has(invoiceId) || String(b.Reference ?? "").startsWith("Part of invoice")) { skipped.own_or_done++; continue; }
    const lines = (Array.isArray(b.LineItems) ? b.LineItems : []) as Json[];
    const coded = (l: Json) => ((Array.isArray(l.Tracking) ? l.Tracking : []) as Json[]).some((t) => sameCategory(t.Name, catName) && t.Option);
    if (lines.length && lines.every(coded)) { skipped.already_coded++; continue; }
    const key = `xero::${org.tenantId}::${invoiceId}`;
    const dk = dupKey((b.Contact as Json | undefined)?.Name, b.InvoiceNumber, b.Total);
    if (b.InvoiceNumber && ((state.handled.get(dk) && state.handled.get(dk) !== key) || batchSeen.has(dk))) { skipped.duplicate_bill++; continue; }
    const prev = state.latest.get(key);
    if (prev) {
      const edited = msDate(b.UpdatedDateUTC) > prev.at;
      if (prev.status === "not_invoice" || prev.status === "read_failed") {
        const retryDue = prev.status === "read_failed" && prev.readFailures < 3 && state.now - prev.at > 6 * 3_600_000;
        if (!edited && !retryDue) { skipped.own_or_done++; continue; }
      } else if (prev.status === "held" || prev.status === "create_failed") {
        if (!(state.reprocessHeld || state.answersAt > prev.at || edited)) { skipped.waiting_for_answer++; continue; }
      } else if (prev.status === "shadow_planned") {
        if (state.shadowMode && !edited) { skipped.own_or_done++; continue; }
      } else if (prev.status === "pending_xero") {
        // n8n never reported back: try again after an hour (Xero's idempotency key stops a second bill).
        if (state.now - prev.at < 3_600_000) { skipped.own_or_done++; continue; }
      } else { skipped.own_or_done++; continue; }
    }
    if (b.InvoiceNumber) batchSeen.add(dk);
    found.push({ org, bill: b, key });
  }
  found.sort((a, c) => String(a.bill.DateString ?? a.bill.Date ?? "").localeCompare(String(c.bill.DateString ?? c.bill.Date ?? "")));
  return { picked: found.slice(0, state.maxBills), found: found.length, skipped };
}

// The bill as plain text, read by the AI when it has no file attached.
export function billText(org: Org, b: Json): string {
  const lines = (Array.isArray(b.LineItems) ? b.LineItems : []) as Json[];
  return [
    `Supplier bill already recorded in Xero (${org.tenantName}). No file was attached to it.`,
    `Supplier: ${(b.Contact as Json | undefined)?.Name ?? ""}`,
    `Invoice number: ${b.InvoiceNumber ?? ""}`,
    `Invoice date: ${String(b.DateString ?? "").slice(0, 10)}`,
    `Due date: ${String(b.DueDateString ?? "").slice(0, 10)}`,
    `Reference: ${b.Reference ?? ""}`,
    `Currency: ${b.CurrencyCode ?? "GBP"}`,
    `Amounts in the lines are: ${b.LineAmountTypes ?? ""}`,
    `Total: ${b.Total}`,
    "Lines:",
    ...lines.map((l, i) => `${i + 1}. ${l.Description ?? ""} | ${l.LineAmount}`),
  ].join("\n");
}
