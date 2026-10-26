import { useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Copy, Download, MessageSquarePlus, Search, Send, X } from "lucide-react";
import {
  getGetReceivablesQueryKey,
  getInvoicePaymentLink,
  useGetReceivables,
  useListIntakeReviews,
  useRunInvoiceAction,
  useUpdateInvoiceFollowUp,
  type InvoiceFollowUpOutcome,
  type ReminderStatus,
  type PayableBill,
  type ReceivableInvoice,
} from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import { ModalShell } from "@/components/properties/ModalShell";
import { downloadText, formatDate } from "@/services/properties";
import { ReminderBanner, ReminderCell, ReminderSettingsModal, SendReminderModal } from "./ReminderControls";
import { IntakeReviewsTab, intakeReviewsQueryOptions } from "./IntakeReviewsTab";
import { IntakeChecksTab } from "./IntakeChecksTab";
import "./finance.css";

// Invoices (Xero, Phase 1): what each company is owed and owes, with our own
// follow-up tracker. Nothing here sends anything to Xero or customers.

const pence = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const pounds = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
export const receivablesQueryOptions = { query: { queryKey: getGetReceivablesQueryKey(), staleTime: 5 * 60_000 } };

export const OUTCOMES: Record<InvoiceFollowUpOutcome, [string, string]> = {
  not_contacted: ["Not contacted", "na"],
  chased: ["Chased", "pending"],
  promised: ["Payment promised", "upcoming"],
  disputed: ["Disputed", "overdue"],
  paid_elsewhere: ["Says paid", "completed"],
  write_off_review: ["Write-off review", "overdue"],
};

type Tab = "receivables" | "bills" | "inbox" | "review";
type Bucket = "all" | "not_due" | "1_30" | "31_60" | "61_90" | "90_plus";
const BUCKETS: { key: Bucket; label: string; test: (days: number) => boolean }[] = [
  { key: "not_due", label: "Not yet due", test: (days) => days <= 0 },
  { key: "1_30", label: "1–30 days", test: (days) => days >= 1 && days <= 30 },
  { key: "31_60", label: "31–60 days", test: (days) => days >= 31 && days <= 60 },
  { key: "61_90", label: "61–90 days", test: (days) => days >= 61 && days <= 90 },
  { key: "90_plus", label: "Over 90 days", test: (days) => days > 90 },
];
// One fixed colour per company (validated on the dark panel), always shown with its name.
const COMPANY_COLOURS: Record<string, string> = {
  "47f65b32-d0d7-4417-bb5c-89ff2d93651e": "#3987e5", // Lettings
  "3ae8a283-c7e0-4287-9bcd-4c2561295890": "#d95926", // Holdings
  "9d1fee42-4203-47d8-87aa-6fa8e8ac0fef": "#199e70", // Hinkley Homes Ltd
  "0a290129-b001-4bfb-903d-d27a8ac55738": "#c98500", // Management
  "4c807578-e0a7-49ad-9644-8e705aec0c2a": "#d55181", // Stays
};
// "Hinkley Homes Lettings" -> "Lettings"; "Hinkley Homes Ltd" keeps its full name.
export const companyShortName = (name: string) => (name === "Hinkley Homes Ltd" ? name : name.replace(/^Hinkley Homes /, ""));
export function CompanyTag({ tenantId, name }: { tenantId: string; name: string }) {
  return (
    <span className="hh-co-tag" style={{ "--co": COMPANY_COLOURS[tenantId] ?? "#6f7f96" } as React.CSSProperties} title={name}>
      <i aria-hidden="true" />{companyShortName(name)}
    </span>
  );
}

const bucketTone = (key: Bucket) => (key === "not_due" ? "info" : key === "1_30" ? "neutral" : key === "31_60" ? "warn" : "bad");
const dueText = (days: number) => (days > 0 ? `${days} ${days === 1 ? "day" : "days"} overdue` : days === 0 ? "due today" : `due in ${-days} ${days === -1 ? "day" : "days"}`);

export default function InvoicesPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const get = (key: string) => params.get(key) ?? "";
  const setParams = (change: Record<string, string>) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(change)) value ? next.set(key, value) : next.delete(key);
    navigate(`/invoices${next.size ? `?${next}` : ""}`, { replace: true });
  };
  const tab: Tab = (["bills", "inbox", "review"] as const).find((key) => key === get("tab")) ?? "receivables";
  const intake = tab === "inbox" || tab === "review";
  const bucket = (BUCKETS.some((item) => item.key === get("age")) ? get("age") : "all") as Bucket;
  const company = get("company");
  const term = get("q");
  const dueOnly = get("chase") === "1";

  const query = useGetReceivables(receivablesQueryOptions);
  const data = query.data;
  const reviewOpen = useListIntakeReviews({ status: "open" }, intakeReviewsQueryOptions("open")).data?.openCount;
  const [editing, setEditing] = useState<ReceivableInvoice | null>(null);
  const [sending, setSending] = useState<ReceivableInvoice | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState("");
  const flash = (message: string) => { setToast(message); setTimeout(() => setToast(""), 3200); };

  const rows = (tab === "receivables" ? data?.invoices : data?.bills) ?? [];
  const inCompany = rows.filter((row) => !company || row.tenantId === company);
  const visible = useMemo(() => {
    const needle = term.trim().toLowerCase();
    const range = BUCKETS.find((item) => item.key === bucket);
    return inCompany.filter((row) =>
      (!range || range.test(row.daysOverdue)) &&
      (!dueOnly || (tab === "receivables" && (row as ReceivableInvoice).followUp?.nextChaseDate && (row as ReceivableInvoice).followUp!.nextChaseDate! <= (data?.asOf ?? ""))) &&
      (!needle || [row.number, row.contactName, row.description, row.property, "reference" in row ? row.reference : null].some((value) => value?.toLowerCase().includes(needle))),
    );
  }, [inCompany, bucket, term, dueOnly, tab, data]);
  const bucketTotal = (key: Bucket) => inCompany.filter((row) => BUCKETS.find((item) => item.key === key)!.test(row.daysOverdue)).reduce((sum, row) => sum + row.amountDue, 0);
  const chaseDue = (data?.invoices ?? []).filter((invoice) => invoice.followUp?.nextChaseDate && invoice.followUp.nextChaseDate <= data!.asOf).length;

  const copyLink = async (invoice: ReceivableInvoice) => {
    try {
      const { url } = await getInvoicePaymentLink(invoice.tenantId, invoice.invoiceId);
      await navigator.clipboard.writeText(url);
      flash(`Payment link for ${invoice.number ?? "the invoice"} copied.`);
    } catch (error) {
      flash(`Couldn't get the payment link: ${errorText(error)}`);
    }
  };

  const exportCsv = () => {
    if (!data) return;
    const cell = (value: string | number | null | undefined) => (value === null || value === undefined ? "" : /[",\r\n]/.test(String(value)) || /^[=+\-@]/.test(String(value)) ? `"${String(value).replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : String(value));
    const lines = tab === "receivables"
      ? [["company", "invoice", "contact", "reference", "property", "dueDate", "daysOverdue", "amountDue", "followUp", "nextChase"].join(","), ...(visible as ReceivableInvoice[]).map((row) => [row.company, row.number, row.contactName, row.reference, row.property, row.dueDate, row.daysOverdue, row.amountDue, row.followUp ? OUTCOMES[row.followUp.outcome][0] : "", row.followUp?.nextChaseDate].map(cell).join(","))]
      : [["company", "bill", "supplier", "description", "property", "dueDate", "daysOverdue", "amountDue", "status"].join(","), ...(visible as PayableBill[]).map((row) => [row.company, row.number, row.contactName, row.description, row.property, row.dueDate, row.daysOverdue, row.amountDue, row.status].map(cell).join(","))];
    downloadText(`hinkley-${tab}-${data.asOf}.csv`, lines.join("\r\n"));
  };

  const tabBar = (
    <div className="hh-inv-tabs" role="tablist" aria-label="Invoices, bills, inbox or invoices for review">
      <button type="button" role="tab" aria-selected={tab === "receivables"} className={tab === "receivables" ? "active" : ""} onClick={() => setParams({ tab: "", age: "", chase: "", status: "", verdict: "" })}>
        Owed to us {data && <span>{data.invoices.length}</span>}
      </button>
      <button type="button" role="tab" aria-selected={tab === "bills"} className={tab === "bills" ? "active" : ""} onClick={() => setParams({ tab: "bills", age: "", chase: "", status: "", verdict: "" })}>
        Bills to pay {data && <span>{data.bills.length}</span>}
      </button>
      <button type="button" role="tab" aria-selected={tab === "inbox"} className={tab === "inbox" ? "active" : ""} onClick={() => setParams({ tab: "inbox", age: "", chase: "", q: "", status: "", company: "" })}>
        Inbox
      </button>
      <button type="button" role="tab" aria-selected={tab === "review"} className={tab === "review" ? "active" : ""} onClick={() => setParams({ tab: "review", age: "", chase: "", q: "", verdict: "", company: "" })}>
        For review {reviewOpen !== undefined && <span className={reviewOpen ? "hh-chk-count bad" : ""}>{reviewOpen}</span>}
      </button>
    </div>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Hinkley Homes · Xero</div>
          <h1 className="page-title">Invoices</h1>
          <p className="page-sub">{tab === "inbox" ? "Every email to accounts@ the intake check looked at, with the saved invoice or its link" : tab === "review" ? "Invoices emailed to accounts@ that the intake check sent for a person to look at" : <>What each company is owed and owes in Xero, with follow-ups{data ? ` · as of ${formatDate(data.asOf)}` : ""}</>}</p>
        </div>
        <div className="head-actions">
          {!intake && <button type="button" className="button" onClick={exportCsv} disabled={!visible.length} data-testid="button-invoices-export"><Download size={14} /> Export (CSV)</button>}
        </div>
      </div>

      {intake ? (
        <>
          {tabBar}
          {tab === "inbox" ? <IntakeChecksTab get={get} setParams={setParams} /> : <IntakeReviewsTab get={get} setParams={setParams} flash={flash} />}
        </>
      ) : <>
      {query.isLoading && <section className="panel hh-fin-note">Loading invoices from Xero for all five companies…</section>}
      {query.isError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Invoices could not be loaded: {errorText(query.error)}</p>}
      {data?.companies.filter((item) => item.error).map((item) => <p key={item.tenantId} className="hh-props-alert" role="alert"><AlertTriangle size={14} /> {item.name}: {item.error}</p>)}
      {data && !data.followUpsAvailable && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Follow-ups can't be saved yet: the follow-up tables haven't been created in the database.</p>}

      {data && (
        <>
          {tab === "receivables" && data.followUpsAvailable && <ReminderBanner status={data.reminders} onSettings={() => setSettingsOpen(true)} />}

          <div className="hh-inv-companies" role="group" aria-label="Filter by company">
            <button type="button" className={`hh-inv-company ${!company ? "active" : ""}`} aria-pressed={!company} onClick={() => setParams({ company: "" })}>
              <span>All companies</span>
              <strong>{pounds.format(tab === "receivables" ? data.companies.reduce((sum, item) => sum + item.receivableOverdue, 0) : data.companies.reduce((sum, item) => sum + item.billsOverdue, 0))}</strong>
              <small>{tab === "receivables" ? "overdue to us" : "overdue bills"}</small>
            </button>
            {data.companies.map((item) => {
              const amount = tab === "receivables" ? item.receivableOverdue : item.billsOverdue;
              const count = tab === "receivables" ? item.overdueCount : item.billsOverdueCount;
              return (
                <button key={item.tenantId} type="button" className={`hh-inv-company ${company === item.tenantId ? "active" : ""} ${amount ? "has" : ""}`} aria-pressed={company === item.tenantId} onClick={() => setParams({ company: company === item.tenantId ? "" : item.tenantId })}>
                  <span className="hh-co-chip-name"><i style={{ background: COMPANY_COLOURS[item.tenantId] ?? "#6f7f96" }} aria-hidden="true" />{companyShortName(item.name)}</span>
                  <strong>{pounds.format(amount)}</strong>
                  <small>{count} overdue{!item.holdsPropertyMoney ? " · no property money" : ""}</small>
                </button>
              );
            })}
          </div>

          {tabBar}

          <div className="hh-fin-tiles six" role="group" aria-label="Filter by age">
            {BUCKETS.map((item) => {
              const amount = bucketTotal(item.key);
              const active = bucket === item.key;
              return (
                <button key={item.key} type="button" className={`hh-fin-tile button-tile ${amount ? bucketTone(item.key) : ""} ${active ? "active" : ""}`} aria-pressed={active} onClick={() => setParams({ age: active ? "" : item.key })}>
                  <span>{item.label}</span><strong>{pounds.format(amount)}</strong>
                  <small>{inCompany.filter((row) => item.test(row.daysOverdue)).length} {tab === "receivables" ? "invoices" : "bills"}</small>
                </button>
              );
            })}
            {tab === "receivables" && (
              <button type="button" className={`hh-fin-tile button-tile ${chaseDue ? "warn" : ""} ${dueOnly ? "active" : ""}`} aria-pressed={dueOnly} onClick={() => setParams({ chase: dueOnly ? "" : "1" })}>
                <span>Chase today</span><strong>{chaseDue}</strong><small>Next chase date reached</small>
              </button>
            )}
          </div>

          <div className="hh-fin-filter">
            <Search size={14} />
            <input value={term} onChange={(event) => setParams({ q: event.target.value })} placeholder={tab === "receivables" ? "Search invoice, contact, reference or property" : "Search bill, supplier or property"} aria-label="Search" data-testid="input-invoices-search" />
            {term && <button type="button" className="icon-btn" onClick={() => setParams({ q: "" })} aria-label="Clear search"><X size={13} /></button>}
          </div>

          <section className="panel table-panel">
            <div className="table-wrap">
              {tab === "receivables" ? (
                <table className="hh-fin-table hh-inv-table">
                  <colgroup><col className="c-invoice" /><col className="c-for" /><col className="c-due" /><col className="c-amount" /><col className="c-follow" /><col className="c-actions" /></colgroup>
                  <thead><tr><th>Invoice</th><th>For</th><th>Due</th><th className="num">Amount due</th><th>Follow-up &amp; reminders</th><th aria-label="Actions" /></tr></thead>
                  <tbody>
                    {(visible as ReceivableInvoice[]).map((row) => {
                      const outcome = row.followUp ? OUTCOMES[row.followUp.outcome] : null;
                      return (
                        <tr key={row.invoiceId} data-testid={`row-invoice-${row.invoiceId}`}>
                          <td>
                            <span className="hh-inv-head"><strong className="hh-nowrap">{row.number ?? "—"}</strong><CompanyTag tenantId={row.tenantId} name={row.company} /></span>
                            <span className="hh-inv-contact">{row.contactName}</span>
                            <small className="hh-fin-sub">{row.sent ? "Sent to customer" : "Not sent to customer"}</small>
                          </td>
                          <td>
                            <span className="hh-inv-for" title={row.reference ?? row.description ?? undefined}>{row.reference ?? row.description ?? "—"}</span>
                            {row.property && <small className="hh-fin-sub">{row.property}</small>}
                            {row.cohoProperty && <small className="hh-fin-sub info">Rent also tracked in COHO: <Link href={`/properties/${encodeURIComponent(row.cohoProperty.propertyReference)}`}>{row.cohoProperty.propertyName}</Link></small>}
                          </td>
                          <td className="hh-nowrap">{row.dueDate ? formatDate(row.dueDate) : "—"}<small className={`hh-fin-sub ${row.daysOverdue > 30 ? "bad" : row.daysOverdue > 0 ? "warn" : ""}`}>{dueText(row.daysOverdue)}</small></td>
                          <td className="num">{pence.format(row.amountDue)}{row.amountDue !== row.total && <small className="hh-fin-sub">of {pence.format(row.total)}</small>}</td>
                          <td>
                            {outcome && <span className={`status ${outcome[1]}`}>{outcome[0]}</span>}
                            {row.followUp?.nextChaseDate && <small className={`hh-fin-sub ${row.followUp.nextChaseDate <= data.asOf ? "warn" : ""}`}>Chase {formatDate(row.followUp.nextChaseDate)}</small>}
                            {row.followUp?.promisedDate && <small className="hh-fin-sub">Promised {formatDate(row.followUp.promisedDate)}</small>}
                            {row.followUp?.remindersPaused && <small className="hh-fin-sub warn">Reminders paused</small>}
                            <ReminderCell invoice={row} />
                          </td>
                          <td className="hh-inv-actions">
                            <button type="button" className="icon-btn" onClick={() => setEditing(row)} disabled={!data.followUpsAvailable} title={data.followUpsAvailable ? "Record a follow-up" : "Follow-up tables not created yet"} aria-label={`Follow up ${row.number ?? "invoice"}`}><MessageSquarePlus size={15} /></button>
                            {data.reminders && row.daysOverdue > 0 && (
                              <button type="button" className="icon-btn" onClick={() => setSending(row)} title="Chase: send a reminder now" aria-label={`Chase ${row.number ?? "invoice"}`}><Send size={15} /></button>
                            )}
                            <button type="button" className="icon-btn" onClick={() => copyLink(row)} title="Copy Xero's view-and-pay link" aria-label={`Copy payment link for ${row.number ?? "invoice"}`}><Copy size={15} /></button>
                          </td>
                        </tr>
                      );
                    })}
                    {!visible.length && <tr><td colSpan={6}><div className="empty-state"><h3>Nothing owed here</h3><p>No open invoices match these filters.</p></div></td></tr>}
                  </tbody>
                </table>
              ) : (
                <table className="hh-fin-table hh-inv-table">
                  <colgroup><col className="c-invoice" /><col className="c-for" /><col className="c-due" /><col className="c-amount" /><col className="c-status" /></colgroup>
                  <thead><tr><th>Bill</th><th>For</th><th>Due</th><th className="num">Amount due</th><th>Status</th></tr></thead>
                  <tbody>
                    {(visible as PayableBill[]).map((row) => (
                      <tr key={row.billId}>
                        <td>
                          <span className="hh-inv-head"><strong className="hh-nowrap">{row.number ?? "—"}</strong><CompanyTag tenantId={row.tenantId} name={row.company} /></span>
                          <span className="hh-inv-contact">{row.contactName}</span>
                        </td>
                        <td><span className="hh-inv-for" title={row.description ?? undefined}>{row.description ?? "—"}</span>{row.property && <small className="hh-fin-sub">{row.property}</small>}</td>
                        <td className="hh-nowrap">{row.dueDate ? formatDate(row.dueDate) : "—"}<small className={`hh-fin-sub ${row.daysOverdue > 30 ? "bad" : row.daysOverdue > 0 ? "warn" : ""}`}>{dueText(row.daysOverdue)}</small></td>
                        <td className="num">{pence.format(row.amountDue)}{row.amountDue !== row.total && <small className="hh-fin-sub">of {pence.format(row.total)}</small>}</td>
                        <td><span className={`status ${row.status === "SUBMITTED" ? "pending" : row.daysOverdue > 0 ? "overdue" : "upcoming"}`}>{row.status === "SUBMITTED" ? "Awaiting approval" : row.daysOverdue > 0 ? "Overdue" : "To pay"}</span></td>
                      </tr>
                    ))}
                    {!visible.length && <tr><td colSpan={5}><div className="empty-state"><h3>No bills</h3><p>No open bills match these filters.</p></div></td></tr>}
                  </tbody>
                </table>
              )}
            </div>
          </section>
          <p className="hh-fin-foot">Read-only from Xero. Follow-ups are kept in this app only; sending invoices and reminders is still done in Xero.</p>
        </>
      )}
      </>}

      {editing && <FollowUpModal invoice={editing} reminders={data?.reminders ?? null} onClose={() => setEditing(null)} onSaved={(message) => { setEditing(null); flash(message); }} />}
      {sending && data?.reminders && <SendReminderModal invoice={sending} status={data.reminders} onClose={() => setSending(null)} onDone={(message) => { setSending(null); flash(message); }} />}
      {settingsOpen && <ReminderSettingsModal onClose={() => setSettingsOpen(false)} onSaved={(message) => { setSettingsOpen(false); flash(message); }} />}
      {toast && <div className="toast-msg" role="status">{toast}</div>}
    </>
  );
}

function FollowUpModal({ invoice, reminders, onClose, onSaved }: { invoice: ReceivableInvoice; reminders: ReminderStatus | null; onClose: () => void; onSaved: (message: string) => void }) {
  const queryClient = useQueryClient();
  const current = invoice.followUp;
  const [outcome, setOutcome] = useState<InvoiceFollowUpOutcome>(current?.outcome === "not_contacted" || !current ? "chased" : current.outcome);
  const [nextChaseDate, setNextChaseDate] = useState(current?.nextChaseDate ?? "");
  const [promisedDate, setPromisedDate] = useState(current?.promisedDate ?? "");
  const [note, setNote] = useState("");
  const [paused, setPaused] = useState(current?.remindersPaused ?? false);
  const [noteInXero, setNoteInXero] = useState(false);
  const live = reminders?.mode === "live" && reminders.webhookConfigured;
  const xeroNote = useRunInvoiceAction();
  const mutation = useUpdateInvoiceFollowUp({
    mutation: {
      onSuccess: async () => {
        let extra = "";
        if (noteInXero && note.trim()) {
          try {
            const result = await xeroNote.mutateAsync({ tenantId: invoice.tenantId, invoiceId: invoice.invoiceId, data: { action: "xero_note", note: note.trim() } });
            extra = result.status === "sent" ? " Note added in Xero." : ` Xero note not added: ${result.detail}`;
          } catch (error) {
            extra = ` Xero note not added: ${errorText(error)}`;
          }
        }
        void queryClient.invalidateQueries({ queryKey: getGetReceivablesQueryKey() });
        onSaved(`Follow-up saved for ${invoice.number ?? "the invoice"}.${extra}`);
      },
    },
  });
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    mutation.mutate({
      tenantId: invoice.tenantId,
      invoiceId: invoice.invoiceId,
      data: {
        outcome,
        nextChaseDate: nextChaseDate || null,
        promisedDate: outcome === "promised" ? promisedDate || null : null,
        note: note.trim() || null,
        invoiceNumber: invoice.number,
        contactName: invoice.contactName,
        remindersPaused: paused,
      },
    });
  };
  return (
    <ModalShell
      title={`Follow up ${invoice.number ?? "invoice"}`}
      caption={`${invoice.contactName} · ${pence.format(invoice.amountDue)} · ${dueText(invoice.daysOverdue)} · ${invoice.company}`}
      onClose={onClose}
      onSubmit={submit}
      testId="modal-invoice-follow-up"
      footer={<>
        <button type="button" className="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary" disabled={mutation.isPending || xeroNote.isPending}>{mutation.isPending || xeroNote.isPending ? "Saving…" : "Save follow-up"}</button>
      </>}
    >
      <div className="form-grid">
        <label className="field">
          Outcome
          <select className="select-control" value={outcome} onChange={(event) => setOutcome(event.target.value as InvoiceFollowUpOutcome)}>
            {(Object.keys(OUTCOMES) as InvoiceFollowUpOutcome[]).map((key) => <option key={key} value={key}>{OUTCOMES[key][0]}</option>)}
          </select>
        </label>
        <label className="field">
          Next chase date
          <input type="date" value={nextChaseDate} onChange={(event) => setNextChaseDate(event.target.value)} />
        </label>
        {outcome === "promised" && (
          <label className="field">
            Promised payment date
            <input type="date" value={promisedDate} onChange={(event) => setPromisedDate(event.target.value)} />
          </label>
        )}
        <label className="field full">
          Note
          <textarea rows={3} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Who you spoke to, what they said" />
        </label>
      </div>
      {reminders && (
        <div className="hh-rem-checks">
          <label><input type="checkbox" checked={paused} onChange={(event) => setPaused(event.target.checked)} /> Pause automatic reminders for this invoice</label>
          <label className={live ? "" : "disabled"} title={live ? "" : "Live mode and the n8n reminders workflow are needed"}>
            <input type="checkbox" disabled={!live} checked={noteInXero} onChange={(event) => setNoteInXero(event.target.checked)} /> Also add this note to the invoice's History in Xero{live ? "" : " (live mode only)"}
          </label>
        </div>
      )}
      {mutation.isError && <p className="hh-field-error" role="alert">{errorText(mutation.error)}</p>}
      {current && current.notes.length > 0 && (
        <div className="hh-inv-history">
          <h3>History</h3>
          <ol>
            {current.notes.map((item, index) => (
              <li key={`${item.createdAt}-${index}`}>
                <span className={`status ${OUTCOMES[item.outcome][1]}`}>{OUTCOMES[item.outcome][0]}</span>
                <span className="hh-inv-history-meta">{new Date(item.createdAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}{item.authorEmail ? ` · ${item.authorEmail}` : ""}</span>
                {item.note && <p>{item.note}</p>}
              </li>
            ))}
          </ol>
        </div>
      )}
      <p className="hh-fin-foot">Saved in this app{noteInXero ? " and as a note in Xero" : ""}. Nothing is sent to the customer from here; use Chase to send a reminder.</p>
    </ModalShell>
  );
}

// Operations overview strip: money owed to the group in Xero and bills overdue.
export function ReceivablesStrip() {
  const query = useGetReceivables(receivablesQueryOptions);
  const data = query.data;
  const overdue = data?.companies.reduce((sum, item) => sum + item.receivableOverdue, 0) ?? 0;
  const overdueCount = data?.companies.reduce((sum, item) => sum + item.overdueCount, 0) ?? 0;
  const bills = data?.companies.reduce((sum, item) => sum + item.billsOverdue, 0) ?? 0;
  const oldest = data?.invoices.find((invoice) => invoice.daysOverdue > 0);
  const chase = data?.invoices.filter((invoice) => invoice.followUp?.nextChaseDate && invoice.followUp.nextChaseDate <= data.asOf).length ?? 0;
  return (
    <section className="panel hh-perf-strip" aria-label="Xero invoices">
      <div><div className="panel-title">Invoices · Xero</div><div className="panel-caption">All five companies</div></div>
      <div className="hh-perf-strip-stats">
        {query.isLoading ? <div><span>Loading…</span></div>
          : !data ? <div><span>Invoices could not be loaded from Xero</span></div>
            : (
              <>
                <div><span>Owed to us, overdue</span><strong className={overdue ? "bad" : "good"}>{pounds.format(overdue)}</strong></div>
                <div><span>Overdue invoices</span><strong>{overdueCount}</strong></div>
                <div><span>Oldest overdue</span><strong className={oldest && oldest.daysOverdue > 60 ? "bad" : ""}>{oldest ? `${oldest.daysOverdue} days` : "—"}</strong></div>
                <div><span>Chase today</span><strong className={chase ? "warn" : ""}>{chase}</strong></div>
                <div><span>Bills overdue</span><strong className={bills ? "warn" : "good"}>{pounds.format(bills)}</strong></div>
              </>
            )}
      </div>
      <Link href="/invoices" className="button">Open invoices</Link>
    </section>
  );
}
