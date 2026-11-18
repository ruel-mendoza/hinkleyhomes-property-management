import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, FileText, Link2, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import {
  getGetIntakeFallbackStatusQueryKey,
  getListIntakeChecksQueryKey,
  getListIntakeReviewsQueryKey,
  useClearNotInvoiceIntakeChecks,
  useGetIntakeFallbackStatus,
  useListIntakeChecks,
  useRunIntakeFallback,
  type IntakeAliasFix,
  type IntakeCheckFilter,
  type IntakeFile,
} from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import { ModalShell } from "@/components/properties/ModalShell";
import { formatDate } from "@/services/properties";
import { AliasModal, CompanyAliasModal } from "@/pages/properties/PropertyAliasesPage";
import "./finance.css";

// Invoices page, "Inbox" tab: every email to accounts@ the n8n intake check
// looked at, what it decided, and where to open the invoice: the copy it saved
// to SharePoint, or the invoice link from Xero, QuickBooks and the like.

const pence = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const FILTERS: [IntakeCheckFilter, string][] = [["invoices", "All invoices"], ["pass", "Passed"], ["bounce", "Bounced"], ["fixed", "Fixed by alias"], ["review", "For review"], ["not_invoice", "Not invoices"]];
const VERDICT: Record<string, [string, string]> = {
  pass: ["Passed", "completed"],
  bounce: ["Bounced", "overdue"],
  fixed: ["Fixed by alias", "completed"],
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

export function IntakeChecksTab({ get, setParams, flash }: { get: (key: string) => string; setParams: (change: Record<string, string>) => void; flash: (message: string) => void }) {
  const verdict = (FILTERS.some(([key]) => key === get("verdict")) ? get("verdict") : "invoices") as IntakeCheckFilter;
  const term = get("q");
  const query = useListIntakeChecks({ verdict }, { query: { queryKey: getListIntakeChecksQueryKey({ verdict }), staleTime: 60_000 } });
  const counts = query.data?.counts;
  const [clearing, setClearing] = useState(false);
  const [addingAlias, setAddingAlias] = useState<IntakeAliasFix | null>(null);
  const queryClient = useQueryClient();
  const aliasAdded = (message: string) => {
    setAddingAlias(null);
    void queryClient.invalidateQueries({ queryKey: getListIntakeChecksQueryKey() });
    flash(message);
  };
  const items = useMemo(() => {
    const needle = term.trim().toLowerCase();
    const rows = query.data?.items ?? [];
    return needle ? rows.filter((row) => [row.senderEmail, row.subject, row.supplierName, row.invoiceNumber, row.billTo].some((value) => value?.toLowerCase().includes(needle))) : rows;
  }, [query.data, term]);
  const countFor = (key: IntakeCheckFilter) => (!counts ? null : key === "invoices" ? counts.pass + counts.bounce + counts.fixed + counts.review : key === "all" ? null : counts[key]);

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

      <div className="hh-intake-tools">
        <div className="hh-fin-filter">
          <Search size={14} />
          <input value={term} onChange={(event) => setParams({ q: event.target.value })} placeholder="Search sender, subject, supplier, invoice or bill-to" aria-label="Search" />
          {term && <button type="button" className="icon-btn" onClick={() => setParams({ q: "" })} aria-label="Clear search"><X size={13} /></button>}
        </div>
        {verdict === "not_invoice" && !!counts?.not_invoice && <button type="button" className="button" onClick={() => setClearing(true)} data-testid="button-clear-not-invoices"><Trash2 size={14} /> Clear all</button>}
      </div>

      <BackupCheck flash={flash} />

      {query.isLoading && <section className="panel hh-fin-note">Loading the inbox log…</section>}
      {query.isError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> The inbox log could not be loaded: {errorText(query.error)}</p>}

      {query.data && (
        <section className="panel table-panel">
          <div className="table-wrap">
            <table className="hh-fin-table">
              <thead><tr><th>Email</th><th>Invoice</th><th className="num">Total</th><th>Result</th><th>Open</th></tr></thead>
              <tbody>
                {items.map((row) => {
                  const result = VERDICT[row.fixedByAlias ? "fixed" : row.verdict] ?? [row.verdict, "na"];
                  return (
                    <tr key={row.id}>
                      <td className="hh-chk-summary">
                        <strong>{row.senderEmail ?? "Unknown sender"}</strong>
                        {row.subject && <small className="hh-fin-sub">{row.subject}</small>}
                        <small className="hh-fin-sub">Checked {when(row.processedAt)}{row.checkedBy === "pms" ? " by the PMS (backup)" : ""}</small>
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
                        <AliasFixes fixes={row.aliasFixes} onAdd={setAddingAlias} />
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

      {addingAlias?.kind === "company" && <CompanyAliasModal alias={null} initialText={addingAlias.text} onClose={() => setAddingAlias(null)} onDone={aliasAdded} />}
      {addingAlias?.kind === "spelling" && <AliasModal alias={null} initialText={addingAlias.text} onClose={() => setAddingAlias(null)} onDone={aliasAdded} />}
      {clearing && counts && <ClearNotInvoicesModal count={counts.not_invoice} onClose={() => setClearing(false)} onDone={(message) => { setClearing(false); flash(message); }} />}
    </>
  );
}

// Names on a bounced or for-review invoice that an alias would fix: who it is
// addressed to (Property aliases > Company names) and part-addresses on its
// lines (Property aliases > Spellings). Once added, the name shows as covered,
// and a bounce with nothing else wrong moves to "Fixed by alias".
const FIX_TAB: Record<IntakeAliasFix["kind"], string> = { company: "Company names", spelling: "Spellings" };

function AliasFixes({ fixes, onAdd }: { fixes: IntakeAliasFix[]; onAdd: (fix: IntakeAliasFix) => void }) {
  if (!fixes.length) return null;
  return (
    <span className="hh-intake-fixes">
      {fixes.map((fix) => fix.added ? (
        <small key={`${fix.kind}|${fix.text}`} className="hh-intake-fix done"><Check size={12} aria-hidden="true" /> "{fix.text}" is in {FIX_TAB[fix.kind]}{fix.means ? ` (${fix.means})` : ""}</small>
      ) : (
        <button key={`${fix.kind}|${fix.text}`} type="button" className="hh-intake-fix" onClick={() => onAdd(fix)} title={`Add "${fix.text}" to Property aliases > ${FIX_TAB[fix.kind]}`} data-testid="button-intake-add-alias">
          <Plus size={12} aria-hidden="true" /> Add "{fix.text}" to {FIX_TAB[fix.kind]}
        </button>
      ))}
    </span>
  );
}

// The app's backup for the n8n intake check: any email n8n hasn't dealt with
// 15 minutes after it arrived is checked by the PMS with the same rules.
const MODE: Record<string, string> = { shadow: "shadow mode: bounces go to the reviewer", draft: "draft mode: bounces are drafted in accounts@", live: "live: bounces go to suppliers" };

function BackupCheck({ flash }: { flash: (message: string) => void }) {
  const queryClient = useQueryClient();
  const status = useGetIntakeFallbackStatus({ query: { queryKey: getGetIntakeFallbackStatusQueryKey(), staleTime: 60_000 } });
  const run = useRunIntakeFallback({
    mutation: {
      onSuccess: (result) => {
        void queryClient.invalidateQueries({ queryKey: getGetIntakeFallbackStatusQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getListIntakeChecksQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getListIntakeReviewsQueryKey() });
        flash(result.status === "failed" ? `The backup check failed: ${result.error}` : result.status === "skipped" ? result.error ?? "A check is already running." : result.checked ? `${result.checked} ${result.checked === 1 ? "email" : "emails"} checked by the PMS.` : "Nothing waiting: n8n has dealt with every email.");
      },
      onError: (error) => flash(`The backup check could not run: ${errorText(error)}`),
    },
  });
  const data = status.data;
  if (!data) return null;
  const last = data.lastRun;
  const text = !data.configured
    ? data.mode === "off" ? "Backup check is switched off." : `Backup check isn't set up yet (needs ${data.missing.join(", ")} in Replit Secrets).`
    : [
      `If n8n misses an email for 15 minutes, the PMS checks it (${MODE[data.mode] ?? data.mode}).`,
      data.lastN8nCheckAt ? `n8n last checked an email ${when(data.lastN8nCheckAt)}.` : null,
      last && last.status !== "skipped" ? (last.status === "failed" ? `Last backup run ${when(last.checkedAt)} failed: ${last.error}` : `Last backup run ${when(last.checkedAt)}: ${last.checked} checked.`) : null,
      data.checkedByAppLastWeek ? `${data.checkedByAppLastWeek} checked by the PMS this week.` : null,
    ].filter(Boolean).join(" ");
  return (
    <div className="hh-intake-tools" data-testid="intake-backup">
      <small className="hh-fin-sub">{text}</small>
      {data.configured && (
        <button type="button" className="button" disabled={run.isPending || data.running} onClick={() => run.mutate()} data-testid="button-intake-backup-run">
          <RefreshCw size={14} /> {run.isPending || data.running ? "Checking…" : "Check now"}
        </button>
      )}
    </div>
  );
}

// Deletes every "not an invoice" email from the log. n8n skips emails it has
// tagged "n8n: not an invoice" in Outlook, so they don't come back.
function ClearNotInvoicesModal({ count, onClose, onDone }: { count: number; onClose: () => void; onDone: (message: string) => void }) {
  const queryClient = useQueryClient();
  const mutation = useClearNotInvoiceIntakeChecks({
    mutation: {
      onSuccess: ({ cleared }) => {
        void queryClient.invalidateQueries({ queryKey: getListIntakeChecksQueryKey() });
        onDone(`${cleared} ${cleared === 1 ? "email" : "emails"} cleared from Not invoices.`);
      },
    },
  });
  return (
    <ModalShell
      title="Clear Not invoices"
      caption={`${count} ${count === 1 ? "email" : "emails"}`}
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}
      testId="modal-clear-not-invoices"
      footer={<>
        <button type="button" className="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary" disabled={mutation.isPending}>{mutation.isPending ? "Clearing…" : "Clear all"}</button>
      </>}
    >
      <p className="hh-chk-summary">Every email in Not invoices is deleted from this list. The emails stay in accounts@ with their "n8n: not an invoice" tag, so the intake check won't pick them up again.</p>
      {mutation.isError && <p className="hh-field-error" role="alert">{errorText(mutation.error)}</p>}
      <p className="hh-fin-foot">Your name and each email's sender and subject are kept in the audit log.</p>
    </ModalShell>
  );
}
