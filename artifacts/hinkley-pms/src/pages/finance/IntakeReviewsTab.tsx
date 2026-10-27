import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ExternalLink, XCircle } from "lucide-react";
import {
  getListIntakeReviewsQueryKey,
  useListIntakeReviews,
  useResolveIntakeReview,
  type IntakeReview,
  type IntakeReviewOutcome,
} from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import { ModalShell } from "@/components/properties/ModalShell";
import { formatDate } from "@/services/properties";
import { InvoiceFileLinks } from "./IntakeChecksTab";
import "./finance.css";

// Invoices page, "For review" tab: emails to accounts@ that the n8n intake check
// could not pass or bounce on its own. A person opens the email, deals with it,
// and marks it done here, which removes it (the audit log keeps a summary).
// Reviews whose invoice is already in Xero are removed by the server. Nothing
// is sent to the supplier from this tab.

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const money = (amount: number, currency: string | null) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : "GBP" }).format(amount);

export const intakeReviewsQueryOptions = () => ({ query: { queryKey: getListIntakeReviewsQueryKey(), staleTime: 60_000 } });

export function IntakeReviewsTab({ flash }: { flash: (message: string) => void }) {
  const query = useListIntakeReviews(intakeReviewsQueryOptions());
  const [acting, setActing] = useState<{ review: IntakeReview; outcome: IntakeReviewOutcome } | null>(null);
  const items = query.data?.items ?? [];

  return (
    <>
      {query.isLoading && <section className="panel hh-fin-note">Loading invoices for review…</section>}
      {query.isError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Invoices for review could not be loaded: {errorText(query.error)}</p>}

      {query.data && (
        <section className="panel table-panel">
          <div className="table-wrap">
            <table className="hh-fin-table">
              <thead><tr><th>Email</th><th>Invoice</th><th>Why it needs a person</th><th aria-label="Actions" /></tr></thead>
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
                    <td className="hh-inv-actions">
                      {review.webLink && <a className="icon-btn" href={review.webLink} target="_blank" rel="noreferrer" title="Open the email in Outlook" aria-label="Open the email in Outlook"><ExternalLink size={15} /></a>}
                      <button type="button" className="icon-btn" onClick={() => setActing({ review, outcome: "done" })} title="Done: checked and dealt with" aria-label="Mark done"><CheckCircle2 size={15} /></button>
                      <button type="button" className="icon-btn" onClick={() => setActing({ review, outcome: "dismissed" })} title="Dismiss: not an invoice to deal with" aria-label="Dismiss"><XCircle size={15} /></button>
                    </td>
                  </tr>
                ))}
                {!items.length && <tr><td colSpan={4}><div className="empty-state"><h3>Nothing to review</h3><p>The intake check hasn't sent any invoices that need a person.</p></div></td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <p className="hh-fin-foot">
        Sent here by the accounts inbox intake check when it can't be sure it read an invoice right, or when asking the supplier to reissue it would be unsafe. The supplier hasn't been contacted. Once marked done or dismissed, or once the invoice is in Xero (same invoice number with the same supplier or total), it is removed from this list.
      </p>

      {acting && <ReviewModal review={acting.review} outcome={acting.outcome} onClose={() => setActing(null)} onDone={(message) => { setActing(null); flash(message); }} />}
    </>
  );
}

function ReviewModal({ review, outcome, onClose, onDone }: { review: IntakeReview; outcome: IntakeReviewOutcome; onClose: () => void; onDone: (message: string) => void }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const mutation = useResolveIntakeReview({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListIntakeReviewsQueryKey() });
        onDone(outcome === "done" ? "Marked done and removed from the list." : "Dismissed and removed from the list.");
      },
    },
  });
  const verb = outcome === "done" ? "Mark done" : "Dismiss";
  return (
    <ModalShell
      title={verb}
      caption={[review.supplierName || review.senderName || review.senderEmail, review.invoiceNumber].filter(Boolean).join(" · ")}
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); mutation.mutate({ id: review.id, data: { outcome, note: note.trim() || null } }); }}
      testId="modal-intake-review"
      footer={<>
        <button type="button" className="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary" disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : verb}</button>
      </>}
    >
      {review.subject && <p className="hh-chk-summary">{review.subject}</p>}
      <label className="field full">
        Note
        <textarea rows={3} maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} placeholder={outcome === "done" ? "What you did, e.g. entered in Xero, asked the supplier for a new copy" : "Why it isn't needed"} />
      </label>
      {mutation.isError && <p className="hh-field-error" role="alert">{errorText(mutation.error)}</p>}
      <p className="hh-fin-foot">The review is removed from the list. Your name, the outcome and the note are kept in the audit log.</p>
    </ModalShell>
  );
}
