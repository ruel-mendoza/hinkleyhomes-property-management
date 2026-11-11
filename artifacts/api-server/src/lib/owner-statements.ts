import { readXeroGatewayEnv } from "./integrations-env";
import { findPayouts, type PaymentFound } from "./owner-payments";
import { rentalNinjaGet, rentalNinjaList } from "./rental-ninja";

// Owner statements (Rental Ninja) for one month. Each statement splits a
// landlord's booking income between the landlord, Hinkley's fee (Hinkley Homes
// Management or Lettings), housekeeping (H-H-M Housekeeping) and anyone else.
// Rental Ninja records no payments, so whether a payout was paid comes from Xero.

type RnPayout = { id: number; payee?: { id?: number; name?: string } | null; income?: number; expenses?: number; net?: number };
type RnStatement = { id: number; name?: string; start?: string; end?: string; total_income?: number | null; to_review?: boolean; payouts?: RnPayout[] };

type Role = "fee" | "housekeeping" | "landlord";
const FEE_PAYEE = /hinkley homes (management|lettings)/i;
const HOUSEKEEPING_PAYEE = /housekeeping|maid in|cleaning/i;
const roleOf = (name: string): Role => (FEE_PAYEE.test(name) ? "fee" : HOUSEKEEPING_PAYEE.test(name) ? "housekeeping" : "landlord");
// Rental Ninja also lists placeholder payees such as "x", "Guest" or "VAT Assigned".
const PLACEHOLDER_PAYEE = /^(x|guest|vat assigned|-.*commission)$/i;

const round = (value: number) => Math.round(value * 100) / 100;
const sum = (items: RnPayout[], pick: (payout: RnPayout) => number) => round(items.reduce((total, payout) => total + pick(payout), 0));
// "2026-08 - All Axis Property Ltd statements" -> "All Axis Property Ltd"
const cleanName = (name: string) => name.replace(/^\s*\d{4}\s*-\s*\d{2}\s*-\s*/, "").replace(/\s+statements?\s*$/i, "").trim() || name;

function summarise(statement: RnStatement) {
  const payouts = statement.payouts ?? [];
  const named = (payout: RnPayout) => payout.payee?.name?.trim() ?? "";
  const byRole = (role: Role) => payouts.filter((payout) => roleOf(named(payout)) === role);
  const fee = byRole("fee");
  const housekeeping = byRole("housekeeping");
  const people = byRole("landlord");
  // The landlord is the biggest remaining payout that isn't a placeholder; others are "other".
  const candidates = people.filter((payout) => !PLACEHOLDER_PAYEE.test(named(payout)));
  const landlord = [...candidates].sort((a, b) => Math.abs(b.income ?? 0) - Math.abs(a.income ?? 0))[0];
  const others = people.filter((payout) => payout !== landlord);
  const feeCompanies = [...new Set(fee.map((payout) => (/lettings/i.test(named(payout)) ? "Lettings" : "Management")))];
  return {
    id: statement.id,
    name: statement.name ?? `Statement ${statement.id}`,
    landlord: landlord ? named(landlord) : cleanName(statement.name ?? ""),
    start: statement.start ?? "",
    end: statement.end ?? "",
    income: typeof statement.total_income === "number" ? round(statement.total_income) : null,
    landlordCosts: landlord ? round(-(landlord.expenses ?? 0)) : 0,
    hinkleyFee: sum(fee, (payout) => payout.net ?? 0),
    feeCompany: feeCompanies.length ? feeCompanies.join(" and ") : null,
    housekeeping: sum(housekeeping, (payout) => payout.net ?? 0),
    other: sum(others, (payout) => payout.net ?? 0),
    landlordNet: landlord ? round(landlord.net ?? 0) : 0,
    toReview: statement.to_review === true,
    payment: null as PaymentFound | null,
  };
}

const ukToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());

const ukMonth = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(date).slice(0, 7);
export function lastMonth(): string {
  const [year, month] = ukMonth(new Date()).split("-").map(Number);
  return new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7);
}

// Statements change rarely once a month has closed, and the Xero payout check
// costs 10+ n8n executions, so keep each month 30 minutes.
const CACHE_MS = 30 * 60_000;
const cache = new Map<string, { at: number; body: Awaited<ReturnType<typeof loadMonth>> }>();

async function loadMonth(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const end = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  // The list filter matches overlapping periods, so keep only statements that start in the month.
  const listed = (await rentalNinjaList<RnStatement>("/accounting/statements", { from: `${month}-01`, to: end })).filter((statement) => statement.start?.startsWith(month));
  // Payouts only come with each statement's own record; read them five at a time.
  const detailed: RnStatement[] = [];
  for (let index = 0; index < listed.length; index += 5) {
    const batch = await Promise.all(listed.slice(index, index + 5).map((statement) => rentalNinjaGet<{ data: RnStatement }>(`/accounting/statements/${statement.id}`).then((body) => body.data)));
    detailed.push(...batch);
  }
  const statements = detailed.map(summarise).sort((a, b) => a.landlord.localeCompare(b.landlord, "en-GB"));
  // Look for each landlord payout in Xero; the statements still show if Xero can't be read.
  let xeroError: string | null = null;
  const gateway = readXeroGatewayEnv();
  if (gateway.status !== "configured") {
    xeroError = "Payouts can't be checked: the n8n Xero gateway isn't configured.";
  } else {
    try {
      const payments = await findPayouts(
        statements.filter((statement) => statement.end).map((statement) => ({ statementId: statement.id, landlord: statement.landlord, net: statement.landlordNet, end: statement.end })),
        ukToday(),
      );
      for (const statement of statements) statement.payment = payments.get(statement.id) ?? null;
    } catch (error) {
      xeroError = `Payouts couldn't be checked in Xero: ${(error as Error).message}`;
    }
  }
  const total = (pick: (statement: (typeof statements)[number]) => number) => round(statements.reduce((acc, statement) => acc + pick(statement), 0));
  return {
    month,
    asOf: new Date().toISOString(),
    statements,
    income: total((statement) => statement.income ?? 0),
    landlordCosts: total((statement) => statement.landlordCosts),
    hinkleyFee: total((statement) => statement.hinkleyFee),
    housekeeping: total((statement) => statement.housekeeping),
    landlordNet: total((statement) => statement.landlordNet),
    toReview: statements.filter((statement) => statement.toReview).length,
    xeroError,
  };
}

export async function ownerStatements(month: string, refresh = false) {
  const cached = cache.get(month);
  if (!refresh && cached && Date.now() - cached.at < CACHE_MS) return cached.body;
  const body = await loadMonth(month);
  // A failed Xero check is retried on the next load rather than kept for 10 minutes.
  if (!body.xeroError) cache.set(month, { at: Date.now(), body });
  return body;
}
