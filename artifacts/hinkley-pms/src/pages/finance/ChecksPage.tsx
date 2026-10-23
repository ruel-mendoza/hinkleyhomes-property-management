import { useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, RefreshCw, RotateCcw, Search, X, XCircle } from "lucide-react";
import {
  getGetOverdueReportQueryKey,
  getListCheckRunsQueryKey,
  getListFinanceAlertsQueryKey,
  useGetOverdueReport,
  useListCheckRuns,
  useListFinanceAlerts,
  useListReminderLog,
  useRunChecksNow,
  useUpdateFinanceAlert,
  type CheckRun,
  type FinanceAlert,
  type FinanceAlertFilter,
  type FinanceAlertStatus,
  type OverdueItem,
} from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import { ModalShell } from "@/components/properties/ModalShell";
import { formatDate } from "@/services/properties";
import { CompanyTag } from "./InvoicesPage";
import { BillCodingTab } from "./BillCodingTab";
import "./finance.css";

// Finance checks: what the Xero daily checks found. Overdue invoices and bills
// ranked by value, age and risk; bill price, bank-detail and spend-trend alerts;
// and the log of reminders the reminders workflow sent. The checks run each
// morning (n8n "Xero daily checks") or from the button here; nothing is emailed.

const pence = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const pounds = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

type Tab = "overdue" | "alerts" | "coding" | "reminders";

const PRIORITY: Record<number, [string, string]> = {
  1: ["Act now", "overdue"],
  2: ["This week", "pending"],
  3: ["Monitor", "na"],
};
const RISK_CLASS = { High: "overdue", Medium: "pending", Low: "completed" } as const;
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

export default function ChecksPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const get = (key: string) => params.get(key) ?? "";
  const setParams = (change: Record<string, string>) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(change)) value ? next.set(key, value) : next.delete(key);
    navigate(`/checks${next.size ? `?${next}` : ""}`, { replace: true });
  };
  const tab: Tab = (["alerts", "coding", "reminders"] as const).find((key) => key === get("tab")) ?? "overdue";

  const queryClient = useQueryClient();
  const runs = useListCheckRuns({ query: { queryKey: getListCheckRunsQueryKey(), staleTime: 60_000 } });
  const alertCounts = useListFinanceAlerts({ status: "open" }, { query: { queryKey: getListFinanceAlertsQueryKey({ status: "open" }), staleTime: 60_000 } });
  const [toast, setToast] = useState("");
  const flash = (message: string) => { setToast(message); setTimeout(() => setToast(""), 4000); };
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
      <div className="page-head">
        <div>
          <div className="eyebrow">Hinkley Homes · Xero</div>
          <h1 className="page-title">Finance checks</h1>
          <p className="page-sub">
            Overdue ranking, bill and spend alerts, bill coding and reminders sent, for all five companies
            {lastRun ? ` · last checked ${when(lastRun.startedAt)}` : ""}
          </p>
        </div>
        <div className="head-actions">
          <button type="button" className="button primary" onClick={() => runNow.mutate()} disabled={runNow.isPending} data-testid="button-run-checks">
            <RefreshCw size={14} className={runNow.isPending ? "spin" : ""} /> {runNow.isPending ? "Checking Xero…" : "Run checks now"}
          </button>
        </div>
      </div>

      <RunStatus run={lastRun} loading={runs.isLoading} error={runs.isError ? errorText(runs.error) : null} />

      <div className="hh-inv-tabs" role="tablist" aria-label="Finance checks">
        <button type="button" role="tab" aria-selected={tab === "overdue"} className={tab === "overdue" ? "active" : ""} onClick={() => setParams({ tab: "" })}>Overdue ranking</button>
        <button type="button" role="tab" aria-selected={tab === "alerts"} className={tab === "alerts" ? "active" : ""} onClick={() => setParams({ tab: "alerts" })}>
          Bill &amp; spend alerts {alertCounts.data ? <span className={alertCounts.data.openHighCount ? "hh-chk-count bad" : ""}>{alertCounts.data.openCount}</span> : null}
        </button>
        <button type="button" role="tab" aria-selected={tab === "coding"} className={tab === "coding" ? "active" : ""} onClick={() => setParams({ tab: "coding" })}>Bill coding</button>
        <button type="button" role="tab" aria-selected={tab === "reminders"} className={tab === "reminders" ? "active" : ""} onClick={() => setParams({ tab: "reminders" })}>Reminders sent</button>
      </div>

      {tab === "overdue" && <OverdueTab get={get} setParams={setParams} />}
      {tab === "alerts" && <AlertsTab get={get} setParams={setParams} flash={flash} />}
      {tab === "coding" && <BillCodingTab get={get} setParams={setParams} flash={flash} />}
      {tab === "reminders" && <RemindersTab />}

      {toast && <div className="toast-msg" role="status">{toast}</div>}
    </>
  );
}

const runText = (run: CheckRun) => {
  const s = run.summary;
  if (!s) return run.status;
  return `${s.billsSynced} bills read${s.fullBillSync ? " (first full read)" : ""}, ${s.newBillFlags + s.newSpendFlags} new alerts, ${s.newOverdue} newly overdue.`;
};

function RunStatus({ run, loading, error }: { run: CheckRun | undefined; loading: boolean; error: string | null }) {
  if (loading) return null;
  if (error) return <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Check runs could not be loaded: {error}</p>;
  if (!run) return <section className="panel hh-fin-note">The checks haven't run yet. They run each morning from the n8n "Xero daily checks" workflow, or use Run checks now. The first run reads 13 months of supplier bills, so it takes a minute or two.</section>;
  return (
    <>
      {run.status === "failed" && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> The last check run failed: {run.error}</p>}
      {run.status !== "failed" && run.summary?.problems.length ? <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Last run, partly read: {run.summary.problems.join("; ")}</p> : null}
      {run.status === "running" && <section className="panel hh-fin-note">A check run started {when(run.startedAt)} and is still going.</section>}
    </>
  );
}

// --- Overdue ----------------------------------------------------------------------

function OverdueTab({ get, setParams }: { get: (key: string) => string; setParams: (change: Record<string, string>) => void }) {
  const query = useGetOverdueReport({ query: { queryKey: getGetOverdueReportQueryKey(), staleTime: 5 * 60_000 } });
  const data = query.data;
  const ledger = get("ledger");
  const priority = get("priority");
  const changedOnly = get("changed") === "1";
  const term = get("q");

  const visible = useMemo(() => {
    const needle = term.trim().toLowerCase();
    return (data?.items ?? []).filter((item) =>
      (!ledger || item.ledger === ledger) &&
      (!priority || String(item.priority) === priority) &&
      (!changedOnly || item.change !== "ongoing") &&
      (!needle || [item.number, item.contactName, item.company].some((value) => value?.toLowerCase().includes(needle))),
    );
  }, [data, ledger, priority, changedOnly, term]);

  if (query.isLoading) return <section className="panel hh-fin-note">Loading overdue invoices and bills from Xero…</section>;
  if (query.isError || !data) return <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> The overdue ranking could not be loaded: {errorText(query.error)}</p>;

  const receivables = data.items.filter((item) => item.ledger === "receivable");
  const payables = data.items.filter((item) => item.ledger === "payable");
  const sum = (items: OverdueItem[], pick: (item: OverdueItem) => number) => items.reduce((total, item) => total + pick(item), 0);
  const p1 = data.items.filter((item) => item.priority === 1);
  const changed = data.items.filter((item) => item.change !== "ongoing");

  return (
    <>
      {data.problems.map((problem) => <p key={problem} className="hh-props-alert" role="alert"><AlertTriangle size={14} /> {problem}</p>)}
      <div className="hh-fin-tiles" role="group" aria-label="Overdue summary">
        <button type="button" className={`hh-fin-tile button-tile ${receivables.length ? "good" : ""} ${ledger === "receivable" ? "active" : ""}`} aria-pressed={ledger === "receivable"} onClick={() => setParams({ ledger: ledger === "receivable" ? "" : "receivable" })}>
          <span>Owed to us, overdue</span><strong>{pounds.format(sum(receivables, (item) => item.amountDue))}</strong>
          <small>{receivables.length} invoices · value at risk about {pounds.format(sum(receivables, (item) => item.valueAtRisk))}</small>
        </button>
        <button type="button" className={`hh-fin-tile button-tile ${payables.length ? "bad" : ""} ${ledger === "payable" ? "active" : ""}`} aria-pressed={ledger === "payable"} onClick={() => setParams({ ledger: ledger === "payable" ? "" : "payable" })}>
          <span>We owe, overdue</span><strong>{pounds.format(sum(payables, (item) => item.amountDue))}</strong>
          <small>{payables.length} bills</small>
        </button>
        <button type="button" className={`hh-fin-tile button-tile ${p1.length ? "bad" : ""} ${priority === "1" ? "active" : ""}`} aria-pressed={priority === "1"} onClick={() => setParams({ priority: priority === "1" ? "" : "1" })}>
          <span>Act now (priority 1)</span><strong>{p1.length}</strong>
          <small>{pounds.format(sum(p1, (item) => item.amountDue))} due</small>
        </button>
        <button type="button" className={`hh-fin-tile button-tile ${changed.length ? "info" : ""} ${changedOnly ? "active" : ""}`} aria-pressed={changedOnly} onClick={() => setParams({ changed: changedOnly ? "" : "1" })}>
          <span>New or more urgent</span><strong>{changed.length}</strong>
          <small>{data.lastRunAt ? `since the check on ${when(data.lastRunAt)}` : "after the first daily check"}</small>
        </button>
      </div>

      {receivables.length > 0 && <RiskMatrix items={receivables} />}

      <div className="hh-fin-filter">
        <Search size={14} />
        <input value={term} onChange={(event) => setParams({ q: event.target.value })} placeholder="Search invoice, contact or company" aria-label="Search" />
        {term && <button type="button" className="icon-btn" onClick={() => setParams({ q: "" })} aria-label="Clear search"><X size={13} /></button>}
      </div>

      <section className="panel table-panel">
        <div className="table-wrap">
          <table className="hh-fin-table">
            <thead><tr><th>Priority</th><th>Invoice or bill</th><th>Due</th><th className="num">Amount due</th><th>Value · risk</th><th>Why</th></tr></thead>
            <tbody>
              {visible.map((item) => (
                <tr key={`${item.tenantId}-${item.invoiceId}`}>
                  <td><span className={`status ${PRIORITY[item.priority][1]}`}>{PRIORITY[item.priority][0]}</span></td>
                  <td>
                    <span className="hh-inv-head"><strong className="hh-nowrap">{item.number ?? "—"}</strong><CompanyTag tenantId={item.tenantId} name={item.company} /></span>
                    <span className="hh-inv-contact">{item.contactName}</span>
                    <small className="hh-fin-sub">{item.ledger === "receivable" ? "Owed to us" : "We owe"}</small>
                  </td>
                  <td className="hh-nowrap">{item.dueDate ? formatDate(item.dueDate) : "—"}<small className={`hh-fin-sub ${item.daysOverdue > 30 ? "bad" : "warn"}`}>{item.daysOverdue} {item.daysOverdue === 1 ? "day" : "days"} overdue</small></td>
                  <td className="num">{pence.format(item.amountDue)}{item.amountPaid > 0 && <small className="hh-fin-sub">{pence.format(item.amountPaid)} paid</small>}</td>
                  <td>
                    <span className="hh-nowrap">{item.valueBand} value</span>
                    <span className={`status ${RISK_CLASS[item.riskProfile]}`}>{item.riskProfile} risk</span>
                  </td>
                  <td>
                    {item.change === "new" && <span className="status upcoming">New</span>}
                    {item.change === "escalated" && <span className="status overdue">More urgent</span>}
                    <small className="hh-fin-sub">{item.riskReasons.length ? item.riskReasons.join("; ") : item.ageBucket + " overdue"}</small>
                    {item.ledger === "receivable" && item.valueAtRisk > 0 && <small className="hh-fin-sub">Value at risk about {pence.format(item.valueAtRisk)}</small>}
                    {item.change === "ongoing" && item.firstSeenOn && <small className="hh-fin-sub">Overdue since the check on {formatDate(item.firstSeenOn)}</small>}
                  </td>
                </tr>
              ))}
              {!visible.length && <tr><td colSpan={6}><div className="empty-state"><h3>Nothing overdue here</h3><p>No overdue invoices or bills match these filters.</p></div></td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <p className="hh-fin-foot">
        Priority 1: high value with medium or high risk, or medium value with high risk. Risk counts how long it is overdue, how many items the contact has overdue, their total outstanding, and whether they have part-paid.
        Value at risk is a rough guide (amount × the usual loss rate for that age), not an accounting provision.
      </p>
    </>
  );
}

function RiskMatrix({ items }: { items: OverdueItem[] }) {
  const bands = ["High", "Medium", "Low"] as const;
  return (
    <section className="panel table-panel">
      <div className="panel-head"><div><div className="panel-title">Value × risk, owed to us</div><div className="panel-caption">Overdue customer invoices: count and amount</div></div></div>
      <div className="table-wrap">
        <table className="hh-fin-table hh-chk-matrix">
          <thead><tr><th>Value</th>{bands.map((risk) => <th key={risk}>{risk} risk</th>)}</tr></thead>
          <tbody>
            {bands.map((value) => (
              <tr key={value}>
                <th scope="row">{value} value</th>
                {bands.map((risk) => {
                  const cell = items.filter((item) => item.valueBand === value && item.riskProfile === risk);
                  return <td key={risk} className={cell.length ? `hh-chk-cell ${RISK_CLASS[risk]}` : "hh-chk-cell empty"}>{cell.length} · {pounds.format(cell.reduce((sum, item) => sum + item.amountDue, 0))}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// --- Alerts -----------------------------------------------------------------------

const FILTERS: [FinanceAlertFilter, string][] = [["open", "Open"], ["resolved", "Resolved"], ["ignored", "Ignored"], ["all", "All"]];

function AlertsTab({ get, setParams, flash }: { get: (key: string) => string; setParams: (change: Record<string, string>) => void; flash: (message: string) => void }) {
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

function RemindersTab() {
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
              {!items.length && <tr><td colSpan={5}><div className="empty-state"><h3>No reminders yet</h3><p>Reminders sent from the Invoices page or by the automatic reminders appear here.</p></div></td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <p className="hh-fin-foot">The latest 500 reminders, re-sends and Xero notes. Reminders are switched on and configured on the Invoices page.</p>
    </>
  );
}
