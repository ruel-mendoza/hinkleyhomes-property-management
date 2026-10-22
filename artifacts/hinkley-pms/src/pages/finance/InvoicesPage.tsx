import { useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Copy, Download, MessageSquarePlus, Search, X } from "lucide-react";
import {
  getGetReceivablesQueryKey,
  getInvoicePaymentLink,
  useGetReceivables,
  useUpdateInvoiceFollowUp,
  type InvoiceFollowUpOutcome,
  type PayableBill,
  type ReceivableInvoice,
} from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import { ModalShell } from "@/components/properties/ModalShell";
import { downloadText, formatDate } from "@/services/properties";
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

type Tab = "receivables" | "bills";
type Bucket = "all" | "not_due" | "1_30" | "31_60" | "61_90" | "90_plus";
const BUCKETS: { key: Bucket; label: string; test: (days: number) => boolean }[] = [
  { key: "not_due", label: "Not yet due", test: (days) => days <= 0 },
  { key: "1_30", label: "1–30 days", test: (days) => days >= 1 && days <= 30 },
  { key: "31_60", label: "31–60 days", test: (days) => days >= 31 && days <= 60 },
  { key: "61_90", label: "61–90 days", test: (days) => days >= 61 && days <= 90 },
  { key: "90_plus", label: "Over 90 days", test: (days) => days > 90 },
];
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
  const tab: Tab = get("tab") === "bills" ? "bills" : "receivables";
  const bucket = (BUCKETS.some((item) => item.key === get("age")) ? get("age") : "all") as Bucket;
  const company = get("company");
  const term = get("q");
  const dueOnly = get("chase") === "1";

  const query = useGetReceivables(receivablesQueryOptions);
  const data = query.data;
  const [editing, setEditing] = useState<ReceivableInvoice | null>(null);
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

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Hinkley Homes · Xero</div>
          <h1 className="page-title">Invoices</h1>
          <p className="page-sub">What each company is owed and owes in Xero, with follow-ups{data ? ` · as of ${formatDate(data.asOf)}` : ""}</p>
        </div>
        <div className="head-actions">
          <button type="button" className="button" onClick={exportCsv} disabled={!visible.length} data-testid="button-invoices-export"><Download size={14} /> Export (CSV)</button>
        </div>
      </div>

      {query.isLoading && <section className="panel hh-fin-note">Loading invoices from Xero for all five companies…</section>}
      {query.isError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Invoices could not be loaded: {errorText(query.error)}</p>}
      {data?.companies.filter((item) => item.error).map((item) => <p key={item.tenantId} className="hh-props-alert" role="alert"><AlertTriangle size={14} /> {item.name}: {item.error}</p>)}
      {data && !data.followUpsAvailable && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Follow-ups can't be saved yet: the follow-up tables haven't been created in the database.</p>}

      {data && (
        <>
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
                  <span>{item.name.replace("Hinkley Homes ", "")}</span>
                  <strong>{pounds.format(amount)}</strong>
                  <small>{count} overdue{!item.holdsPropertyMoney ? " · no property money" : ""}</small>
                </button>
              );
            })}
          </div>

          <div className="hh-inv-tabs" role="tablist" aria-label="Invoices or bills">
            <button type="button" role="tab" aria-selected={tab === "receivables"} className={tab === "receivables" ? "active" : ""} onClick={() => setParams({ tab: "", age: "", chase: "" })}>
              Owed to us <span>{data.invoices.length}</span>
            </button>
            <button type="button" role="tab" aria-selected={tab === "bills"} className={tab === "bills" ? "active" : ""} onClick={() => setParams({ tab: "bills", age: "", chase: "" })}>
              Bills to pay <span>{data.bills.length}</span>
            </button>
          </div>

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
                <table className="hh-fin-table">
                  <thead><tr><th>Invoice</th><th>Contact</th><th>For</th><th>Due</th><th className="num">Amount due</th><th>Follow-up</th><th aria-label="Actions" /></tr></thead>
                  <tbody>
                    {(visible as ReceivableInvoice[]).map((row) => {
                      const outcome = row.followUp ? OUTCOMES[row.followUp.outcome] : null;
                      return (
                        <tr key={row.invoiceId} data-testid={`row-invoice-${row.invoiceId}`}>
                          <td className="hh-nowrap"><strong>{row.number ?? "—"}</strong><small className="hh-fin-sub">{row.company}{row.sent ? " · sent" : " · not sent"}</small></td>
                          <td>{row.contactName}</td>
                          <td>
                            {row.reference ?? row.description ?? "—"}
                            {row.property && <small className="hh-fin-sub">{row.property}</small>}
                            {row.cohoProperty && <small className="hh-fin-sub info">Rent also tracked in COHO: <Link href={`/properties/${encodeURIComponent(row.cohoProperty.propertyReference)}`}>{row.cohoProperty.propertyName}</Link></small>}
                          </td>
                          <td className="hh-nowrap">{row.dueDate ? formatDate(row.dueDate) : "—"}<small className={`hh-fin-sub ${row.daysOverdue > 30 ? "bad" : row.daysOverdue > 0 ? "warn" : ""}`}>{dueText(row.daysOverdue)}</small></td>
                          <td className="num">{pence.format(row.amountDue)}{row.amountDue !== row.total && <small className="hh-fin-sub">of {pence.format(row.total)}</small>}</td>
                          <td>
                            {outcome ? <span className={`status ${outcome[1]}`}>{outcome[0]}</span> : <span className="secondary-text" style={{ margin: 0 }}>—</span>}
                            {row.followUp?.nextChaseDate && <small className={`hh-fin-sub ${row.followUp.nextChaseDate <= data.asOf ? "warn" : ""}`}>Chase {formatDate(row.followUp.nextChaseDate)}</small>}
                            {row.followUp?.promisedDate && <small className="hh-fin-sub">Promised {formatDate(row.followUp.promisedDate)}</small>}
                          </td>
                          <td className="hh-inv-actions">
                            <button type="button" className="button" onClick={() => setEditing(row)} disabled={!data.followUpsAvailable} title={data.followUpsAvailable ? "Record a follow-up" : "Follow-up tables not created yet"}><MessageSquarePlus size={13} /> Follow up</button>
                            <button type="button" className="icon-btn" onClick={() => copyLink(row)} title="Copy Xero's view-and-pay link" aria-label={`Copy payment link for ${row.number ?? "invoice"}`}><Copy size={14} /></button>
                          </td>
                        </tr>
                      );
                    })}
                    {!visible.length && <tr><td colSpan={7}><div className="empty-state"><h3>Nothing owed here</h3><p>No open invoices match these filters.</p></div></td></tr>}
                  </tbody>
                </table>
              ) : (
                <table className="hh-fin-table">
                  <thead><tr><th>Bill</th><th>Supplier</th><th>For</th><th>Due</th><th className="num">Amount due</th><th>Status</th></tr></thead>
                  <tbody>
                    {(visible as PayableBill[]).map((row) => (
                      <tr key={row.billId}>
                        <td className="hh-nowrap"><strong>{row.number ?? "—"}</strong><small className="hh-fin-sub">{row.company}</small></td>
                        <td>{row.contactName}</td>
                        <td>{row.description ?? "—"}{row.property && <small className="hh-fin-sub">{row.property}</small>}</td>
                        <td className="hh-nowrap">{row.dueDate ? formatDate(row.dueDate) : "—"}<small className={`hh-fin-sub ${row.daysOverdue > 30 ? "bad" : row.daysOverdue > 0 ? "warn" : ""}`}>{dueText(row.daysOverdue)}</small></td>
                        <td className="num">{pence.format(row.amountDue)}{row.amountDue !== row.total && <small className="hh-fin-sub">of {pence.format(row.total)}</small>}</td>
                        <td><span className={`status ${row.status === "SUBMITTED" ? "pending" : row.daysOverdue > 0 ? "overdue" : "upcoming"}`}>{row.status === "SUBMITTED" ? "Awaiting approval" : row.daysOverdue > 0 ? "Overdue" : "To pay"}</span></td>
                      </tr>
                    ))}
                    {!visible.length && <tr><td colSpan={6}><div className="empty-state"><h3>No bills</h3><p>No open bills match these filters.</p></div></td></tr>}
                  </tbody>
                </table>
              )}
            </div>
          </section>
          <p className="hh-fin-foot">Read-only from Xero. Follow-ups are kept in this app only; sending invoices and reminders is still done in Xero.</p>
        </>
      )}

      {editing && <FollowUpModal invoice={editing} onClose={() => setEditing(null)} onSaved={(message) => { setEditing(null); flash(message); }} />}
      {toast && <div className="toast-msg" role="status">{toast}</div>}
    </>
  );
}

function FollowUpModal({ invoice, onClose, onSaved }: { invoice: ReceivableInvoice; onClose: () => void; onSaved: (message: string) => void }) {
  const queryClient = useQueryClient();
  const current = invoice.followUp;
  const [outcome, setOutcome] = useState<InvoiceFollowUpOutcome>(current?.outcome === "not_contacted" || !current ? "chased" : current.outcome);
  const [nextChaseDate, setNextChaseDate] = useState(current?.nextChaseDate ?? "");
  const [promisedDate, setPromisedDate] = useState(current?.promisedDate ?? "");
  const [note, setNote] = useState("");
  const mutation = useUpdateInvoiceFollowUp({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetReceivablesQueryKey() });
        onSaved(`Follow-up saved for ${invoice.number ?? "the invoice"}.`);
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
        <button type="submit" className="button primary" disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : "Save follow-up"}</button>
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
      <p className="hh-fin-foot">Saved in this app only. Nothing is sent to the customer or to Xero.</p>
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
