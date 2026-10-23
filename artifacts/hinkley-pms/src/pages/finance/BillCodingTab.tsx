import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, MessageSquareReply, Settings } from "lucide-react";
import {
  getGetBillCodingSettingsQueryKey,
  getGetTrackingOptionsQueryKey,
  getListBillReviewsQueryKey,
  useAnswerBillReview,
  useGetBillCodingSettings,
  useGetTrackingOptions,
  useListBillReviews,
  useUpdateBillCodingSettings,
  type BillCodingSettings,
  type BillReview,
  type BillReviewStatus,
  type BillReviewView,
  type TrackingOptions,
} from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import { ModalShell } from "@/components/properties/ModalShell";
import { formatDate } from "@/services/properties";
import { CompanyTag } from "./InvoicesPage";

// Bill coding: the supplier bills the hourly n8n workflow read from Xero, which
// property each line belongs to, and what was (or would be) written to Xero.
// Held bills are answered here; the answers are kept as property aliases and
// the next hourly run checks the bill again.

const pence = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const STATUS: Record<BillReviewStatus, [string, string]> = {
  held: ["Held: needs a decision", "overdue"],
  create_failed: ["Xero write failed", "failed"],
  read_failed: ["Couldn't be read", "pending"],
  shadow_planned: ["Planned (shadow mode)", "upcoming"],
  pending_xero: ["Writing to Xero", "pending"],
  created_draft: ["Draft bill created", "completed"],
  updated_draft: ["Property added in Xero", "completed"],
  not_invoice: ["Not an invoice", "na"],
};
const VIEWS: [BillReviewView, string][] = [["action", "Needs action"], ["planned", "Planned"], ["done", "Written to Xero"], ["ignored", "Not invoices"], ["all", "All"]];
const NEED_REASON: Record<string, string> = {
  no_property_text: "No property written on this line",
  no_match: "The property written doesn't match a Xero property",
  ambiguous: "Matches a property name used in more than one company",
  shared_line: "Mentions more than one property",
};
const OVERHEAD = "__overhead__";

export function BillCodingTab({ get, setParams, flash }: { get: (key: string) => string; setParams: (change: Record<string, string>) => void; flash: (message: string) => void }) {
  const view = (VIEWS.some(([key]) => key === get("view")) ? get("view") : "action") as BillReviewView;
  const query = useListBillReviews({ view }, { query: { queryKey: getListBillReviewsQueryKey({ view }), staleTime: 60_000 } });
  const [answering, setAnswering] = useState<BillReview | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const data = query.data;

  return (
    <>
      {data && (
        <section className={`panel hh-fin-note ${data.shadowMode ? "" : "hh-chk-live"}`}>
          <div className="hh-chk-banner">
            <span>
              {data.shadowMode
                ? <><strong>Shadow mode is on.</strong> Bills are read and checked every hour, but nothing is written to Xero.</>
                : <><strong>Live.</strong> Bills that are ready get their property added, or draft bills created, in Xero. Nothing is approved or paid.</>}
              {" "}Property spellings are kept on the <Link href="/property-aliases">Property aliases</Link> page.
            </span>
            <button type="button" className="button" onClick={() => setSettingsOpen(true)}><Settings size={14} /> Settings</button>
          </div>
        </section>
      )}

      <div className="hh-inv-companies" role="group" aria-label="Filter bills">
        {VIEWS.map(([key, label]) => (
          <button key={key} type="button" className={`hh-inv-company ${view === key ? "active" : ""} ${key === "action" && data?.counts.action ? "has" : ""}`} aria-pressed={view === key} onClick={() => setParams({ view: key === "action" ? "" : key })}>
            <span>{label}</span>
            {data && key !== "all" && <strong>{data.counts[key]}</strong>}
          </button>
        ))}
      </div>

      {query.isLoading && <section className="panel hh-fin-note">Loading bills…</section>}
      {query.isError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Bill coding could not be loaded: {errorText(query.error)}</p>}

      {data && (
        <section className="panel table-panel">
          <div className="table-wrap">
            <table className="hh-fin-table">
              <thead><tr><th>Bill</th><th className="num">Total</th><th>Status</th><th>What was found</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {data.items.map((review) => (
                  <tr key={review.id}>
                    <td>
                      <span className="hh-inv-head"><strong className="hh-nowrap">{review.invoiceNumber ?? "—"}</strong><CompanyTag tenantId={review.tenantId} name={review.company} /></span>
                      <span className="hh-inv-contact">{review.supplierName ?? "Unknown supplier"}</span>
                      <small className="hh-fin-sub">{review.invoiceDate ? formatDate(review.invoiceDate) : "No date"} · checked {when(review.createdAt)}</small>
                    </td>
                    <td className="num">{review.total === null ? "—" : pence.format(review.total)}</td>
                    <td>
                      <span className={`status ${STATUS[review.status][1]}`}>{STATUS[review.status][0]}</span>
                      {review.answeredAt && review.status === "held" && <small className="hh-fin-sub info">Answered {when(review.answeredAt)}{review.answeredBy ? ` by ${review.answeredBy}` : ""}: checked again on the next run</small>}
                    </td>
                    <td className="hh-chk-summary">
                      {review.reasons.map((reason, index) => (
                        <small key={index} className={`hh-fin-sub ${reason.severity === "hold" || reason.severity === "high" ? "bad" : reason.severity === "warn" ? "warn" : ""}`}>{reason.message}</small>
                      ))}
                      {review.allocation.length > 0 && <small className="hh-fin-sub">Lines belong to: {review.allocation.map((a) => `${a.tenantName} ${pence.format(a.amount)}${a.pays === "intercompany" ? " (intercompany)" : ""}`).join(", ")}</small>}
                      {review.plans.filter((plan) => plan.ok !== null).map((plan, index) => (
                        <small key={index} className={`hh-fin-sub ${plan.ok ? "" : "bad"}`}>{plan.tenantName}: {plan.ok ? (plan.sourceUpdate ? "property added to the bill" : "draft bill created") : `failed: ${plan.error ?? "unknown error"}`}</small>
                      ))}
                      {review.error && <small className="hh-fin-sub bad">{review.error}</small>}
                      {!review.reasons.length && !review.error && review.status === "not_invoice" && <small className="hh-fin-sub">The attached file is a {review.documentType ?? "document"}, not an invoice. It is looked at again if the bill is edited in Xero.</small>}
                    </td>
                    <td className="hh-inv-actions">
                      {review.status === "held" && review.needs.length > 0 && (
                        <button type="button" className="icon-btn" onClick={() => setAnswering(review)} title="Say which property each line belongs to" aria-label={`Answer ${review.invoiceNumber ?? "bill"}`}><MessageSquareReply size={15} /></button>
                      )}
                      <a className="icon-btn" href={review.xeroUrl} target="_blank" rel="noreferrer" title="Open the bill in Xero" aria-label="Open the bill in Xero"><ExternalLink size={15} /></a>
                    </td>
                  </tr>
                ))}
                {!data.items.length && <tr><td colSpan={5}><div className="empty-state"><h3>Nothing here</h3><p>{view === "action" ? "No bills are waiting for a decision." : "No bills in this list yet."}</p></div></td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <p className="hh-fin-foot">The n8n "Route A" workflow runs every hour: it reads draft and submitted supplier bills in Xero, reads each bill's file with the AI, and sends the reading here. Bills with other problems (totals that don't match, a bill in the wrong company) are fixed in Xero; they are checked again when they change.</p>

      {answering && <AnswerModal review={answering} onClose={() => setAnswering(null)} onDone={(message) => { setAnswering(null); flash(message); }} />}
      {settingsOpen && <CodingSettingsModal onClose={() => setSettingsOpen(false)} onSaved={(message) => { setSettingsOpen(false); flash(message); }} />}
    </>
  );
}

// Picker value: "<tenantId>|<option>" or "<tenantId>|__overhead__".
export function TargetSelect({ id, value, onChange, options, required }: { id?: string; value: string; onChange: (value: string) => void; options: TrackingOptions | undefined; required?: boolean }) {
  return (
    <select id={id} className="select-control" value={value} onChange={(event) => onChange(event.target.value)} required={required}>
      <option value="">Choose a property…</option>
      {options?.companies.map((company) => (
        <optgroup key={company.tenantId} label={company.name}>
          {company.options.map((option) => <option key={option} value={`${company.tenantId}|${option}`}>{option}</option>)}
          <option value={`${company.tenantId}|${OVERHEAD}`}>No property: {company.name} cost</option>
        </optgroup>
      ))}
    </select>
  );
}
export const splitTarget = (value: string) => {
  const [tenantId, ...rest] = value.split("|");
  const option = rest.join("|");
  return { tenantId, option: option === OVERHEAD ? null : option };
};

function AnswerModal({ review, onClose, onDone }: { review: BillReview; onClose: () => void; onDone: (message: string) => void }) {
  const queryClient = useQueryClient();
  const options = useGetTrackingOptions({ query: { queryKey: getGetTrackingOptionsQueryKey(), staleTime: 10 * 60_000 } });
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [remember, setRemember] = useState<Record<string, boolean>>(() => Object.fromEntries(review.needs.filter((need) => need.aliasKey).map((need) => [need.answerKey, true])));
  const mutation = useAnswerBillReview({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ["/api/bill-coding/reviews"] });
        onDone(`Answers saved for ${review.invoiceNumber ?? "the bill"}. The next hourly run checks it again.`);
      },
    },
  });
  const answered = review.needs.filter((need) => picked[need.answerKey]);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    mutation.mutate({
      id: review.id,
      data: { answers: answered.map((need) => ({ answerKey: need.answerKey, ...splitTarget(picked[need.answerKey]), remember: Boolean(need.aliasKey && remember[need.answerKey]) })) },
    });
  };
  return (
    <ModalShell
      title={`Which property? ${review.supplierName ?? ""} ${review.invoiceNumber ?? ""}`.trim()}
      caption={`${review.company} · ${review.total === null ? "" : pence.format(review.total)} · ${review.needs.length} line${review.needs.length === 1 ? "" : "s"} to answer`}
      onClose={onClose}
      onSubmit={submit}
      wide
      testId="modal-bill-answers"
      footer={<>
        <button type="button" className="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary" disabled={!answered.length || mutation.isPending}>{mutation.isPending ? "Saving…" : `Save ${answered.length} answer${answered.length === 1 ? "" : "s"}`}</button>
      </>}
    >
      {options.isError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Xero's property list could not be loaded: {errorText(options.error)}</p>}
      {options.data?.problems.map((problem) => <p key={problem} className="hh-props-alert" role="alert"><AlertTriangle size={14} /> {problem}</p>)}
      <div className="hh-chk-needs">
        {review.needs.map((need) => (
          <div key={need.answerKey} className="hh-chk-need">
            <div>
              <strong>{need.description || "(no description)"}</strong>
              <small className="hh-fin-sub">{need.amount === null ? "No amount" : pence.format(need.amount)}{need.serviceDate ? ` · ${formatDate(need.serviceDate)}` : ""} · {NEED_REASON[need.reason] ?? need.reason}{need.referenceText ? `: "${need.referenceText}"` : ""}</small>
              {need.suggestions.length > 0 && (
                <div className="hh-chk-suggest">
                  {need.suggestions.map((s) => (
                    <button key={`${s.tenantId}-${s.option}`} type="button" className="button" onClick={() => setPicked((current) => ({ ...current, [need.answerKey]: `${s.tenantId}|${s.option}` }))}>{s.option} <span className="hh-fin-sub">{s.tenantName}</span></button>
                  ))}
                </div>
              )}
            </div>
            <TargetSelect value={picked[need.answerKey] ?? ""} onChange={(value) => setPicked((current) => ({ ...current, [need.answerKey]: value }))} options={options.data} />
            {need.aliasKey && (
              <label className="hh-fin-check">
                <input type="checkbox" checked={remember[need.answerKey] ?? false} onChange={(event) => setRemember((current) => ({ ...current, [need.answerKey]: event.target.checked }))} />
                Also use this for future invoices that say "{need.referenceText}"
              </label>
            )}
          </div>
        ))}
      </div>
      {mutation.isError && <p className="hh-field-error" role="alert">{errorText(mutation.error)}</p>}
      <p className="hh-fin-foot">Saved as property aliases, with your name in the audit log. Lines you leave blank stay held.</p>
    </ModalShell>
  );
}

const STATUS_CHOICES = ["DRAFT", "SUBMITTED", "AUTHORISED"] as const;

function CodingSettingsModal({ onClose, onSaved }: { onClose: () => void; onSaved: (message: string) => void }) {
  const queryClient = useQueryClient();
  const query = useGetBillCodingSettings({ query: { queryKey: getGetBillCodingSettingsQueryKey() } });
  const [form, setForm] = useState<BillCodingSettings | null>(null);
  const [mapText, setMapText] = useState("");
  const [confirmLive, setConfirmLive] = useState(false);
  useEffect(() => {
    if (query.data && !form) {
      setForm(query.data);
      setMapText(Object.entries(query.data.categoryAccountMap).map(([category, code]) => `${category} = ${code}`).join("\n"));
    }
  }, [query.data, form]);
  const map = useMemo(() => Object.fromEntries(mapText.split("\n").map((line) => line.split("=").map((part) => part.trim())).filter((parts) => parts.length === 2 && parts[0] && parts[1])), [mapText]);
  const mutation = useUpdateBillCodingSettings({
    mutation: {
      onSuccess: (saved) => {
        void queryClient.invalidateQueries({ queryKey: getGetBillCodingSettingsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: ["/api/bill-coding/reviews"] });
        onSaved(`Bill coding settings saved. ${saved.shadowMode ? "Shadow mode is on: nothing is written to Xero." : "Live: ready bills are written to Xero as drafts."}`);
      },
    },
  });
  const set = <K extends keyof BillCodingSettings>(key: K, value: BillCodingSettings[K]) => setForm((current) => (current ? { ...current, [key]: value } : current));
  const goingLive = Boolean(query.data?.shadowMode && form && !form.shadowMode);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!form) return;
    mutation.mutate({
      data: {
        shadowMode: form.shadowMode,
        autoSplit: form.autoSplit,
        maxBillsPerRun: form.maxBillsPerRun,
        checkStatuses: form.checkStatuses as ("DRAFT" | "SUBMITTED" | "AUTHORISED")[],
        trackingCategory: form.trackingCategory,
        payingCompanyName: form.payingCompanyName,
        defaultAccountCode: form.defaultAccountCode,
        categoryAccountMap: map,
        legibilityMin: form.legibilityMin,
        dateOutlierDays: form.dateOutlierDays,
        dupLineMinAmount: form.dupLineMinAmount,
        reprocessHeld: form.reprocessHeld,
      },
    });
  };
  return (
    <ModalShell
      title="Bill coding settings"
      caption="Used by the hourly n8n workflow that reads supplier bills"
      onClose={onClose}
      onSubmit={submit}
      wide
      testId="modal-bill-coding-settings"
      footer={<>
        <button type="button" className="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary" disabled={!form || mutation.isPending || !form.checkStatuses.length || (goingLive && !confirmLive)}>{mutation.isPending ? "Saving…" : "Save settings"}</button>
      </>}
    >
      {!form ? <p className="hh-fin-foot">{query.isError ? `Settings could not be loaded: ${errorText(query.error)}` : "Loading…"}</p> : (
        <>
          <div className="hh-rem-checks">
            <label><input type="checkbox" checked={form.shadowMode} onChange={(event) => set("shadowMode", event.target.checked)} /> Shadow mode: read and plan only, write nothing to Xero</label>
            {goingLive && (
              <label className="hh-fin-sub warn"><input type="checkbox" checked={confirmLive} onChange={(event) => setConfirmLive(event.target.checked)} /> I understand ready bills will have their property added in Xero, and draft bills may be created in other companies</label>
            )}
            <label><input type="checkbox" checked={form.autoSplit} onChange={(event) => set("autoSplit", event.target.checked)} /> Split a bill whose lines belong to several companies into draft bills in each company</label>
            <label><input type="checkbox" checked={form.reprocessHeld} onChange={(event) => set("reprocessHeld", event.target.checked)} /> Check held bills again every hour (normally only after an answer or an edit in Xero)</label>
          </div>
          <div className="form-grid">
            <fieldset className="field full">
              <legend>Bill statuses to check</legend>
              <div className="hh-chk-suggest">
                {STATUS_CHOICES.map((status) => (
                  <label key={status} className="hh-fin-check">
                    <input type="checkbox" checked={form.checkStatuses.includes(status)} onChange={(event) => set("checkStatuses", event.target.checked ? [...form.checkStatuses, status] : form.checkStatuses.filter((s) => s !== status))} /> {status === "SUBMITTED" ? "Awaiting approval" : status === "DRAFT" ? "Draft" : "Approved"}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="field">Bills per run<input type="number" min={1} max={50} value={form.maxBillsPerRun} onChange={(event) => set("maxBillsPerRun", Number(event.target.value))} /></label>
            <label className="field">Property tracking category in Xero<input value={form.trackingCategory} maxLength={100} onChange={(event) => set("trackingCategory", event.target.value)} /></label>
            <label className="field">Company that pays<input value={form.payingCompanyName} maxLength={200} onChange={(event) => set("payingCompanyName", event.target.value)} /></label>
            <label className="field">Default account code<input value={form.defaultAccountCode} maxLength={20} onChange={(event) => set("defaultAccountCode", event.target.value)} /></label>
            <label className="field">Lowest readability accepted (0 to 1)<input type="number" min={0} max={1} step={0.05} value={form.legibilityMin} onChange={(event) => set("legibilityMin", Number(event.target.value))} /></label>
            <label className="field">Flag line dates more than (days) from the rest<input type="number" min={1} max={365} value={form.dateOutlierDays} onChange={(event) => set("dateOutlierDays", Number(event.target.value))} /></label>
            <label className="field">Flag repeated lines of at least (£)<input type="number" min={0} max={100000} value={form.dupLineMinAmount} onChange={(event) => set("dupLineMinAmount", Number(event.target.value))} /></label>
            <label className="field full">
              Account code per category (one per line, e.g. Cleaning = 420)
              <textarea rows={4} value={mapText} onChange={(event) => setMapText(event.target.value)} placeholder={"Cleaning = 420\nMaintenance and repairs = 430"} />
            </label>
          </div>
          {mutation.isError && <p className="hh-field-error" role="alert">{errorText(mutation.error)}</p>}
          <p className="hh-fin-foot">{form.updatedBy ? `Last changed by ${form.updatedBy}, ${when(form.updatedAt)}. ` : ""}Changes are written to the audit log. The AI model is set in the n8n workflow's Config step.</p>
        </>
      )}
    </ModalShell>
  );
}
