import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, RefreshCw, RotateCcw, XCircle } from "lucide-react";
import {
  getGetOverdueReportQueryKey,
  getListCheckRunsQueryKey,
  getListFinanceAlertsQueryKey,
  useListCheckRuns,
  useListFinanceAlerts,
  useListReminderLog,
  useRunChecksNow,
  useUpdateFinanceAlert,
  type CheckRun,
  type FinanceAlert,
  type FinanceAlertFilter,
  type FinanceAlertStatus,
} from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import { ModalShell } from "@/components/properties/ModalShell";
import { CompanyTag } from "./XeroLedger";
import "./finance.css";

// What the Xero daily checks found, used on Owed to us and Supplier bills: the
// Run checks now button and last run, bill price, bank-detail and spend-trend
// alerts, and the log of reminders the reminders workflow sent. The checks run
// each morning (n8n "Xero daily checks") or from the button; nothing is emailed.
// The overdue ranking they produce shows as the priority on each invoice or bill.

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const checkRunsQueryOptions = { query: { queryKey: getListCheckRunsQueryKey(), staleTime: 60_000 } };

const SEVERITY: Record<string, [string, string]> = { high: ["High", "overdue"], warn: ["Check", "pending"], info: ["Info", "na"] };
const ALERT_CODES: Record<string, string> = {
  line_price_up: "Price per unit up",
  bill_total_unusual: "Unusually large bill",
  recurring_bill_up: "Regular bill up",
  supplier_spend_up: "Supplier spend up",
  category_spend_up: "Category spend up",
  bank_details_new: "New bank account",
  bank_details_changed: "Bank details changed",
  bank_details_replaced: "Older bank account used",
  bank_details_unchecked: "Bank details not checked",
  bank_check_failed: "Bank check could not run",
};
const REMINDER_KINDS: Record<string, string> = {
  auto_reminder: "Automatic reminder",
  manual_reminder: "Manual reminder",
  xero_resend: "Invoice re-sent from Xero",
  xero_note: "Note added in Xero",
};

const runText = (run: CheckRun) => {
  const s = run.summary;
  if (!s) return run.status;
  return `${s.billsSynced} bills read${s.fullBillSync ? " (first full read)" : ""}, ${s.newBillFlags + s.newSpendFlags} new alerts, ${s.newOverdue} newly overdue.`;
};

// "Last checked …" and Run checks now, for the page header.
export function ChecksRunButton({ flash }: { flash: (message: string) => void }) {
  const queryClient = useQueryClient();
  const runs = useListCheckRuns(checkRunsQueryOptions);
  const runNow = useRunChecksNow({
    mutation: {
      onSuccess: (run) => {
        void queryClient.invalidateQueries({ queryKey: getListCheckRunsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetOverdueReportQueryKey() });
        void queryClient.invalidateQueries({ queryKey: ["/api/checks/alerts"] });
        flash(run.status === "succeeded" ? `Checks finished: ${runText(run)}` : `Checks failed: ${run.error ?? "unknown error"}`);
      },
      onError: (error) => flash(`Checks could not run: ${errorText(error)}`),
    },
  });
  const lastRun = runs.data?.items[0];
  return (
    <>
      {lastRun && <span className="hh-chk-last">Last checked {when(lastRun.startedAt)}</span>}
      <button type="button" className="button" onClick={() => runNow.mutate()} disabled={runNow.isPending} data-testid="button-run-checks" title="Re-read Xero: overdue priorities and bill and spend alerts">
        <RefreshCw size={14} className={runNow.isPending ? "spin" : ""} /> {runNow.isPending ? "Checking Xero…" : "Run checks now"}
      </button>
    </>
  );
}

// Problems with the last daily check, shown under the page header.
export function RunStatus() {
  const runs = useListCheckRuns(checkRunsQueryOptions);
  const run = runs.data?.items[0];
  if (runs.isLoading) return null;
  if (runs.isError) return <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Check runs could not be loaded: {errorText(runs.error)}</p>;
  if (!run) return <section className="panel hh-fin-note">The checks haven't run yet. They run each morning from the n8n "Xero daily checks" workflow, or use Run checks now. The first run reads 13 months of supplier bills, so it takes a minute or two.</section>;
  return (
    <>
      {run.status === "failed" && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> The last check run failed: {run.error}</p>}
      {run.status !== "failed" && run.summary?.problems.length ? <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Last run, partly read: {run.summary.problems.join("; ")}</p> : null}
      {run.status === "running" && <section className="panel hh-fin-note">A check run started {when(run.startedAt)} and is still going.</section>}
    </>
  );
}

// --- Alerts -----------------------------------------------------------------------

const FILTERS: [FinanceAlertFilter, string][] = [["open", "Open"], ["resolved", "Resolved"], ["ignored", "Ignored"], ["all", "All"]];

export function AlertsTab({ get, setParams, flash }: { get: (key: string) => string; setParams: (change: Record<string, string>) => void; flash: (message: string) => void }) {
  const status = (FILTERS.some(([key]) => key === get("status")) ? get("status") : "open") as FinanceAlertFilter;
  const query = useListFinanceAlerts({ status }, { query: { queryKey: getListFinanceAlertsQueryKey({ status }), staleTime: 60_000 } });
  const [acting, setActing] = useState<{ alert: FinanceAlert; status: FinanceAlertStatus } | null>(null);
  const items = query.data?.items ?? [];

  return (
    <>
      <div className="hh-inv-companies" role="group" aria-label="Filter by status">
        {FILTERS.map(([key, label]) => (
          <button key={key} type="button" className={`hh-inv-company ${status === key ? "active" : ""}`} aria-pressed={status === key} onClick={() => setParams({ status: key === "open" ? "" : key })}>
            <span>{label}</span>
            {key === "open" && query.data && <><strong>{query.data.openCount}</strong><small>{query.data.openHighCount} high</small></>}
          </button>
        ))}
      </div>

      {query.isLoading && <section className="panel hh-fin-note">Loading alerts…</section>}
      {query.isError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Alerts could not be loaded: {errorText(query.error)}</p>}

      {query.data && (
        <section className="panel table-panel">
          <div className="table-wrap">
            <table className="hh-fin-table">
              <thead><tr><th>Alert</th><th>What was found</th><th>Raised</th><th>Status</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {items.map((alert) => (
                  <tr key={alert.id}>
                    <td>
                      <span className={`status ${SEVERITY[alert.severity][1]}`}>{SEVERITY[alert.severity][0]}</span>
                      <strong className="hh-chk-alert-name">{ALERT_CODES[alert.code] ?? alert.code}</strong>
                      {alert.tenantId && alert.company && <CompanyTag tenantId={alert.tenantId} name={alert.company} />}
                    </td>
                    <td className="hh-chk-summary">{alert.summary}</td>
                    <td className="hh-nowrap">{when(alert.createdAt)}</td>
                    <td>
                      <span className={`status ${alert.status === "open" ? "pending" : alert.status === "resolved" ? "completed" : "na"}`}>{alert.status === "open" ? "Open" : alert.status === "resolved" ? "Resolved" : "Ignored"}</span>
                      {alert.resolvedBy && <small className="hh-fin-sub">{alert.resolvedBy}{alert.resolvedAt ? ` · ${when(alert.resolvedAt)}` : ""}</small>}
                      {alert.resolution && <small className="hh-fin-sub">{alert.resolution}</small>}
                    </td>
                    <td className="hh-inv-actions">
                      {alert.status === "open" ? (
                        <>
                          <button type="button" className="icon-btn" onClick={() => setActing({ alert, status: "resolved" })} title="Resolve: checked and dealt with" aria-label="Resolve alert"><CheckCircle2 size={15} /></button>
                          <button type="button" className="icon-btn" onClick={() => setActing({ alert, status: "ignored" })} title="Ignore: not a problem" aria-label="Ignore alert"><XCircle size={15} /></button>
                        </>
                      ) : (
                        <button type="button" className="icon-btn" onClick={() => setActing({ alert, status: "open" })} title="Reopen" aria-label="Reopen alert"><RotateCcw size={15} /></button>
                      )}
                    </td>
                  </tr>
                ))}
                {!items.length && <tr><td colSpan={5}><div className="empty-state"><h3>No alerts</h3><p>{status === "open" ? "Nothing is waiting to be checked." : "No alerts with this status."}</p></div></td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <p className="hh-fin-foot">
        Bank-detail alerts: phone the supplier on a number you already hold before paying. Price alerts compare each bill line's price per unit before VAT with the supplier's usual price over the last year; spend alerts compare last month with the six months before.
      </p>

      {acting && <AlertModal alert={acting.alert} status={acting.status} onClose={() => setActing(null)} onDone={(message) => { setActing(null); flash(message); }} />}
    </>
  );
}

function AlertModal({ alert, status, onClose, onDone }: { alert: FinanceAlert; status: FinanceAlertStatus; onClose: () => void; onDone: (message: string) => void }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const mutation = useUpdateFinanceAlert({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ["/api/checks/alerts"] });
        onDone(status === "open" ? "Alert reopened." : status === "resolved" ? "Alert resolved." : "Alert ignored.");
      },
    },
  });
  const verb = status === "open" ? "Reopen" : status === "resolved" ? "Resolve" : "Ignore";
  return (
    <ModalShell
      title={`${verb} alert`}
      caption={`${ALERT_CODES[alert.code] ?? alert.code}${alert.company ? ` · ${alert.company}` : ""}`}
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); mutation.mutate({ id: alert.id, data: { status, note: note.trim() || null } }); }}
      testId="modal-finance-alert"
      footer={<>
        <button type="button" className="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary" disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : verb}</button>
      </>}
    >
      <p className="hh-chk-summary">{alert.summary}</p>
      {status !== "open" && (
        <label className="field full">
          Note
          <textarea rows={3} maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} placeholder={alert.code.startsWith("bank_") ? "Who you phoned, on which number, what they confirmed" : "What you checked and found"} />
        </label>
      )}
      {mutation.isError && <p className="hh-field-error" role="alert">{errorText(mutation.error)}</p>}
      <p className="hh-fin-foot">Recorded with your name in the audit log.</p>
    </ModalShell>
  );
}

// --- Reminders --------------------------------------------------------------------

export function RemindersTab() {
  const query = useListReminderLog();
  const items = query.data?.items ?? [];
  if (query.isLoading) return <section className="panel hh-fin-note">Loading the reminder log…</section>;
  if (query.isError) return <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> The reminder log could not be loaded: {errorText(query.error)}</p>;
  return (
    <>
      <section className="panel table-panel">
        <div className="table-wrap">
          <table className="hh-fin-table">
            <thead><tr><th>When</th><th>Invoice</th><th>What</th><th>Sent to</th><th>Result</th></tr></thead>
            <tbody>
              {items.map((entry) => (
                <tr key={entry.id}>
                  <td className="hh-nowrap">{when(entry.sentAt)}{entry.requestedBy && <small className="hh-fin-sub">{entry.requestedBy}</small>}</td>
                  <td>
                    <span className="hh-inv-head"><strong className="hh-nowrap">{entry.invoiceNumber ?? "—"}</strong><CompanyTag tenantId={entry.tenantId} name={entry.company} /></span>
                    {entry.contactName && <span className="hh-inv-contact">{entry.contactName}</span>}
                  </td>
                  <td>{REMINDER_KINDS[entry.kind]}{entry.stage !== null && <small className="hh-fin-sub">Stage {entry.stage}</small>}</td>
                  <td>{entry.sentTo ?? "—"}{entry.testMode && <small className="hh-fin-sub warn">Test mode: sent to the internal address</small>}</td>
                  <td>
                    <span className={`status ${entry.status === "sent" ? "completed" : entry.status === "failed" ? "failed" : "na"}`}>{entry.status === "sent" ? "Sent" : entry.status === "failed" ? "Failed" : "Skipped"}</span>
                    {entry.detail && <small className="hh-fin-sub">{entry.detail}</small>}
                  </td>
                </tr>
              ))}
              {!items.length && <tr><td colSpan={5}><div className="empty-state"><h3>No reminders yet</h3><p>Reminders sent with Chase or by the automatic reminders appear here.</p></div></td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <p className="hh-fin-foot">The latest 500 reminders, re-sends and Xero notes. Reminders are switched on and set up from the Invoices tab.</p>
    </>
  );
}
