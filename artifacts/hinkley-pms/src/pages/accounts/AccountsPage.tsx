import { Link } from "wouter";
import { AlertTriangle, ExternalLink } from "lucide-react";
import {
  getGetMoneyOverviewQueryKey,
  getGetRevenueTrendQueryKey,
  getGetTrackingOptionsQueryKey,
  useGetMoneyOverview,
  useGetReceivables,
  useGetRevenueTrend,
  useGetTrackingOptions,
  type MoneyCompany,
} from "@workspace/api-client-react";
import { monthLabel } from "@/components/charts/MonthlyBars";
import { formatDate } from "@/services/properties";
import { CompanyTag, receivablesQueryOptions } from "@/pages/finance/XeroLedger";
import "./accounts.css";

// Accounts: a month-end view of the five Xero companies for the bookkeepers.
// Everything is read from Xero through existing endpoints; nothing is changed in Xero.

const pounds = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
const pence = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const ukToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
// The last day of the previous UK month, e.g. "2026-10-31".
const lastMonthEnd = (today: string) => new Date(Date.parse(`${today.slice(0, 8)}01T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const shortDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
// Same threshold the server uses for its payment-platform notice.
const PLATFORM_ALERT = 10_000;

const moneyQueryOptions = { query: { queryKey: getGetMoneyOverviewQueryKey(), staleTime: 5 * 60_000 } };
const trendQueryOptions = { query: { queryKey: getGetRevenueTrendQueryKey(), staleTime: 15 * 60_000, retry: false } };
const trackingQueryOptions = { query: { queryKey: getGetTrackingOptionsQueryKey(), staleTime: 10 * 60_000 } };

type CheckState = "ok" | "warn" | "bad" | "unknown";
type Check = { state: CheckState; label: string; detail?: string };
type CompanyChecks = { company: MoneyCompany; reconciled: Check; platforms: Check; bills: Check; tracking: Check };
const STATUS_CLASS: Record<CheckState, string> = { ok: "completed", warn: "pending", bad: "overdue", unknown: "" };
const MONEY_HELD = { client: "Client money", own: "Own income" } as const;

// The month-end checks for every company, shared by the page and the Overview strip.
function useMonthEnd() {
  const money = useGetMoneyOverview(moneyQueryOptions);
  const receivables = useGetReceivables(receivablesQueryOptions);
  const tracking = useGetTrackingOptions(trackingQueryOptions);
  const today = ukToday();
  const monthEnd = lastMonthEnd(today);
  const monthStartLabel = shortDate(`${today.slice(0, 8)}01`);
  const companies = money.data?.xero.companies ?? [];

  const rows: CompanyChecks[] = companies.map((company) => {
    const reconciled: Check = company.error ? { state: "unknown", label: "Couldn't check", detail: company.error }
      : company.unreconciledBeforeMonth === 0 ? { state: "ok", label: "Up to date" }
        : { state: "bad", label: plural(company.unreconciledBeforeMonth, "line"), detail: `Unreconciled from before ${monthStartLabel}${company.oldestUnreconciled ? `, oldest ${formatDate(company.oldestUnreconciled)}` : ""}` };

    const platformAccounts = company.bankAccounts.filter((account) => account.kind === "payments");
    const waiting = platformAccounts.reduce((sum, account) => sum + Math.abs(account.balance ?? 0), 0);
    const platforms: Check = company.balancesError ? { state: "unknown", label: "Couldn't check", detail: company.balancesError }
      : platformAccounts.length === 0 ? { state: "ok", label: "None in Xero" }
        : waiting === 0 ? { state: "ok", label: "Cleared" }
          : { state: waiting >= PLATFORM_ALERT ? "bad" : "warn", label: pounds.format(waiting), detail: `Still on ${platformAccounts.filter((account) => account.balance).map((account) => account.name).join(", ")}` };

    const companyBills = receivables.data?.bills.filter((bill) => bill.tenantId === company.tenantId && bill.status === "SUBMITTED") ?? [];
    const readError = receivables.data?.companies.find((item) => item.tenantId === company.tenantId)?.error;
    const bills: Check = !receivables.data ? { state: "unknown", label: receivables.isLoading ? "Checking…" : "Couldn't check" }
      : readError ? { state: "unknown", label: "Couldn't check", detail: readError }
        : companyBills.length === 0 ? { state: "ok", label: "None waiting" }
          : { state: companyBills.some((bill) => bill.daysOverdue > 0) ? "bad" : "warn", label: `${companyBills.length} awaiting approval`, detail: pence.format(companyBills.reduce((sum, bill) => sum + bill.amountDue, 0)) };

    const options = tracking.data?.companies.find((item) => item.tenantId === company.tenantId)?.options;
    const problem = tracking.data?.problems.find((item) => item.startsWith(`${company.name}:`));
    const category = tracking.data?.trackingCategory ?? "Property";
    const trackingCheck: Check = !tracking.data ? { state: "unknown", label: tracking.isLoading ? "Checking…" : "Couldn't check" }
      : options && options.length > 0 ? { state: "ok", label: `${options.length} properties` }
        : problem?.includes("could not read") ? { state: "unknown", label: "Couldn't check" }
          : { state: "bad", label: `No "${category}" category`, detail: "Bills can't be coded to a property in this company" };

    return { company, reconciled, platforms, bills, tracking: trackingCheck };
  });

  const checks = rows.flatMap((row) => [row.reconciled, row.platforms, row.bills, row.tracking]);
  return {
    money,
    receivables,
    today,
    monthEnd,
    monthStartLabel,
    rows,
    passing: checks.filter((check) => check.state === "ok").length,
    total: checks.length,
    beforeMonth: companies.reduce((sum, company) => sum + company.unreconciledBeforeMonth, 0),
    platformWaiting: companies.reduce((sum, company) => sum + company.bankAccounts.filter((account) => account.kind === "payments").reduce((total, account) => total + Math.abs(account.balance ?? 0), 0), 0),
    awaitingApproval: receivables.data?.bills.filter((bill) => bill.status === "SUBMITTED").length ?? 0,
  };
}

function CheckCell({ check }: { check: Check }) {
  return (
    <td>
      <span className={`status ${STATUS_CLASS[check.state]}`}>{check.label}</span>
      {check.detail && <small className="ac-detail">{check.detail}</small>}
    </td>
  );
}

function PanelState({ loading, failed, what }: { loading: boolean; failed: boolean; what: string }) {
  if (loading) return <div className="empty-state"><p>Loading {what} from Xero…</p></div>;
  if (failed) return <div className="empty-state"><h3>{what[0].toUpperCase() + what.slice(1)} could not be loaded</h3><p>Xero may be busy. Try again in a few minutes.</p></div>;
  return null;
}

export default function AccountsPage() {
  const view = useMonthEnd();
  const { money, receivables, rows } = view;
  const xeroError = money.data?.xero.error;
  // Only an element while loading or failed; null lets each panel show its content.
  const moneyState = money.isLoading || money.isError || !money.data ? <PanelState loading={money.isLoading} failed={!money.isLoading} what="banking" /> : null;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Hinkley Homes · Xero</div>
          <h1 className="page-title">Accounts</h1>
          <p className="page-sub">Month-end view of the five Xero companies: what still needs reconciling, clearing or fixing before {formatDate(view.monthEnd)} can be closed.</p>
        </div>
        <div className="head-actions"><a className="button" href="https://go.xero.com/" target="_blank" rel="noreferrer">Open Xero <ExternalLink size={13} /></a></div>
      </div>

      {xeroError && <div className="ac-banner"><AlertTriangle size={14} /> {xeroError}</div>}

      <div className="metrics">
        <div className="panel metric">
          <div className="metric-top">Month-end checks passing</div>
          <div className="metric-value">{money.data ? `${view.passing} of ${view.total}` : "—"}</div>
          <div className="metric-foot">Across all five companies</div>
        </div>
        <div className="panel metric">
          <div className="metric-top">Unreconciled before {view.monthStartLabel}</div>
          <div className="metric-value">{money.data ? view.beforeMonth : "—"}</div>
          <div className="metric-foot">Bank lines to reconcile in Xero</div>
        </div>
        <div className="panel metric">
          <div className="metric-top">Left on payment platforms</div>
          <div className="metric-value">{money.data ? pounds.format(view.platformWaiting) : "—"}</div>
          <div className="metric-foot">Stripe and similar, should be near £0</div>
        </div>
        <div className="panel metric">
          <div className="metric-top">Bills awaiting approval</div>
          <div className="metric-value">{receivables.data ? view.awaitingApproval : "—"}</div>
          <div className="metric-foot"><Link href="/bills?tab=pay">Supplier bills →</Link></div>
        </div>
      </div>

      <section className="panel ac-panel">
        <div className="panel-head">
          <div><div className="panel-title">Month-end checklist</div><div className="panel-caption">Each company should be green before {formatDate(view.monthEnd)} is closed</div></div>
        </div>
        {moneyState ?? (rows.length === 0 ? <div className="empty-state"><p>No Xero companies to show.</p></div> : (
          <div className="table-wrap">
            <table className="ac-table">
              <thead><tr><th>Company</th><th>Bank reconciled to {shortDate(view.monthEnd)}</th><th>Payment platforms cleared</th><th>Bills approved</th><th>Property tracking</th></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.company.tenantId}>
                    <td><CompanyTag tenantId={row.company.tenantId} name={row.company.name} /></td>
                    <CheckCell check={row.reconciled} />
                    <CheckCell check={row.platforms} />
                    <CheckCell check={row.bills} />
                    <CheckCell check={row.tracking} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      <div className="ac-grid">
        <Scorecard rows={rows} state={moneyState} today={view.today} />
        <Platforms companies={money.data?.xero.companies ?? []} state={moneyState} today={view.today} />
      </div>

      <ProfitAndLoss />
    </>
  );
}

function Scorecard({ rows, state, today }: { rows: CompanyChecks[]; state: React.ReactNode; today: string }) {
  const receivables = useGetReceivables(receivablesQueryOptions);
  return (
    <section className="panel ac-panel">
      <div className="panel-head">
        <div><div className="panel-title">Company scorecard</div><div className="panel-caption">Bank, unreconciled lines and what's owed, per company</div></div>
        <Link href="/receivables">Owed to us →</Link>
      </div>
      {state ?? (
        <div className="table-wrap">
          <table className="ac-table">
            <thead><tr><th>Company</th><th className="num">In the bank</th><th className="num">Unreconciled</th><th className="num">Owed to us, overdue</th><th className="num">Bills overdue</th></tr></thead>
            <tbody>
              {rows.map(({ company }) => {
                const owed = receivables.data?.companies.find((item) => item.tenantId === company.tenantId);
                const age = company.oldestUnreconciled ? daysBetween(company.oldestUnreconciled, today) : 0;
                return (
                  <tr key={company.tenantId}>
                    <td>
                      <CompanyTag tenantId={company.tenantId} name={company.name} />
                      <small className="ac-detail">{company.moneyHeld ? MONEY_HELD[company.moneyHeld] : "Money type not confirmed"}</small>
                    </td>
                    <td className="num">{company.bankTotal === null ? "—" : pounds.format(company.bankTotal)}</td>
                    <td className="num">
                      {company.error ? "—" : company.unreconciledCount}
                      {company.unreconciledCount > 0 && <small className={`ac-detail${age > 30 ? " bad" : ""}`}>oldest {age} days</small>}
                    </td>
                    <td className="num">{owed ? pounds.format(owed.receivableOverdue) : "—"}</td>
                    <td className="num">{owed ? pounds.format(owed.billsOverdue) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Platforms({ companies, state, today }: { companies: MoneyCompany[]; state: React.ReactNode; today: string }) {
  const accounts = companies.flatMap((company) => company.bankAccounts.filter((account) => account.kind === "payments").map((account) => ({ company, account })));
  const unavailable = companies.filter((company) => company.balancesError);
  return (
    <section className="panel ac-panel">
      <div className="panel-head">
        <div><div className="panel-title">Stripe &amp; payout clearing</div><div className="panel-caption">Payment platform balances should fall to about £0 once payouts are matched to the bank</div></div>
      </div>
      {state ?? (accounts.length === 0 ? (
        <div className="empty-state"><p>{unavailable.length ? "Balances aren't available from Xero yet." : "No payment platform accounts in Xero."}</p></div>
      ) : (
        <ul className="ac-platforms">
          {accounts.map(({ company, account }) => {
            const balance = account.balance ?? 0;
            const age = account.oldestUnreconciled ? daysBetween(account.oldestUnreconciled, today) : 0;
            const tone = Math.abs(balance) >= PLATFORM_ALERT || age > 30 ? "bad" : balance ? "warn" : "good";
            return (
              <li key={`${company.tenantId}-${account.name}`}>
                <div>
                  <strong>{account.name}</strong>
                  <CompanyTag tenantId={company.tenantId} name={company.name} />
                </div>
                <div className="ac-platform-figures">
                  <b className={tone}>{account.balance === null ? "—" : pence.format(balance)}</b>
                  <small>{account.unreconciledCount ? `${plural(account.unreconciledCount, "line")} to match · oldest ${formatDate(account.oldestUnreconciled)}` : "Nothing to match"}</small>
                </div>
              </li>
            );
          })}
        </ul>
      ))}
      {unavailable.length > 0 && accounts.length > 0 && <p className="ac-note"><AlertTriangle size={12} /> Not included: {unavailable.map((company) => company.name).join(", ")}</p>}
    </section>
  );
}

function ProfitAndLoss() {
  const trend = useGetRevenueTrend(trendQueryOptions);
  const data = trend.data;
  const readable = (data?.companies ?? []).filter((company) => !company.error);
  const failed = (data?.companies ?? []).filter((company) => company.error);
  const months = data?.months ?? [];
  const current = months.at(-1);
  const net = (tenantIds: string[], month: string) =>
    readable.filter((company) => tenantIds.includes(company.tenantId)).reduce((sum, company) => sum + (company.months.find((row) => row.month === month)?.netProfit ?? 0), 0);
  const total = (tenantIds: string[]) => months.reduce((sum, month) => sum + net(tenantIds, month), 0);
  const cell = (value: number, key?: string) => <td key={key} className={`num${value < 0 ? " ac-loss" : ""}`}>{pounds.format(value)}</td>;

  return (
    <section className="panel ac-panel">
      <div className="panel-head">
        <div><div className="panel-title">Profit &amp; loss</div><div className="panel-caption">Net profit per company per month, from Xero's profit and loss{current ? `; ${monthLabel(current)} is so far` : ""}</div></div>
      </div>
      {trend.isLoading ? <div className="empty-state"><p>Loading profit and loss from Xero…</p></div>
        : trend.isError || data?.error || readable.length === 0 ? (
          <div className="empty-state"><h3>Profit and loss isn't available</h3><p>{data?.error ?? failed[0]?.error ?? "Xero could not be read. Try again in a few minutes."}</p></div>
        ) : (
          <>
            <div className="table-wrap">
              <table className="ac-table">
                <thead><tr><th>Company</th>{months.map((month) => <th key={month} className="num">{monthLabel(month)}{month === current ? " (so far)" : ""}</th>)}<th className="num">6 months</th></tr></thead>
                <tbody>
                  {readable.map((company) => (
                    <tr key={company.tenantId}>
                      <td><CompanyTag tenantId={company.tenantId} name={company.name} /></td>
                      {months.map((month) => cell(net([company.tenantId], month), month))}
                      {cell(total([company.tenantId]))}
                    </tr>
                  ))}
                  <tr className="ac-total">
                    <td>All companies</td>
                    {months.map((month) => cell(net(readable.map((company) => company.tenantId), month), month))}
                    {cell(total(readable.map((company) => company.tenantId)))}
                  </tr>
                </tbody>
              </table>
            </div>
            {failed.length > 0 && <p className="ac-note"><AlertTriangle size={12} /> Not included: {failed.map((company) => company.name).join(", ")} ({failed[0].error})</p>}
          </>
        )}
    </section>
  );
}

// Overview strip: month-end progress across the five companies, with a link to Accounts.
export function AccountsStrip() {
  const view = useMonthEnd();
  const loaded = !!view.money.data;
  return (
    <section className="panel hh-perf-strip" aria-label="Accounts month end">
      <div><div className="panel-title">Accounts · month end</div><div className="panel-caption">Closing {formatDate(view.monthEnd)} in Xero</div></div>
      <div className="hh-perf-strip-stats">
        {view.money.isLoading ? <div><span>Loading…</span></div>
          : !loaded ? <div><span>Xero could not be read</span></div>
            : (
              <>
                <div><span>Checks passing</span><strong className={view.passing === view.total ? "good" : "warn"}>{view.passing} of {view.total}</strong></div>
                <div><span>Unreconciled before {view.monthStartLabel}</span><strong className={view.beforeMonth ? "bad" : "good"}>{view.beforeMonth}</strong></div>
                <div><span>On payment platforms</span><strong className={view.platformWaiting >= PLATFORM_ALERT ? "bad" : view.platformWaiting ? "warn" : "good"}>{pounds.format(view.platformWaiting)}</strong></div>
              </>
            )}
      </div>
      <div className="hh-perf-strip-links"><Link href="/accounts" className="button">Accounts</Link></div>
    </section>
  );
}
