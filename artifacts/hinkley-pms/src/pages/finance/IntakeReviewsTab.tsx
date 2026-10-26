import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ExternalLink, RotateCcw, XCircle } from "lucide-react";
import {
  getListIntakeReviewsQueryKey,
  useListIntakeReviews,
  useUpdateIntakeReview,
  type IntakeReview,
  type IntakeReviewFilter,
  type IntakeReviewStatus,
} from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import { ModalShell } from "@/components/properties/ModalShell";
import { formatDate } from "@/services/properties";
import { InvoiceFileLinks } from "./IntakeChecksTab";
import "./finance.css";

// Invoices page, "For review" tab: emails to accounts@ that the n8n intake check
// could not pass or bounce on its own. A person opens the email, deals with it,
// and marks it done here. Nothing is sent to the supplier from this tab.

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const money = (amount: number, currency: string | null) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : "GBP" }).format(amount);

const FILTERS: [IntakeReviewFilter, string][] = [["open", "Open"], ["done", "Done"], ["dismissed", "Dismissed"], ["all", "All"]];
const STATUS: Record<IntakeReviewStatus, [string, string]> = { open: ["Open", "pending"], done: ["Done", "completed"], dismissed: ["Dismissed", "na"] };
export const intakeReviewsQueryOptions = (status: IntakeReviewFilter) => ({ query: { queryKey: getListIntakeReviewsQueryKey({ status }), staleTime: 60_000 } });

export function IntakeReviewsTab({ get, setParams, flash }: { get: (key: string) => string; setParams: (change: Record<string, string>) => void; flash: (message: string) => void }) {
  const status = (FILTERS.some(([key]) => key === get("status")) ? get("status") : "open") as IntakeReviewFilter;
  const query = useListIntakeReviews({ status }, intakeReviewsQueryOptions(status));
  const [acting, setActing] = useState<{ review: IntakeReview; status: IntakeReviewStatus } | null>(null);
  const items = query.data?.items ?? [];

  return (
    <>
      <div className="hh-inv-companies" role="group" aria-label="Filter by status">
        {FILTERS.map(([key, label]) => (
          <button key={key} type="button" className={`hh-inv-company ${status === key ? "active" : ""}`} aria-pressed={status === key} onClick={() => setParams({ status: key === "open" ? "" : key })}>
            <span>{label}</span>
            {key === "open" && query.data && <><strong>{query.data.openCount}</strong><small>waiting</small></>}
          </button>
        ))}
      </div>

      {query.isLoading && <section className="panel hh-fin-note">Loading invoices for review…</section>}
      {query.isError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Invoices for review could not be loaded: {errorText(query.error)}</p>}

      {query.data && (
        <section className="panel table-panel">
          <div className="table-wrap">
            <table className="hh-fin-table">
              <thead><tr><th>Email</th><th>Invoice</th><th>Why it needs a person</th><th>Status</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {items.map((review) => (
                  <tr key={review.id}>
                    <td>
                      <strong>{review.senderName || review.senderEmail || "Unknown sender"}</strong>
                      {review.senderName && review.senderEmail && <small className="hh-fin-sub">{review.senderEmail}</small>}
                      {review.subject && <small className="hh-fin-sub">{review.subject}</small>}
                      <small className="hh-fin-sub">Received {when(review.receivedAt ?? review.createdAt)}</small>
                    </td>
                    <td>
                      <strong>{review.supplierName || "—"}</strong>
                      <small className="hh-fin-sub">{[review.invoiceNumber, review.invoiceDate ? formatDate(review.invoiceDate) : null].filter(Boolean).join(" · ") || "No number or date read"}</small>
                      {review.total !== null && <small className="hh-fin-sub">{money(review.total, review.currency)}</small>}
                      {review.billTo && <small className="hh-fin-sub">To: {review.billTo}{review.billToCompany && review.billToCompany !== review.billTo ? ` (${review.billToCompany})` : ""}</small>}
                      <InvoiceFileLinks files={review.files} />
                    </td>
                    <td className="hh-chk-summary">
                      {review.reasons.map((reason, index) => <small key={`r${index}`} className="hh-fin-sub warn">{reason.message}</small>)}
                      {review.issues.map((issue, index) => (
                        <small key={`i${index}`} className="hh-fin-sub">
                          {issue.message}
                          {issue.lines.length > 0 && ` ${issue.lines.slice(0, 3).map((line) => line.text).join("; ")}${issue.lines.length > 3 ? ` and ${issue.lines.length - 3} more` : ""}`}
                        </small>
                      ))}
                      {!review.reasons.length && !review.issues.length && <small className="hh-fin-sub">No reason given.</small>}
                    </td>
                    <td>
                      <span className={`status ${STATUS[review.status][1]}`}>{STATUS[review.status][0]}</span>
                      {review.resolvedBy && <small className="hh-fin-sub">{review.resolvedBy}{review.resolvedAt ? ` · ${when(review.resolvedAt)}` : ""}</small>}
                      {review.resolution && <small className="hh-fin-sub">{review.resolution}</small>}
                    </td>
                    <td className="hh-inv-actions">
                      {review.webLink && <a className="icon-btn" href={review.webLink} target="_blank" rel="noreferrer" title="Open the email in Outlook" aria-label="Open the email in Outlook"><ExternalLink size={15} /></a>}
                      {review.status === "open" ? (
                        <>
                          <button type="button" className="icon-btn" onClick={() => setActing({ review, status: "done" })} title="Done: checked and dealt with" aria-label="Mark done"><CheckCircle2 size={15} /></button>
                          <button type="button" className="icon-btn" onClick={() => setActing({ review, status: "dismissed" })} title="Dismiss: not an invoice to deal with" aria-label="Dismiss"><XCircle size={15} /></button>
                        </>
                      ) : (
                        <button type="button" className="icon-btn" onClick={() => setActing({ review, status: "open" })} title="Reopen" aria-label="Reopen"><RotateCcw size={15} /></button>
                      )}
                    </td>
                  </tr>
                ))}
                {!items.length && <tr><td colSpan={5}><div className="empty-state"><h3>Nothing to review</h3><p>{status === "open" ? "The intake check hasn't sent any invoices for review." : "No reviews with this status."}</p></div></td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <p className="hh-fin-foot">
        Sent here by the accounts inbox intake check when it can't be sure it read an invoice right, or when asking the supplier to reissue it would be unsafe. The supplier hasn't been contacted.
      </p>

      {acting && <ReviewModal review={acting.review} status={acting.status} onClose={() => setActing(null)} onDone={(message) => { setActing(null); flash(message); }} />}
    </>
  );
}

function ReviewModal({ review, status, onClose, onDone }: { review: IntakeReview; status: IntakeReviewStatus; onClose: () => void; onDone: (message: string) => void }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const mutation = useUpdateIntakeReview({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ["/api/invoices/intake-reviews"] });
        onDone(status === "open" ? "Review reopened." : status === "done" ? "Marked done." : "Review dismissed.");
      },
    },
  });
  const verb = status === "open" ? "Reopen" : status === "done" ? "Mark done" : "Dismiss";
  return (
    <ModalShell
      title={verb}
      caption={[review.supplierName || review.senderName || review.senderEmail, review.invoiceNumber].filter(Boolean).join(" · ")}
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); mutation.mutate({ id: review.id, data: { status, note: note.trim() || null } }); }}
      testId="modal-intake-review"
      footer={<>
        <button type="button" className="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary" disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : verb}</button>
      </>}
    >
      {review.subject && <p className="hh-chk-summary">{review.subject}</p>}
      {status !== "open" && (
        <label className="field full">
          Note
          <textarea rows={3} maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} placeholder={status === "done" ? "What you did, e.g. entered in Xero, asked the supplier for a new copy" : "Why it isn't needed"} />
        </label>
      )}
      {mutation.isError && <p className="hh-field-error" role="alert">{errorText(mutation.error)}</p>}
      <p className="hh-fin-foot">Recorded with your name in the audit log.</p>
    </ModalShell>
  );
}
