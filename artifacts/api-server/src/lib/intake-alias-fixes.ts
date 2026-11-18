import { companyAliasesTable, getDb, propertyAliasesTable } from "@workspace/db";
import { containsSeq, tokens } from "./bill-coding-rules";
import { XERO_ORGANISATION_NAMES, intakeCompanyMatcher } from "./intake-rules";

// Inbox tab (Invoices page): for a bounced or for-review email, the names on the
// invoice that an alias would fix, and whether one has been added since.
//   company  -> Property aliases > Company names: who the invoice is addressed to.
//               The intake check reads these, so the next invoice passes.
//   spelling -> Property aliases > Spellings: a property written only in part on a
//               line ("127 Alwold"). Bill coding reads these to place the line.
// A bounce whose every problem is covered by an alias counts as fixed, so it
// leaves the Bounced list.

export type AliasFix = { kind: "company" | "spelling"; text: string; added: boolean; means: string | null };

type Issue = { code?: unknown; lines?: { reference?: unknown }[] };
type StoredIssues = { issues?: { issues?: Issue[] }[]; review?: Issue[] };

// Problems an alias can clear. Anything else (no invoice number, totals that
// don't add up, a line with no property at all) needs a corrected invoice.
const COMPANY_CODES = new Set(["bill_to_wrong", "alias_file_unreadable"]);
const SPELLING_CODES = new Set(["property_incomplete"]);

export type AliasLookup = {
  company: (name: string) => string;
  spelling: (text: string) => string;
};

export async function loadAliasLookup(): Promise<AliasLookup> {
  const [companyRows, propertyRows] = await Promise.all([
    getDb().select({ alias: companyAliasesTable.alias, tenantId: companyAliasesTable.xeroTenantId }).from(companyAliasesTable),
    getDb().select().from(propertyAliasesTable),
  ]);
  const matcher = intakeCompanyMatcher(companyRows.map((row) => ({ alias: row.alias, organisation: XERO_ORGANISATION_NAMES[row.tenantId] ?? "" })));
  // Same aliases bill coding uses: text spellings with a company and a property (or company cost).
  const spellings = propertyRows
    .filter((row) => row.kind === "text" && row.xeroTenantId && XERO_ORGANISATION_NAMES[row.xeroTenantId] && (row.xeroTrackingOption || row.overhead))
    .map((row) => ({
      tokens: row.normalizedAlias.split(" ").filter(Boolean),
      means: `${row.overhead ? "Company cost" : row.xeroTrackingOption} · ${XERO_ORGANISATION_NAMES[row.xeroTenantId!]}`,
    }));
  return {
    company: (name) => matcher.match(name),
    spelling: (text) => {
      const t = tokens(text);
      let best: (typeof spellings)[number] | null = null;
      for (const a of spellings) if (containsSeq(t, a.tokens) && (!best || a.tokens.length > best.tokens.length)) best = a;
      return best?.means ?? "";
    },
  };
}

export function aliasFixesFor(row: { verdict: string; billTo: string | null; issues: unknown }, lookup: AliasLookup): { aliasFixes: AliasFix[]; fixedByAlias: boolean } {
  if (row.verdict !== "bounce" && row.verdict !== "review") return { aliasFixes: [], fixedByAlias: false };
  const stored = (row.issues ?? {}) as StoredIssues;
  const all: Issue[] = [...(stored.issues ?? []).flatMap((doc) => doc?.issues ?? []), ...(stored.review ?? [])];
  const fixes: AliasFix[] = [];
  const seen = new Set<string>();
  const add = (kind: AliasFix["kind"], text: string) => {
    const clean = text.replace(/\s+/g, " ").trim();
    const key = `${kind}|${clean.toLowerCase()}`;
    if (!clean || seen.has(key)) return;
    seen.add(key);
    const means = kind === "company" ? lookup.company(clean) : lookup.spelling(clean);
    fixes.push({ kind, text: clean, added: !!means, means: means || null });
  };
  let otherProblems = false;
  for (const issue of all) {
    const code = String(issue?.code ?? "");
    if (COMPANY_CODES.has(code)) add("company", row.billTo ?? "");
    else if (SPELLING_CODES.has(code)) for (const line of issue.lines ?? []) add("spelling", String(line?.reference ?? ""));
    else otherProblems = true;
  }
  const fixedByAlias = row.verdict === "bounce" && !otherProblems && fixes.length > 0 && fixes.every((fix) => fix.added);
  return { aliasFixes: fixes, fixedByAlias };
}
