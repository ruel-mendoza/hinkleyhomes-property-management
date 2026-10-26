import { useMemo } from "react";
import { AlertTriangle, FileText, Link2, Search, X } from "lucide-react";
import {
  getListIntakeChecksQueryKey,
  useListIntakeChecks,
  type IntakeCheckFilter,
  type IntakeFile,
} from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import { formatDate } from "@/services/properties";
import "./finance.css";

// Invoices page, "Inbox" tab: every email to accounts@ the n8n intake check
// looked at, what it decided, and where to open the invoice: the copy it saved
// to SharePoint, or the invoice link from Xero, QuickBooks and the like.

const pence = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const FILTERS: [IntakeCheckFilter, string][] = [["invoices", "All invoices"], ["pass", "Passed"], ["bounce", "Bounced"], ["review", "For review"], ["not_invoice", "Not invoices"]];
const VERDICT: Record<string, [string, string]> = {
  pass: ["Passed", "completed"],
  bounce: ["Bounced", "overdue"],
  review: ["For review", "pending"],
  not_invoice: ["Not an invoice", "na"],
};
const ACTION: Record<string, string> = {
  shadow_proposed: "Shadow mode: you were sent the request instead",
  draft_created: "Reply drafted in accounts@",
  bounce_sent: "Supplier asked to reissue",
};

// Opens the saved copy (SharePoint) or the invoice link in the email.
export function InvoiceFileLinks({ files }: { files: IntakeFile[] }) {
  if (!files.length) return null;
  return (
    <span className="hh-intake-files">
      {files.map((file) => {
        let host = "";
        try { host = new URL(file.url).hostname.replace(/^www\./, ""); } catch { /* shown without a host */ }
        const label = file.kind === "file" ? `Open the saved invoice${file.name ? `: ${file.name}` : ""}` : `Open the invoice link${host ? ` on ${host}` : ""}`;
        return (
          <a key={file.url} className="icon-btn" href={file.url} target="_blank" rel="noreferrer noopener" title={label} aria-label={label}>
            {file.kind === "file" ? <FileText size={15} aria-hidden="true" /> : <Link2 size={15} aria-hidden="true" />}
          </a>
        );
      })}
    </span>
  );
}

export function IntakeChecksTab({ get, setParams }: { get: (key: string) => string; setParams: (change: Record<string, string>) => void }) {
  const verdict = (FILTERS.some(([key]) => key === get("verdict")) ? get("verdict") : "invoices") as IntakeCheckFilter;
  const term = get("q");
  const query = useListIntakeChecks({ verdict }, { query: { queryKey: getListIntakeChecksQueryKey({ verdict }), staleTime: 60_000 } });
  const counts = query.data?.counts;
  const items = useMemo(() => {
    const needle = term.trim().toLowerCase();
    const rows = query.data?.items ?? [];
    return needle ? rows.filter((row) => [row.senderEmail, row.subject, row.supplierName, row.invoiceNumber, row.billTo].some((value) => value?.toLowerCase().includes(needle))) : rows;
  }, [query.data, term]);
  const countFor = (key: IntakeCheckFilter) => (!counts ? null : key === "invoices" ? counts.pass + counts.bounce + counts.review : key === "all" ? null : counts[key]);

  return (
    <>
      <div className="hh-inv-companies" role="group" aria-label="Filter by result">
        {FILTERS.map(([key, label]) => (
          <button key={key} type="button" className={`hh-inv-company ${verdict === key ? "active" : ""}`} aria-pressed={verdict === key} onClick={() => setParams({ verdict: key === "invoices" ? "" : key })}>
            <span>{label}</span>
            {countFor(key) !== null && <strong>{countFor(key)}</strong>}
          </button>
        ))}
      </div>

      <div className="hh-fin-filter">
        <Search size={14} />
        <input value={term} onChange={(event) => setParams({ q: event.target.value })} placeholder="Search sender, subject, supplier, invoice or bill-to" aria-label="Search" />
        {term && <button type="button" className="icon-btn" onClick={() => setParams({ q: "" })} aria-label="Clear search"><X size={13} /></button>}
      </div>

      {query.isLoading && <section className="panel hh-fin-note">Loading the inbox log…</section>}
      {query.isError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> The inbox log could not be loaded: {errorText(query.error)}</p>}

      {query.data && (
        <section className="panel table-panel">
          <div className="table-wrap">
            <table className="hh-fin-table">
              <thead><tr><th>Email</th><th>Invoice</th><th className="num">Total</th><th>Result</th><th>Open</th></tr></thead>
              <tbody>
                {items.map((row) => {
                  const result = VERDICT[row.verdict] ?? [row.verdict, "na"];
                  return (
                    <tr key={row.id}>
                      <td className="hh-chk-summary">
                        <strong>{row.senderEmail ?? "Unknown sender"}</strong>
                        {row.subject && <small className="hh-fin-sub">{row.subject}</small>}
                        <small className="hh-fin-sub">Checked {when(row.processedAt)}</small>
                      </td>
                      <td className="hh-chk-summary">
                        <strong>{row.supplierName || "—"}</strong>
                        <small className="hh-fin-sub">{[row.invoiceNumber, row.invoiceDate ? formatDate(row.invoiceDate) : null].filter(Boolean).join(" · ") || "No number or date read"}</small>
                        {row.billTo && <small className="hh-fin-sub">To: {row.billTo}</small>}
                      </td>
                      <td className="num">{row.total !== null ? pence.format(row.total) : "—"}</td>
                      <td className="hh-chk-summary">
                        <span className={`status ${result[1]}`}>{result[0]}</span>
                        {row.action && ACTION[row.action] && <small className="hh-fin-sub">{ACTION[row.action]}</small>}
                        {row.issueCodes && <small className="hh-fin-sub">{row.issueCodes.replace(/_/g, " ")}</small>}
                      </td>
                      <td>{row.files.length ? <InvoiceFileLinks files={row.files} /> : <small className="hh-fin-sub">—</small>}</td>
                    </tr>
                  );
                })}
                {!items.length && <tr><td colSpan={5}><div className="empty-state"><h3>Nothing here</h3><p>{term ? "No emails match this search." : "The intake check hasn't logged any emails with this result yet."}</p></div></td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <p className="hh-fin-foot">
        Every email to accounts@ the intake check has looked at (the latest 500). Saved copies open in SharePoint with your Microsoft 365 login; invoice links open the supplier's invoice page, so check the address before paying anything from it.
      </p>
    </>
  );
}
