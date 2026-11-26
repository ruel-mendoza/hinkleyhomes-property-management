import { Link } from "wouter";
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import { getGetPayRunsQueryKey, useGetPayRuns, type PayRuns } from "@workspace/api-client-react";
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
  // A pay run added by hand from its Telleroo link; filled in by the next 30-minute check.
  unknown: ["Details on the way", "na"],
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

// Payee check status -> [label, status class, what to do].
const PAYEE: Record<string, [string, string, string]> = {
  differs: ["Different account", "failed", "Telleroo paid an account that isn't the verified one. Check with the supplier before the next payment."],
  old: ["Not the verified account", "failed", "Telleroo paid older or unverified bank details on file. Update the payee in Telleroo."],
  unverified: ["Not verified yet", "pending", "Verify the supplier's bank details on Alerts."],
  missing: ["No details on file", "na", "No bank details on file for this supplier to compare."],
  unknown: ["Supplier not found", "na", "No supplier matches this payee name."],
};

function PayeeCheckPanel({ data }: { data: PayRuns }) {
  return (
    <section className="panel table-panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">Payee bank details</div>
          <div className="panel-caption">The account Telleroo last paid each payee, compared with the verified details on file. {data.payeesChecked ? `${data.payeesMatching} of ${data.payeesChecked} match.` : "Payees show here after their first pay run."}</div>
        </div>
        <Link href="/checks" className="button">Alerts</Link>
      </div>
      {data.payeeIssues.length > 0 ? (
        <div className="table-wrap">
          <table className="hh-fin-table">
            <thead><tr><th>Payee</th><th>Check</th><th>Telleroo paid</th><th>On file</th><th>Last paid</th></tr></thead>
            <tbody>
              {data.payeeIssues.map((payee) => {
                const [label, tone, hint] = PAYEE[payee.status] ?? [payee.status, "na", ""];
                return (
                  <tr key={payee.id}>
                    <td className="hh-chk-summary"><strong>{payee.supplier ?? payee.payeeName}</strong>{payee.supplier && payee.supplier !== payee.payeeName && <small className="hh-fin-sub">Paid as {payee.payeeName}</small>}</td>
                    <td className="hh-chk-summary"><span className={`status ${tone}`}>{label}</span><small className="hh-fin-sub">{hint}</small></td>
                    <td>{payee.tellerooAccount}{payee.sortCodeDiffers && <small className="hh-fin-sub bad">Different sort code</small>}</td>
                    <td>{payee.fileAccount ?? "—"}</td>
                    <td className="hh-chk-summary">{payee.paidAt ? formatDate(payee.paidAt) : "—"}<small className="hh-fin-sub">{payee.tellerooUrl ? <a href={payee.tellerooUrl} target="_blank" rel="noreferrer">{payee.payRunName || "Pay run"}</a> : payee.payRunName}</small></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state"><h3>{data.payeesChecked ? "Every payee matches" : "Nothing to compare yet"}</h3><p>{data.payeesChecked ? "Telleroo paid the verified account for every payee." : "Once Telleroo has paid a supplier, its bank details are checked here."}</p></div>
      )}
    </section>
  );
}

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
                        {run.rejections.map((payment, index) => <small key={index} className="hh-fin-sub">{payment.payeeName || "No name"}{payment.amount !== null ? ` · ${pounds.format(payment.amount)}` : ""}: {payment.reason}</small>)}
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

      {data && <PayeeCheckPanel data={data} />}
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
                {data.payeesDiffering > 0 && <div><span>Bank details differ</span><strong className="bad">{data.payeesDiffering}</strong></div>}
              </>
            )}
      </div>
      <div className="hh-perf-strip-links"><Link href="/bills?tab=payruns" className="button">Pay runs</Link></div>
    </section>
  );
}
