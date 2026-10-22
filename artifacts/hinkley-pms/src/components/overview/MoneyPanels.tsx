import { AlertTriangle, Landmark, PoundSterling } from "lucide-react";
import { Link } from "wouter";
import type { MoneyCompany, MoneyOverview } from "@workspace/api-client-react";
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

export function MoneyPanels({ data, loading, failed, propertyReference }: { data?: MoneyOverview; loading: boolean; failed: boolean; propertyReference?: string }) {
  return (
    <div className="hh-money-grid">
      <TenantMoney data={data} loading={loading} failed={failed} propertyReference={propertyReference} />
      <Banking data={data} loading={loading} failed={failed} />
    </div>
  );
}

function TenantMoney({ data, loading, failed, propertyReference }: { data?: MoneyOverview; loading: boolean; failed: boolean; propertyReference?: string }) {
  const coho = data?.coho;
  const inScope = <T extends { propertyReference: string }>(items: T[]) => items.filter((item) => !propertyReference || item.propertyReference === propertyReference);
  const arrears = coho ? inScope(coho.arrears) : [];
  const reviews = coho ? inScope(coho.rentReviews) : [];
  const noDeposit = coho ? inScope(coho.tenanciesWithoutDeposit) : [];
  return (
    <section className="panel">
      <div className="panel-head">
        <div><div className="panel-title">Tenant money</div><div className="panel-caption">Arrears, rent reviews and deposits from COHO</div></div>
        <PoundSterling size={16} className="hh-money-icon" />
      </div>
      {loading ? <p className="hh-money-note">Loading from COHO…</p>
        : failed || !coho ? <p className="hh-money-note warn"><AlertTriangle size={13} /> Money figures could not be loaded.</p>
          : coho.error ? <p className="hh-money-note warn"><AlertTriangle size={13} /> {coho.error}</p>
            : (
              <div className="hh-money-body">
                <h3 className="hh-money-heading">Arrears <span>{arrears.length ? pounds.format(arrears.reduce((sum, item) => sum + item.outstanding, 0)) : "None"}</span></h3>
                {arrears.length ? (
                  <ul className="hh-money-list">
                    {arrears.map((item) => (
                      <li key={`${item.propertyReference}-${item.earliestDue}`}>
                        <div><Link href={propertyLink(item.propertyReference)}>{item.propertyName}</Link><small>{item.tenantName ?? "Tenant"} · due since {formatDate(item.earliestDue)}</small></div>
                        <strong>{pence.format(item.outstanding)}</strong>
                        <span className={`status ${item.daysInArrears >= 14 ? "overdue" : "pending"}`}>{item.daysInArrears} {item.daysInArrears === 1 ? "day" : "days"}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="hh-money-empty">No tenancies are in arrears.</p>}

                <h3 className="hh-money-heading">Rent reviews <span>{reviews.length ? `${reviews.length} due` : "None due"}</span></h3>
                {reviews.length ? (
                  <ul className="hh-money-list">
                    {reviews.map((item) => (
                      <li key={`${item.propertyReference}-${item.nextReview}`}>
                        <div><Link href={propertyLink(item.propertyReference)}>{item.propertyName}</Link><small>Currently {item.currentRent === null ? "—" : `${pence.format(item.currentRent)} ${FREQUENCY[item.paymentFrequency ?? ""] ?? item.paymentFrequency ?? ""}`}</small></div>
                        <strong>{formatDate(item.nextReview)}</strong>
                        <span className={`status ${item.overdue ? "overdue" : "upcoming"}`}>{item.overdue ? "Overdue" : "Due soon"}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="hh-money-empty">No rent reviews in the next 4 weeks.</p>}

                <h3 className="hh-money-heading">Deposits <span>{pounds.format(coho.depositsHeldTotal)} held</span></h3>
                <p className="hh-money-text">
                  {coho.depositsHeld} protected {coho.depositsHeld === 1 ? "deposit" : "deposits"}
                  {coho.depositsPending ? ` · ${coho.depositsPending} pending` : ""}
                  {coho.depositsClosing ? ` · ${coho.depositsClosing} closing${coho.depositsClosingOverdue ? ` (${coho.depositsClosingOverdue} overdue)` : ""}` : ""}
                  {propertyReference ? " (all properties)" : ""}
                </p>
                {noDeposit.length > 0 && (
                  <p className="hh-money-flag">
                    <AlertTriangle size={13} />
                    <span>No deposit record for {noDeposit.map((item, index) => (
                      <span key={item.propertyReference}>{index > 0 && (index === noDeposit.length - 1 ? " and " : ", ")}<Link href={propertyLink(item.propertyReference)}>{item.propertyName}</Link></span>
                    ))}. Check whether a deposit was taken.</span>
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
    <section className="panel">
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
  const balance = company.bankAccounts.reduce<number | null>((sum, account) => (account.balance === null ? sum : (sum ?? 0) + account.balance), null);
  return (
    <li className={company.holdsPropertyMoney ? "" : "no-property-money"}>
      <div className="hh-bank-head">
        <strong>{company.name}</strong>
        {company.error ? <span className="status overdue">Not loaded</span>
          : <span className={`status ${tone}`}>{company.unreconciledCount ? `${company.unreconciledCount} unreconciled` : "All reconciled"}</span>}
      </div>
      {company.note && <p className="hh-bank-note">{company.note}</p>}
      {company.error ? <p className="hh-bank-meta">{company.error}</p> : (
        <>
          {company.unreconciledCount > 0 && (
            <p className="hh-bank-meta">
              {pence.format(company.unreconciledIn)} in · {pence.format(company.unreconciledOut)} out · oldest {formatDate(company.oldestUnreconciled)}{age > 30 ? ` (${age} days)` : ""}
            </p>
          )}
          {company.bankAccounts.length > 0 && (
            <details className="hh-bank-accounts">
              <summary>{company.bankAccounts.length} bank {company.bankAccounts.length === 1 ? "account" : "accounts"}{balance !== null ? ` · ${pence.format(balance)} total` : ""}</summary>
              <table>
                <thead><tr><th>Account</th><th>In this month</th><th>Out this month</th><th>Balance</th></tr></thead>
                <tbody>
                  {company.bankAccounts.map((account) => (
                    <tr key={account.name}>
                      <td>{account.name}</td>
                      <td>{account.moneyIn === null ? "—" : pence.format(account.moneyIn)}</td>
                      <td>{account.moneyOut === null ? "—" : pence.format(account.moneyOut)}</td>
                      <td className={account.balance !== null && account.balance < 0 ? "negative" : ""}>{account.balance === null ? "—" : pence.format(account.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </>
      )}
    </li>
  );
}
