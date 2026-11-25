import { Link } from "wouter";
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import { getGetPayRunsQueryKey, useGetPayRuns } from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import { formatDate } from "@/services/properties";
import "./finance.css";

// Supplier pay runs in Telleroo, read from Supabase. n8n saves each Telleroo
// webhook and re-checks open pay runs every 30 minutes; nothing here can
// create, approve or cancel a pay run (that is done in Telleroo).

export const payRunsQueryOptions = { query: { queryKey: getGetPayRunsQueryKey(), staleTime: 60_000 } };

const pounds = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const whole = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

// Telleroo status -> [label, status class].
const STATUS: Record<string, [string, string]> = {
  validating: ["Checking payees", "upcoming"],
  validated: ["Checked", "upcoming"],
  processing: ["Processing", "upcoming"],
  awaiting_review: ["Awaiting review", "pending"],
  awaiting_approval: ["Awaiting approval", "pending"],
  approving: ["Approving", "upcoming"],
  awaiting_funds: ["Needs funds", "failed"],
  sending: ["Sending", "upcoming"],
  paid: ["Paid", "paid"],
  cancelling: ["Cancelling", "na"],
  cancelled: ["Cancelled", "na"],
};
const statusOf = (status: string): [string, string] => STATUS[status] ?? [status.replace(/_/g, " "), "na"];

export function PayRunsTab() {
  const query = useGetPayRuns(payRunsQueryOptions);
  const data = query.data;
  return (
    <>
      <section className="panel hh-fin-note">
        Pay runs are made and approved in Telleroo; this list is read-only.
        {data && <> {data.lastEventAt ? `Telleroo last updated us ${when(data.lastEventAt)}.` : "No updates from Telleroo yet."}</>}
      </section>

      {query.isLoading && <section className="panel hh-fin-note">Loading pay runs…</section>}
      {query.isError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Pay runs could not be loaded: {errorText(query.error)}</p>}

      {data && (
        <section className="panel table-panel">
          <div className="table-wrap">
            <table className="hh-fin-table">
              <thead><tr><th>Pay run</th><th>Status</th><th>Payments</th><th className="num">Amount</th><th>Open</th></tr></thead>
              <tbody>
                {data.payRuns.map((run) => {
                  const [label, tone] = statusOf(run.status);
                  return (
                    <tr key={run.id}>
                      <td className="hh-chk-summary">
                        <strong>{run.name || "Pay run"}</strong>
                        <small className="hh-fin-sub">{[run.createdAt ? `Made ${formatDate(run.createdAt)}` : null, run.scheduledFor ? `paying ${formatDate(run.scheduledFor)}` : null].filter(Boolean).join(" · ") || "—"}</small>
                      </td>
                      <td className="hh-chk-summary">
                        <span className={`status ${tone}`}>{label}</span>
                        <small className="hh-fin-sub">Checked {when(run.lastCheckedAt)}</small>
                      </td>
                      <td className="hh-chk-summary">
                        <strong>{run.payments}</strong>
                        {run.rejected > 0 && <small className="hh-fin-sub bad">{run.rejected} rejected by Telleroo</small>}
                      </td>
                      <td className="num">
                        {run.requestedAmount !== null ? pounds.format(run.requestedAmount) : "—"}
                        {run.paidAmount !== null && run.paidAmount > 0 && run.paidAmount !== run.requestedAmount && <small className="hh-fin-sub">{pounds.format(run.paidAmount)} paid</small>}
                      </td>
                      <td>{run.tellerooUrl ? <a href={run.tellerooUrl} target="_blank" rel="noreferrer" className="button">Telleroo <ArrowUpRight size={13} /></a> : <small className="hh-fin-sub">—</small>}</td>
                    </tr>
                  );
                })}
                {!data.payRuns.length && <tr><td colSpan={5}><div className="empty-state"><h3>No pay runs yet</h3><p>Pay runs made in Telleroo show here once Telleroo tells us about them.</p></div></td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

export function PayRunsStrip() {
  const query = useGetPayRuns(payRunsQueryOptions);
  const data = query.data;
  return (
    <section className="panel hh-perf-strip" aria-label="Supplier pay runs">
      <div><div className="panel-title">Supplier pay runs · Telleroo</div><div className="panel-caption">Made and approved in Telleroo</div></div>
      <div className="hh-perf-strip-stats">
        {query.isLoading ? <div><span>Loading…</span></div>
          : !data ? <div><span>Pay runs could not be loaded</span></div>
            : (
              <>
                <div><span>Open pay runs</span><strong>{data.open}</strong></div>
                <div><span>Awaiting approval</span><strong className={data.awaitingApproval ? "warn" : ""}>{data.awaitingApproval}</strong></div>
                <div><span>Still to pay</span><strong>{whole.format(data.openAmount)}</strong></div>
                <div><span>Paid this month</span><strong className="good">{whole.format(data.paidThisMonth)}</strong></div>
              </>
            )}
      </div>
      <div className="hh-perf-strip-links"><Link href="/bills?tab=payruns" className="button">Pay runs</Link></div>
    </section>
  );
}
