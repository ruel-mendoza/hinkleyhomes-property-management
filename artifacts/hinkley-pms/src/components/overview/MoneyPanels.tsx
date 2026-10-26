import { useState, type ReactNode } from "react";
import { AlertTriangle, Landmark, PoundSterling } from "lucide-react";
import { Link } from "wouter";
import type { MoneyBankAccount, MoneyCompany, MoneyOverview } from "@workspace/api-client-react";
import { formatDate } from "@/services/properties";
import "./money.css";

// Money section of the Operations overview: tenant money from COHO and banking
// per company from Xero. Data comes from GET /api/overview/money.

const pounds = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
const pence = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
export const formatPounds = (value: number) => pounds.format(value);

const FREQUENCY: Record<string, string> = { monthly: "pm", weekly: "pw", annually: "pa", quarterly: "per quarter", fortnightly: "per fortnight", "four weekly": "per 4 weeks" };
const daysSince = (date: string | null) => (date ? Math.floor((Date.now() - Date.parse(`${date}T12:00:00Z`)) / 86_400_000) : 0);
const propertyLink = (reference: string) => `/properties/${encodeURIComponent(reference)}`;

const KIND_LABEL: Record<MoneyBankAccount["kind"], string> = { bank: "Bank", card: "Card", payments: "Payment platform" };
const KIND_ORDER: MoneyBankAccount["kind"][] = ["bank", "payments", "card"];

// Checks for the accounts team (e.g. a bank summary that mixes cards and
// Stripe with real bank accounts), shown at the top of the overview.
export function AccountsNotices({ data }: { data?: MoneyOverview }) {
  const companies = (data?.xero.companies ?? []).filter((company) => company.notices.length);
  if (!companies.length) return null;
  return (
    <section className="hh-accounts-notice" role="alert" aria-labelledby="accounts-notice-title" data-testid="accounts-notices">
      <AlertTriangle size={18} />
      <div>
        <h2 id="accounts-notice-title">For the accounts team: please check Xero</h2>
        <ul>
          {companies.flatMap((company) => company.notices.map((notice) => <li key={`${company.tenantId}-${notice}`}>{notice}</li>))}
        </ul>
        <a href="#banking" className="hh-accounts-link">See bank accounts by company</a>
      </div>
    </section>
  );
}

// Left column: what needs attention (passed in as lead), then tenant money; banking on the right.
export function MoneyPanels({ data, loading, failed, propertyReference, lead }: { data?: MoneyOverview; loading: boolean; failed: boolean; propertyReference?: string; lead?: ReactNode }) {
  return (
    <div className="hh-money-grid">
      <div className="hh-money-col">
        {lead}
        <TenantMoney data={data} loading={loading} failed={failed} propertyReference={propertyReference} />
      </div>
      <Banking data={data} loading={loading} failed={failed} />
    </div>
  );
}

// Compact: the three longest arrears (the rest on request), then one line each
// for rent reviews and deposits. Ranking and links live in Needs attention.
const ARREARS_SHOWN = 3;

function TenantMoney({ data, loading, failed, propertyReference }: { data?: MoneyOverview; loading: boolean; failed: boolean; propertyReference?: string }) {
  const [showAll, setShowAll] = useState(false);
  const coho = data?.coho;
  const inScope = <T extends { propertyReference: string }>(items: T[]) => items.filter((item) => !propertyReference || item.propertyReference === propertyReference);
  const arrears = coho ? inScope(coho.arrears).sort((a, b) => b.daysInArrears - a.daysInArrears) : [];
  const reviews = coho ? inScope(coho.rentReviews).sort((a, b) => a.nextReview.localeCompare(b.nextReview)) : [];
  const noDeposit = coho ? inScope(coho.tenanciesWithoutDeposit) : [];
  const shown = showAll ? arrears : arrears.slice(0, ARREARS_SHOWN);
  const nextReview = reviews[0];
  const overdueReviews = reviews.filter((item) => item.overdue).length;
  return (
    <section className="panel" id="tenant-money">
      <div className="panel-head">
        <div><div className="panel-title">Tenant money</div><div className="panel-caption">Arrears, rent reviews and deposits from COHO</div></div>
        <PoundSterling size={16} className="hh-money-icon" />
      </div>
      {loading ? <p className="hh-money-note">Loading from COHO…</p>
        : failed || !coho ? <p className="hh-money-note warn"><AlertTriangle size={13} /> Money figures could not be loaded.</p>
          : coho.error ? <p className="hh-money-note warn"><AlertTriangle size={13} /> {coho.error}</p>
            : (
              <div className="hh-money-body">
                <h3 className="hh-money-heading">Arrears <span>{arrears.length ? `${pounds.format(arrears.reduce((sum, item) => sum + item.outstanding, 0))} · ${arrears.length} ${arrears.length === 1 ? "tenancy" : "tenancies"}` : "None"}</span></h3>
                {arrears.length ? (
                  <>
                    <ul className="hh-money-list">
                      {shown.map((item) => (
                        <li key={`${item.propertyReference}-${item.earliestDue}`}>
                          <div>
                            <Link href={propertyLink(item.propertyReference)}>{item.propertyName}</Link>
                            <small>{item.tenantName ?? "Tenant"}{item.possiblePayment ? " · possible payment not yet matched" : ""}</small>
                          </div>
                          <strong>{pence.format(item.outstanding)}</strong>
                          <span className={`status ${item.daysInArrears >= 14 ? "overdue" : "pending"}`}>{item.daysInArrears} {item.daysInArrears === 1 ? "day" : "days"}</span>
                        </li>
                      ))}
                    </ul>
                    {arrears.length > ARREARS_SHOWN && (
                      <button type="button" className="hh-money-more" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>
                        {showAll ? "Show fewer" : `Show all ${arrears.length}`}
                      </button>
                    )}
                  </>
                ) : <p className="hh-money-empty">No tenancies are in arrears.</p>}

                <p className="hh-money-line">
                  <span>Rent reviews</span>
                  {nextReview ? (
                    <span>
                      {reviews.length} due{overdueReviews ? ` (${overdueReviews} overdue)` : ""} · next <Link href={propertyLink(nextReview.propertyReference)}>{nextReview.propertyName}</Link> {formatDate(nextReview.nextReview)}
                    </span>
                  ) : <span>None in the next 4 weeks</span>}
                </p>
                <p className="hh-money-line">
                  <span>Deposits</span>
                  <span>
                    {pounds.format(coho.depositsHeldTotal)} held ({coho.depositsHeld}){coho.depositsPending ? ` · ${coho.depositsPending} pending` : ""}
                    {coho.depositsClosing ? ` · ${coho.depositsClosing} closing${coho.depositsClosingOverdue ? `, ${coho.depositsClosingOverdue} overdue` : ""}` : ""}
                    {propertyReference ? " · all properties" : ""}
                  </span>
                </p>
                {noDeposit.length > 0 && (
                  <p className="hh-money-flag">
                    <AlertTriangle size={13} />
                    <span>No deposit record for {noDeposit.map((item, index) => (
                      <span key={item.propertyReference}>{index > 0 && (index === noDeposit.length - 1 ? " and " : ", ")}<Link href={propertyLink(item.propertyReference)}>{item.propertyName}</Link></span>
                    ))}.</span>
                  </p>
                )}
              </div>
            )}
    </section>
  );
}

function Banking({ data, loading, failed }: { data?: MoneyOverview; loading: boolean; failed: boolean }) {
  const xero = data?.xero;
  const balancesError = xero?.companies.find((company) => company.balancesError)?.balancesError;
  return (
    <section className="panel" id="banking">
      <div className="panel-head">
        <div><div className="panel-title">Banking · Xero</div><div className="panel-caption">Unreconciled transactions and bank balances for every company</div></div>
        <Landmark size={16} className="hh-money-icon" />
      </div>
      {loading ? <p className="hh-money-note">Loading from Xero…</p>
        : failed || !xero ? <p className="hh-money-note warn"><AlertTriangle size={13} /> Banking could not be loaded.</p>
          : xero.error ? <p className="hh-money-note warn"><AlertTriangle size={13} /> {xero.error}</p>
            : (
              <div className="hh-money-body">
                <ul className="hh-bank-list">{xero.companies.map((company) => <CompanyRow key={company.tenantId} company={company} />)}</ul>
                {balancesError && <p className="hh-money-text muted">{balancesError}</p>}
                <p className="hh-money-text muted">Company-wide figures; the property selector doesn't apply. Unreconciled means entered in Xero but not yet matched to the bank feed.</p>
              </div>
            )}
    </section>
  );
}

function CompanyRow({ company }: { company: MoneyCompany }) {
  const age = daysSince(company.oldestUnreconciled);
  const tone = company.unreconciledCount === 0 ? "completed" : age > 30 ? "overdue" : "pending";
  const accounts = [...company.bankAccounts].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name));
  const others = accounts.filter((account) => account.kind !== "bank").length;
  return (
    <li className={company.holdsPropertyMoney ? "" : "no-property-money"}>
      <div className="hh-bank-head">
        <strong>{company.name}</strong>
        {company.error ? <span className="status overdue">Not loaded</span>
          : <span className={`status ${tone}`}>{company.unreconciledCount ? `${company.unreconciledCount} unreconciled` : "All reconciled"}</span>}
      </div>
      {company.note && <p className="hh-bank-note">{company.note}</p>}
      {company.notices.map((notice) => <p key={notice} className="hh-bank-notice"><AlertTriangle size={12} /> {notice}</p>)}
      {company.error ? <p className="hh-bank-meta">{company.error}</p> : (
        <>
          {company.unreconciledCount > 0 && (
            <p className="hh-bank-meta">
              {pence.format(company.unreconciledIn)} in · {pence.format(company.unreconciledOut)} out · oldest {formatDate(company.oldestUnreconciled)}{age > 30 ? ` (${age} days)` : ""}
            </p>
          )}
          {accounts.length > 0 && (
            <details className="hh-bank-accounts" open={company.notices.length > 0}>
              <summary>
                {company.bankTotal !== null ? `${pence.format(company.bankTotal)} in the bank` : "Bank accounts"}
                {others ? ` · plus ${others} card or payment platform ${others === 1 ? "account" : "accounts"}` : ""}
              </summary>
              <table>
                <thead><tr><th>Account</th><th>Type</th><th>In this month</th><th>Out this month</th><th>Balance</th></tr></thead>
                <tbody>
                  {accounts.map((account) => (
                    <tr key={account.name} className={account.kind === "bank" ? "" : "not-bank"}>
                      <td>{account.name}</td>
                      <td><span className={`hh-kind ${account.kind}`}>{KIND_LABEL[account.kind]}</span></td>
                      <td>{account.moneyIn === null ? "—" : pence.format(account.moneyIn)}</td>
                      <td>{account.moneyOut === null ? "—" : pence.format(account.moneyOut)}</td>
                      <td className={account.balance !== null && account.balance < 0 ? "negative" : ""}>{account.balance === null ? "—" : pence.format(account.balance)}</td>
                    </tr>
                  ))}
                </tbody>
                {company.bankTotal !== null && (
                  <tfoot><tr><td colSpan={4}>Bank total (real bank accounts only)</td><td>{pence.format(company.bankTotal)}</td></tr></tfoot>
                )}
              </table>
            </details>
          )}
        </>
      )}
    </li>
  );
}
