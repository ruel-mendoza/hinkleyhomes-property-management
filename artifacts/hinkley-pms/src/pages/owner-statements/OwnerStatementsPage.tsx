import { useState } from "react";
import { Link } from "wouter";
import { getGetOwnerStatementsQueryKey, useGetOwnerStatements, type OwnerStatement } from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import "./owner-statements.css";

// Owner statements: Rental Ninja's monthly statements for serviced-accommodation
// landlords, split into landlord payout, Hinkley fee and housekeeping. Read-only.

const pounds = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const whole = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
const monthName = (month: string) => new Date(`${month}-01T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

// The last 12 months, newest first, ending with last month (UK time).
function recentMonths(): string[] {
  const [year, month] = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date()).split("-").map(Number);
  return Array.from({ length: 12 }, (_, index) => new Date(Date.UTC(year, month - 2 - index, 1)).toISOString().slice(0, 7));
}

const queryOptions = (month?: string) => ({ query: { queryKey: getGetOwnerStatementsQueryKey(month ? { month } : undefined), staleTime: 10 * 60_000, retry: false } });

function flag(statement: OwnerStatement): { tone: string; label: string } | null {
  const noPayouts = (statement.income ?? 0) > 0 && !statement.hinkleyFee && !statement.housekeeping && !statement.landlordNet && !statement.other;
  if (noPayouts) return { tone: "overdue", label: "No payouts yet" };
  if (statement.landlordNet < 0) return { tone: "overdue", label: "Landlord owes" };
  if (statement.toReview) return { tone: "pending", label: "Needs review" };
  return null;
}

export default function OwnerStatementsPage() {
  const months = recentMonths();
  const [month, setMonth] = useState(months[0]);
  const query = useGetOwnerStatements({ month }, queryOptions(month));
  const data = query.data;
  const statements = data?.statements ?? [];
  const flagged = statements.filter(flag).length;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Hinkley Homes · Rental Ninja</div>
          <h1 className="page-title">Owner statements</h1>
          <p className="page-sub">Monthly statements for serviced-accommodation landlords, read from Rental Ninja. Rental Ninja doesn't record payments, so whether a landlord has been paid is checked in Xero.</p>
        </div>
        <div className="head-actions">
          <select className="os-month" value={month} onChange={(event) => setMonth(event.target.value)} aria-label="Month" data-testid="select-statement-month">
            {months.map((item) => <option key={item} value={item}>{monthName(item)}</option>)}
          </select>
        </div>
      </div>

      <div className="metrics">
        <div className="panel metric">
          <div className="metric-top">Booking income</div>
          <div className="metric-value">{data ? whole.format(data.income) : "—"}</div>
          <div className="metric-foot">{data ? `${statements.length} statements` : "From Rental Ninja"}</div>
        </div>
        <div className="panel metric">
          <div className="metric-top">Due to landlords</div>
          <div className="metric-value">{data ? whole.format(data.landlordNet) : "—"}</div>
          <div className="metric-foot">{data ? `After ${whole.format(data.landlordCosts)} of costs charged to them` : "Landlord payouts"}</div>
        </div>
        <div className="panel metric">
          <div className="metric-top">Hinkley fees</div>
          <div className="metric-value">{data ? whole.format(data.hinkleyFee) : "—"}</div>
          <div className="metric-foot">Management and Lettings</div>
        </div>
        <div className="panel metric">
          <div className="metric-top">Housekeeping</div>
          <div className="metric-value">{data ? whole.format(data.housekeeping) : "—"}</div>
          <div className="metric-foot">{data && flagged ? `${flagged} statements to check` : "Cleaning charged on statements"}</div>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <div className="panel-title">Statements · {monthName(month)}</div>
            <div className="panel-caption">How each landlord's booking income is split. Costs charged to the landlord are already inside the fee and housekeeping columns.</div>
          </div>
        </div>
        {query.isLoading ? <div className="empty-state"><p>Loading statements from Rental Ninja…</p></div>
          : query.isError ? <div className="empty-state"><h3>Statements could not be loaded</h3><p>{errorText(query.error)}</p></div>
            : statements.length === 0 ? <div className="empty-state"><h3>No statements for {monthName(month)}</h3><p>Rental Ninja hasn't created any statements for this month yet.</p></div>
              : (
                <div className="table-wrap">
                  <table className="os-table">
                    <thead>
                      <tr><th>Landlord</th><th className="num">Income</th><th className="num">Costs charged</th><th className="num">Hinkley fee</th><th className="num">Housekeeping</th><th className="num">Landlord payout</th><th>Check</th></tr>
                    </thead>
                    <tbody>
                      {statements.map((statement) => {
                        const note = flag(statement);
                        return (
                          <tr key={statement.id}>
                            <td><strong>{statement.landlord}</strong>{statement.feeCompany === "Lettings" && <small>Fee to Lettings</small>}</td>
                            <td className="num">{statement.income === null ? "Recalculating" : pounds.format(statement.income)}</td>
                            <td className="num">{statement.landlordCosts ? pounds.format(statement.landlordCosts) : "—"}</td>
                            <td className="num">{pounds.format(statement.hinkleyFee)}</td>
                            <td className="num">{pounds.format(statement.housekeeping + statement.other)}</td>
                            <td className={`num os-net${statement.landlordNet < 0 ? " bad" : ""}`}>{pounds.format(statement.landlordNet)}</td>
                            <td>{note ? <span className={`status ${note.tone}`}>{note.label}</span> : <span className="os-ok">OK</span>}</td>
                          </tr>
                        );
                      })}
                      {data && (
                        <tr className="os-total">
                          <td>All landlords</td>
                          <td className="num">{pounds.format(data.income)}</td>
                          <td className="num">{pounds.format(data.landlordCosts)}</td>
                          <td className="num">{pounds.format(data.hinkleyFee)}</td>
                          <td className="num">{pounds.format(data.housekeeping + statements.reduce((sum, item) => sum + item.other, 0))}</td>
                          <td className="num">{pounds.format(data.landlordNet)}</td>
                          <td />
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
      </section>
    </>
  );
}

// Overview strip: last month's statements, with a link to the page.
export function OwnerStatementsStrip() {
  const query = useGetOwnerStatements(undefined, queryOptions());
  const data = query.data;
  return (
    <section className="panel hh-perf-strip" aria-label="Owner statements">
      <div><div className="panel-title">Owner statements · Rental Ninja</div><div className="panel-caption">{data ? monthName(data.month) : "Last month"}</div></div>
      <div className="hh-perf-strip-stats">
        {query.isLoading ? <div><span>Loading…</span></div>
          : !data ? <div><span>Rental Ninja could not be read</span></div>
            : (
              <>
                <div><span>Statements</span><strong>{data.statements.length}</strong></div>
                <div><span>Due to landlords</span><strong>{whole.format(data.landlordNet)}</strong></div>
                <div><span>Hinkley fees</span><strong className="good">{whole.format(data.hinkleyFee)}</strong></div>
                <div><span>To check</span><strong className={data.statements.some(flag) ? "warn" : "good"}>{data.statements.filter(flag).length}</strong></div>
              </>
            )}
      </div>
      <div className="hh-perf-strip-links"><Link href="/owner-statements" className="button">Owner statements</Link></div>
    </section>
  );
}
