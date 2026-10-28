import { Router, type IRouter } from "express";
import { GetMoneyOverviewResponse, GetRevenueTrendResponse } from "@workspace/api-zod";
import { cohoApiKey, readXeroGatewayEnv } from "../lib/integrations-env";
import { cohoGet } from "../lib/coho-api";
import { parseXeroDate, xeroGatewayRequest } from "../lib/xero-gateway";
import { rentMatchingData, suggestPayments, type BankLine } from "../lib/rent-matching";

// Money section of the Operations overview.
// COHO (Public API v1.1) is the source for tenant money: rent collection,
// arrears (credit control), deposits and rent reviews. Xero, through the n8n
// gateway, is the source for banking: unreconciled transactions per company
// and, once the gateway's "Xero reports" credential is set up, bank balances.
// Both are read-only here, and each source fails on its own.

type RecordValue = Record<string, unknown>;
const asRecord = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
const list = (value: unknown): RecordValue[] => (Array.isArray(value) ? value.map(asRecord) : []);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const amount = (value: unknown): number | null => {
  const parsed = typeof value === "string" ? Number(value.replace(/,/g, "")) : value;
  return num(parsed);
};

const ukDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" });
const toUkDate = (value: unknown): string | null => {
  const text = str(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : ukDate.format(date);
};
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const RENT_REVIEW_DAYS = 28;

// The five Xero organisations. Notes mark companies that don't hold tenant
// rent or deposits, so their banking isn't read as property money.
export const COMPANIES = [
  { tenantId: "47f65b32-d0d7-4417-bb5c-89ff2d93651e", name: "Hinkley Homes Lettings", holdsPropertyMoney: true, note: null },
  { tenantId: "3ae8a283-c7e0-4287-9bcd-4c2561295890", name: "Hinkley Homes Holdings", holdsPropertyMoney: true, note: null },
  { tenantId: "9d1fee42-4203-47d8-87aa-6fa8e8ac0fef", name: "Hinkley Homes Ltd", holdsPropertyMoney: true, note: null },
  {
    tenantId: "0a290129-b001-4bfb-903d-d27a8ac55738",
    name: "Hinkley Homes Management",
    holdsPropertyMoney: false,
    note: "Does not hold property money: management fees and running costs only.",
  },
  {
    tenantId: "4c807578-e0a7-49ad-9644-8e705aec0c2a",
    name: "Hinkley Homes Stays",
    holdsPropertyMoney: false,
    note: "Does not hold property money: short-stay bookings, not tenant rent or deposits.",
  },
] as const;

// --- COHO --------------------------------------------------------------------------

async function allPages(path: string): Promise<RecordValue[]> {
  const items: RecordValue[] = [];
  for (let page = 1; page <= 20; page++) {
    const payload = asRecord(await cohoGet(`${path}${path.includes("?") ? "&" : "?"}page=${page}&pageSize=100`));
    items.push(...list(payload.items));
    if (payload.hasNextPage !== true) break;
  }
  return items;
}

async function cohoMoney() {
  // COHO answers some paths with 404 when there is no query string; "_=0" is ignored.
  const [collection, arrears, depositSummary, deposits, tenancies, reviews] = await Promise.all([
    cohoGet("/rent-collection/overview?_=0").then(asRecord),
    allPages("/credit-control/tenancies?scope=overdue"),
    cohoGet("/deposits/summary?_=0").then(asRecord),
    allPages("/deposits?category=Active"),
    allPages("/tenancies?includeCurrent=true"),
    allPages("/rent-review/tenancies?dueDays=All"),
  ]);
  const summary = asRecord(collection.rentCollectionSummary);
  const today = ukDate.format(new Date());
  // Unmatched bank lines for the same amount suggest the rent may already be paid.
  // Best effort: arrears still show if the bank feed can't be read.
  let suggestions = new Map<string, BankLine>();
  try {
    const feed = await rentMatchingData(`${Number(today.slice(0, 4)) - 1}${today.slice(4, 8)}01`);
    suggestions = suggestPayments(feed.arrears, feed.lines, today);
  } catch {
    // Leave suggestions empty.
  }
  const reviewHorizon = addDays(today, RENT_REVIEW_DAYS);
  const withDeposit = new Set(deposits.map((deposit) => str(deposit.tenancyGuid)));
  const propertyNames = new Map<string, string>();
  for (const item of [...arrears, ...deposits, ...reviews]) {
    const reference = str(item.propertyReference);
    const name = str(item.propertyName) ?? str(item.name);
    if (reference && name) propertyNames.set(reference, name);
  }

  return {
    error: null,
    paidThisMonth: num(summary.amountPaidThisMonth) ?? 0,
    dueThisMonth: num(summary.amountDueThisMonth) ?? 0,
    dueNextMonth: num(summary.amountDueNextMonth) ?? 0,
    dueToday: num(summary.amountDueToday) ?? 0,
    overdue: num(summary.amountOverdue) ?? 0,
    arrears: arrears
      .filter((item) => item.exclude !== true && (num(item.totalOutstanding) ?? 0) > 0)
      .map((item) => ({
        propertyReference: str(item.propertyReference) ?? "",
        propertyName: str(item.propertyName) ?? "Unknown property",
        tenantName: str(item.tenantName),
        outstanding: num(item.totalOutstanding) ?? 0,
        daysInArrears: Math.max(Math.trunc(num(item.daysInArrears) ?? 0), 0),
        earliestDue: toUkDate(item.earliestDateDue),
        possiblePayment: (() => {
          const line = suggestions.get(String(item.tenancyGuid));
          return line ? { date: line.date, amount: line.amount, payer: line.payer, reference: line.reference ?? line.description } : null;
        })(),
      }))
      .sort((a, b) => b.daysInArrears - a.daysInArrears || b.outstanding - a.outstanding),
    depositsHeld: num(depositSummary.active) ?? 0,
    depositsHeldTotal: num(depositSummary.activeTotal) ?? 0,
    depositsPending: num(depositSummary.pending) ?? 0,
    depositsClosing: num(depositSummary.closing) ?? 0,
    depositsClosingOverdue: num(depositSummary.closingOverdue) ?? 0,
    tenanciesWithoutDeposit: tenancies
      .filter((tenancy) => tenancy.status === "active" && !withDeposit.has(str(tenancy.guid)))
      .map((tenancy) => {
        const reference = str(tenancy.propertyReference) ?? "";
        return { propertyReference: reference, propertyName: propertyNames.get(reference) ?? reference };
      }),
    rentReviews: reviews
      .map((review) => ({ review, next: toUkDate(review.nextRentReview) }))
      .filter((entry): entry is { review: RecordValue; next: string } => Boolean(entry.next && entry.next <= reviewHorizon))
      .map(({ review, next }) => ({
        propertyReference: str(review.propertyReference) ?? "",
        propertyName: str(review.name) ?? "Unknown property",
        currentRent: num(review.currentRent),
        paymentFrequency: str(review.paymentFrequency),
        nextReview: next,
        overdue: next < today,
      }))
      .sort((a, b) => a.nextReview.localeCompare(b.nextReview)),
  };
}

// --- Xero ----------------------------------------------------------------------------

// Bank Summary rows: one per bank account with opening balance, cash received,
// cash spent and closing balance. Columns are found by their header text.
export function parseBankSummary(data: unknown) {
  const rows = list(asRecord(list(asRecord(data).Reports)[0]).Rows);
  const header = list(rows.find((row) => row.RowType === "Header")?.Cells).map((cell) => String(cell.Value ?? "").toLowerCase());
  const column = (word: string) => header.findIndex((label) => label.includes(word));
  const [received, spent, closing] = [column("received"), column("spent"), column("closing")];
  return rows
    .filter((row) => row.RowType === "Section")
    .flatMap((section) => list(section.Rows))
    .filter((row) => row.RowType === "Row")
    .map((row) => {
      const cells = list(row.Cells);
      const value = (index: number) => (index >= 0 ? amount(cells[index]?.Value) : null);
      const accountId = str(list(cells[0]?.Attributes).find((attribute) => attribute.Id === "accountID")?.Value);
      return { accountId, name: str(cells[0]?.Value) ?? "Bank account", balance: value(closing), moneyIn: value(received), moneyOut: value(spent) };
    });
}

// Xero marks payment platforms (Stripe, PayPal…) as ordinary BANK accounts, so
// they are told apart by name; cards come from Xero's BankAccountType.
type AccountKind = "bank" | "card" | "payments";
const PAYMENT_PLATFORM = /stripe|paypal|gocardless|telleroo|square|sumup|worldpay/i;
const accountKind = (name: string, bankAccountType: string | null): AccountKind =>
  bankAccountType === "CREDITCARD" ? "card" : PAYMENT_PLATFORM.test(name) ? "payments" : "bank";
// A payment platform should pay out to the bank regularly; above this it is worth a look.
const PAYMENTS_BALANCE_ALERT = 10_000;
const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const joinNames = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "");

function bankingNotices(name: string, accounts: { name: string; kind: AccountKind; balance: number | null }[], bankTotal: number | null): string[] {
  const notices: string[] = [];
  // Cards and platforms sitting at £0 don't distort anything, so they aren't mentioned.
  const nonZero = (kind: AccountKind) => accounts.filter((account) => account.kind === kind && (account.balance ?? 0) !== 0);
  const cards = nonZero("card");
  const platforms = nonZero("payments");
  if (cards.length || platforms.length) {
    const parts = [
      cards.length ? `${cards.length === 1 ? "a credit card" : `${cards.length} credit cards`} (${joinNames(cards.map((account) => account.name))})` : "",
      platforms.length ? `${platforms.length === 1 ? "a payment platform account" : "payment platform accounts"} (${joinNames(platforms.map((account) => account.name))})` : "",
    ].filter(Boolean);
    notices.push(
      `Xero's bank summary for ${name} mixes real bank accounts with ${parts.join(" and ")}. ` +
        `The bank total here (${bankTotal === null ? "—" : gbp.format(bankTotal)}) counts real bank accounts only; cards and payment platforms are listed separately.`,
    );
  }
  for (const account of platforms) {
    if (account.balance !== null && Math.abs(account.balance) >= PAYMENTS_BALANCE_ALERT) {
      notices.push(`${account.name} (${name}) shows ${gbp.format(account.balance)}. A payment platform balance this high usually means payouts aren't being matched to the bank in Xero. Please check.`);
    }
  }
  return notices;
}

async function companyBanking(company: (typeof COMPANIES)[number]) {
  const base = {
    tenantId: company.tenantId,
    name: company.name,
    holdsPropertyMoney: company.holdsPropertyMoney,
    note: company.note,
    error: null as string | null,
    unreconciledCount: 0,
    unreconciledIn: 0,
    unreconciledOut: 0,
    oldestUnreconciled: null as string | null,
    bankAccounts: [] as { name: string; kind: AccountKind; balance: number | null; moneyIn: number | null; moneyOut: number | null }[],
    balancesError: null as string | null,
    bankTotal: null as number | null,
    notices: [] as string[],
  };
  const today = ukDate.format(new Date());
  const [transactions, summary, accounts] = await Promise.all([
    (async () => {
      const items: RecordValue[] = [];
      for (let page = 1; page <= 10; page++) {
        const response = await xeroGatewayRequest({
          tenantId: company.tenantId,
          resource: "bankTransactions",
          query: { where: 'IsReconciled==false&&Status=="AUTHORISED"', page, pageSize: 100 },
        });
        if (!response.ok) throw new Error(response.status === 429 ? "Xero is rate limiting; try again shortly." : `Xero returned HTTP ${response.status}.`);
        const batch = list(asRecord(response.data).BankTransactions);
        items.push(...batch);
        if (batch.length < 100) break;
      }
      return items;
    })().catch((error: unknown) => error as Error),
    xeroGatewayRequest({ tenantId: company.tenantId, resource: "bankSummary", query: { fromDate: `${today.slice(0, 8)}01`, toDate: today } }).catch(
      (error: unknown) => error as Error,
    ),
    // Only needed to spot credit cards; without it every account counts as a bank account.
    xeroGatewayRequest({ tenantId: company.tenantId, resource: "accounts", query: { where: 'Type=="BANK"' } })
      .then((response) => new Map(list(asRecord(response.data).Accounts).map((account) => [str(account.AccountID), str(account.BankAccountType)])))
      .catch(() => new Map<string | null, string | null>()),
  ]);

  if (transactions instanceof Error) {
    base.error = transactions.message;
  } else {
    for (const transaction of transactions) {
      const total = num(transaction.Total) ?? 0;
      if (String(transaction.Type).startsWith("RECEIVE")) base.unreconciledIn += total;
      else base.unreconciledOut += total;
      const date = parseXeroDate(transaction.Date);
      const day = date ? date.toISOString().slice(0, 10) : null;
      if (day && (!base.oldestUnreconciled || day < base.oldestUnreconciled)) base.oldestUnreconciled = day;
    }
    base.unreconciledCount = transactions.length;
    base.unreconciledIn = Math.round(base.unreconciledIn * 100) / 100;
    base.unreconciledOut = Math.round(base.unreconciledOut * 100) / 100;
  }

  if (summary instanceof Error) {
    base.balancesError = summary.message;
  } else if (!summary.ok) {
    base.balancesError =
      summary.status === 400
        ? "Import the updated n8n Xero gateway to show bank balances."
        : [401, 403, 502].includes(summary.status)
          ? "Bank balances need Xero's reports permission on the n8n \"Xero reports\" credential."
          : `Xero returned HTTP ${summary.status} for the bank summary.`;
  } else {
    base.bankAccounts = parseBankSummary(summary.data).map(({ accountId, ...account }) => ({
      ...account,
      kind: accountKind(account.name, accounts.get(accountId) ?? null),
    }));
    const bankBalances = base.bankAccounts.filter((account) => account.kind === "bank" && account.balance !== null);
    base.bankTotal = Math.round(bankBalances.reduce((sum, account) => sum + (account.balance ?? 0), 0) * 100) / 100;
    base.notices = bankingNotices(company.name, base.bankAccounts, base.bankTotal);
  }
  return base;
}

// --- Revenue trend (Xero profit and loss) --------------------------------------------

const TREND_MONTHS = 6;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const round2 = (value: number) => Math.round(value * 100) / 100;

// The last TREND_MONTHS months as YYYY-MM, oldest first, ending with this UK month.
function trendMonths(): string[] {
  const [year, month] = ukDate.format(new Date()).split("-").map(Number);
  return Array.from({ length: TREND_MONTHS }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 1 - (TREND_MONTHS - 1 - index), 1));
    return date.toISOString().slice(0, 7);
  });
}

// Xero's monthly P&L has one column per month, newest first, headed like
// "31 Oct 26". Revenue is every "Total … Income" summary row (trading and other
// income); net profit is the "Net Profit" row, and expenses are the difference,
// so cost of sales, operating and other expenses are all included.
export function parseProfitAndLoss(data: unknown, months: string[]) {
  const rows = list(asRecord(list(asRecord(data).Reports)[0]).Rows);
  const header = list(rows.find((row) => row.RowType === "Header")?.Cells).slice(1).map((cell) => String(cell.Value ?? ""));
  const columnMonth = header.map((label, index) => {
    const match = label.toLowerCase().match(/([a-z]{3})[a-z]*\s+(\d{2,4})\s*$/);
    const monthIndex = match ? MONTHS.indexOf(match[1]) : -1;
    if (!match || monthIndex < 0) return months[months.length - 1 - index] ?? null;
    const year = match[2].length === 2 ? 2000 + Number(match[2]) : Number(match[2]);
    return `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
  });
  const revenue = new Map<string, number>();
  const expenses = new Map<string, number>();
  const net = new Map<string, number>();
  const add = (map: Map<string, number>, cells: RecordValue[]) =>
    cells.slice(1).forEach((cell, index) => {
      const month = columnMonth[index];
      if (month) map.set(month, (map.get(month) ?? 0) + (amount(cell.Value) ?? 0));
    });
  const walk = (items: RecordValue[]) => {
    for (const row of items) {
      if (row.RowType === "Section") walk(list(row.Rows));
      if (row.RowType !== "Row" && row.RowType !== "SummaryRow") continue;
      const cells = list(row.Cells);
      const label = String(cells[0]?.Value ?? "").trim();
      if (/^net (profit|loss)/i.test(label)) add(net, cells);
      else if (row.RowType === "SummaryRow" && /^total\b.*\bincome$/i.test(label)) add(revenue, cells);
      else if (row.RowType === "SummaryRow" && /^total\b.*\b(expenses|cost of sales)$/i.test(label)) add(expenses, cells);
    }
  };
  walk(rows);
  return months.map((month) => {
    const income = revenue.get(month) ?? 0;
    const netProfit = net.has(month) ? net.get(month)! : income - (expenses.get(month) ?? 0);
    return { month, revenue: round2(income), expenses: round2(income - netProfit), netProfit: round2(netProfit) };
  });
}

async function companyTrend(company: (typeof COMPANIES)[number], months: string[]) {
  const base = { tenantId: company.tenantId, name: company.name, error: null as string | null, months: [] as ReturnType<typeof parseProfitAndLoss> };
  const last = months[months.length - 1];
  const [year, month] = last.split("-").map(Number);
  const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  try {
    const response = await xeroGatewayRequest({
      tenantId: company.tenantId,
      resource: "profitAndLoss",
      query: { fromDate: `${last}-01`, toDate: monthEnd, periods: months.length - 1, timeframe: "MONTH" },
    });
    if (!response.ok) {
      base.error =
        response.status === 429
          ? "Xero is rate limiting; try again shortly."
          : [401, 403, 502].includes(response.status)
            ? "Profit and loss needs Xero's reports permission on the n8n \"Xero reports\" credential."
            : `Xero returned HTTP ${response.status} for the profit and loss report.`;
      return base;
    }
    base.months = parseProfitAndLoss(response.data, months);
  } catch (error) {
    base.error = (error as Error).message;
  }
  return base;
}

// --- Route ---------------------------------------------------------------------------

// Says which secret is missing or wrong (names only, never values), so a
// deployment without the gateway secrets is easy to fix.
function gatewaySetupError(gateway: ReturnType<typeof readXeroGatewayEnv>): string {
  if (gateway.status === "invalid") return `The n8n Xero gateway settings need fixing: ${gateway.problems.join("; ")}.`;
  return "The n8n Xero gateway is not configured: add the N8N_XERO_GATEWAY_URL and N8N_XERO_GATEWAY_KEY secrets to this deployment and redeploy.";
}

const CACHE_MS = 5 * 60_000;
let cache: { at: number; body: unknown } | null = null;

const moneyRouter: IRouter = Router();

moneyRouter.get("/overview/money", async (req, res): Promise<void> => {
  if (cache && Date.now() - cache.at < CACHE_MS && req.query.refresh !== "1") {
    res.json(cache.body);
    return;
  }
  const emptyCoho = {
    paidThisMonth: 0, dueThisMonth: 0, dueNextMonth: 0, dueToday: 0, overdue: 0, arrears: [],
    depositsHeld: 0, depositsHeldTotal: 0, depositsPending: 0, depositsClosing: 0, depositsClosingOverdue: 0,
    tenanciesWithoutDeposit: [], rentReviews: [],
  };
  const gateway = readXeroGatewayEnv();
  const [coho, xero] = await Promise.all([
    cohoApiKey()
      ? cohoMoney().catch((error: unknown) => {
          req.log.warn({ err: error }, "COHO money overview unavailable");
          return { ...emptyCoho, error: "COHO could not be reached." };
        })
      : Promise.resolve({ ...emptyCoho, error: "COHO_API_KEY is not configured." }),
    gateway.status === "configured"
      ? Promise.all(COMPANIES.map(companyBanking)).then((companies) => ({ error: null, companies }))
      : Promise.resolve({ error: gatewaySetupError(gateway), companies: [] as Awaited<ReturnType<typeof companyBanking>>[] }),
  ]);
  const body = GetMoneyOverviewResponse.parse({ asOf: new Date().toISOString(), coho, xero });
  // Only cache complete answers, so a COHO or Xero blip is retried on the next load.
  const failed = coho.error || xero.error || xero.companies.some((company) => company.error);
  cache = failed ? null : { at: Date.now(), body };
  res.json(body);
});

// P&L moves slowly and costs one Xero report call per company, so it is kept longer.
const TREND_CACHE_MS = 30 * 60_000;
let trendCache: { at: number; body: unknown } | null = null;

moneyRouter.get("/overview/revenue-trend", async (req, res): Promise<void> => {
  if (trendCache && Date.now() - trendCache.at < TREND_CACHE_MS && req.query.refresh !== "1") {
    res.json(trendCache.body);
    return;
  }
  const months = trendMonths();
  const gateway = readXeroGatewayEnv();
  const companies = gateway.status === "configured" ? await Promise.all(COMPANIES.map((company) => companyTrend(company, months))) : [];
  const error = gateway.status === "configured" ? null : gatewaySetupError(gateway);
  const body = GetRevenueTrendResponse.parse({ asOf: new Date().toISOString(), months, error, companies });
  trendCache = error || companies.some((company) => company.error) ? null : { at: Date.now(), body };
  res.json(body);
});

export default moneyRouter;
