import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BellOff, BellRing, Send, Settings2 } from "lucide-react";
import {
  getGetReceivablesQueryKey,
  getGetReminderSettingsQueryKey,
  useGetReminderSettings,
  useRunInvoiceAction,
  useUpdateReminderSettings,
  type ReceivableInvoice,
  type ReminderSettings,
  type ReminderStatus,
} from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import { ModalShell } from "@/components/properties/ModalShell";
import { formatDate } from "@/services/properties";

// Payment reminders (Phase 2): the app decides who is reminded and when; the n8n
// workflow "Xero overdue reminders" writes and sends the email (Outlook).

const pence = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

export function ReminderBanner({ status, onSettings }: { status: ReminderStatus | null | undefined; onSettings: () => void }) {
  if (!status) {
    return <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Payment reminders aren't set up yet: the reminder tables haven't been created in the database.</p>;
  }
  const on = status.autoEnabled;
  return (
    <section className={`hh-rem-banner ${on ? (status.mode === "live" ? "live" : "test") : "off"}`} aria-label="Payment reminders">
      {on ? <BellRing size={17} /> : <BellOff size={17} />}
      <div>
        <strong>Automatic reminders: {on ? "On" : "Off"}</strong>
        <span>
          {status.mode === "test"
            ? ` · Test mode: every reminder goes to ${status.internalEmail}, never to customers`
            : " · Live: reminders go to customers"}
          {!status.webhookConfigured && " · \"Send now\" needs the n8n reminders webhook (N8N_REMINDER_WEBHOOK_URL)"}
        </span>
      </div>
      <button type="button" className="button" onClick={onSettings} data-testid="button-reminder-settings"><Settings2 size={14} /> Reminder settings</button>
    </section>
  );
}

// Reminder status for one invoice: what has gone out (from us and from Xero) and what happens next.
export function ReminderCell({ invoice }: { invoice: ReceivableInvoice }) {
  const reminder = invoice.reminder;
  const xero = invoice.xeroActivity;
  if (!reminder && !xero) return <span className="secondary-text" style={{ margin: 0 }}>—</span>;
  return (
    <div className="hh-rem-cell">
      {reminder && reminder.lastStage > 0 && (
        <span className="hh-rem-last">
          Stage {reminder.lastStage}/{reminder.totalStages} · {reminder.lastSentAt ? formatDate(reminder.lastSentAt) : ""}
          {reminder.lastTestMode && <em className="hh-rem-test">test</em>}
        </span>
      )}
      {reminder && invoice.daysOverdue > 0 && <span className={`hh-rem-next ${reminder.eligible ? "due" : ""}`}>{reminder.eligible ? `Stage ${reminder.nextStage} due: goes out on the next run` : reminder.reason}</span>}
      {xero && (xero.sentOn || xero.reminderDates.length > 0) && (
        <span className="hh-rem-xero" title={xero.recent.map((entry) => `${entry.date}: ${entry.change}${entry.details ? ` · ${entry.details}` : ""}`).join("\n")}>
          Xero: {xero.sentOn ? `sent ${formatDate(xero.sentOn)}` : "not sent"}
          {xero.reminderDates.length > 0 && ` · ${xero.reminderDates.length} Xero ${xero.reminderDates.length === 1 ? "reminder" : "reminders"} (last ${formatDate(xero.reminderDates[0])})`}
        </span>
      )}
    </div>
  );
}

export function SendReminderModal({ invoice, status, onClose, onDone }: { invoice: ReceivableInvoice; status: ReminderStatus; onClose: () => void; onDone: (message: string) => void }) {
  const queryClient = useQueryClient();
  const reminder = invoice.reminder;
  const stage = reminder ? Math.min(reminder.lastStage + 1, reminder.totalStages) : 1;
  const repeatFinal = reminder ? reminder.lastStage >= reminder.totalStages : false;
  const live = status.mode === "live";
  const [choice, setChoice] = useState<"reminder" | "xero_resend">("reminder");
  const mutation = useRunInvoiceAction({
    mutation: {
      onSuccess: (result) => {
        void queryClient.invalidateQueries({ queryKey: getGetReceivablesQueryKey() });
        onDone(result.status === "sent" ? result.detail : `Not sent: ${result.detail}`);
      },
    },
  });
  const warnings = [
    reminder && !reminder.eligible && reminder.reason && !/^Stage \d+ (reminder )?due/.test(reminder.reason) ? reminder.reason : null,
    invoice.followUp?.remindersPaused ? "Automatic reminders are paused for this invoice." : null,
  ].filter(Boolean) as string[];
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    mutation.mutate({ tenantId: invoice.tenantId, invoiceId: invoice.invoiceId, data: { action: choice } });
  };
  return (
    <ModalShell
      title={`Chase ${invoice.number ?? "invoice"}`}
      caption={`${invoice.contactName} · ${pence.format(invoice.amountDue)} · ${invoice.daysOverdue} days overdue · ${invoice.company}`}
      onClose={onClose}
      onSubmit={submit}
      testId="modal-send-reminder"
      footer={<>
        <button type="button" className="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary" disabled={mutation.isPending || !status.webhookConfigured}>
          <Send size={13} /> {mutation.isPending ? "Sending…" : choice === "reminder" ? `Send stage ${stage} reminder` : "Re-send from Xero"}
        </button>
      </>}
    >
      <fieldset className="hh-rem-choices">
        <legend className="hh-label">What to send</legend>
        <label>
          <input type="radio" name="chase" checked={choice === "reminder"} onChange={() => setChoice("reminder")} />
          <span>
            <strong>Reminder email, stage {stage}{repeatFinal ? " (final notice again)" : ""}</strong>
            <small>Our wording, sent from Outlook {live ? "to the customer" : `to ${status.internalEmail} (test mode)`}. Stage {stage === (reminder?.totalStages ?? 4) ? `${stage} is the final notice` : `${stage} of ${reminder?.totalStages ?? 4}`}.</small>
          </span>
        </label>
        <label className={live ? "" : "disabled"}>
          <input type="radio" name="chase" disabled={!live} checked={choice === "xero_resend"} onChange={() => setChoice("xero_resend")} />
          <span>
            <strong>Re-send the invoice from Xero</strong>
            <small>{live ? "Xero emails the invoice again with its standard template." : "Live mode only: test mode never contacts Xero."}</small>
          </span>
        </label>
      </fieldset>
      {warnings.map((warning) => <p key={warning} className="hh-rem-warning"><AlertTriangle size={13} /> {warning}. Sending now overrides this.</p>)}
      {!status.webhookConfigured && <p className="hh-field-error">Sending needs the n8n reminders workflow: set N8N_REMINDER_WEBHOOK_URL.</p>}
      {mutation.isError && <p className="hh-field-error" role="alert">{errorText(mutation.error)}</p>}
      <p className="hh-fin-foot">Every send is logged against the invoice and in the audit log.</p>
    </ModalShell>
  );
}

const STAGE_HINT = "Days overdue for each reminder, separated by commas (e.g. 1, 7, 14, 30). The last one uses the final-notice wording.";

export function ReminderSettingsModal({ onClose, onSaved }: { onClose: () => void; onSaved: (message: string) => void }) {
  const queryClient = useQueryClient();
  const query = useGetReminderSettings({ query: { queryKey: getGetReminderSettingsQueryKey() } });
  const [form, setForm] = useState<ReminderSettings | null>(null);
  const [stages, setStages] = useState("");
  useEffect(() => {
    if (query.data && !form) {
      setForm(query.data);
      setStages(query.data.stageDays.join(", "));
    }
  }, [query.data, form]);
  const mutation = useUpdateReminderSettings({
    mutation: {
      onSuccess: (saved) => {
        void queryClient.invalidateQueries({ queryKey: getGetReceivablesQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetReminderSettingsQueryKey() });
        onSaved(`Reminder settings saved. Automatic reminders are ${saved.autoEnabled ? "on" : "off"} (${saved.mode === "test" ? "test mode" : "live"}).`);
      },
    },
  });
  const set = <K extends keyof ReminderSettings>(key: K, value: ReminderSettings[K]) => setForm((current) => (current ? { ...current, [key]: value } : current));
  const stageDays = stages.split(/[\s,]+/).map(Number).filter((value) => Number.isInteger(value) && value > 0);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!form) return;
    mutation.mutate({
      data: {
        autoEnabled: form.autoEnabled,
        mode: form.mode,
        internalEmail: form.internalEmail,
        stageDays,
        maxOverdueDays: form.maxOverdueDays,
        minDaysBetween: form.minDaysBetween,
        manualChaseCooldownDays: form.manualChaseCooldownDays,
        xeroReminderCooldownDays: form.xeroReminderCooldownDays,
        weekdaysOnly: form.weekdaysOnly,
        xeroHistoryNotes: form.xeroHistoryNotes,
        companies: form.companies.filter((company) => company.enabled).map((company) => company.tenantId),
      },
    });
  };
  const number = (key: "maxOverdueDays" | "minDaysBetween" | "manualChaseCooldownDays" | "xeroReminderCooldownDays", label: string, hint: string) => (
    <label className="field">
      {label}
      <input type="number" min={key === "manualChaseCooldownDays" || key === "xeroReminderCooldownDays" ? 0 : 1} max={3650} value={form?.[key] ?? 0} onChange={(event) => set(key, Number(event.target.value))} />
      <small className="hh-rem-hint">{hint}</small>
    </label>
  );
  return (
    <ModalShell
      title="Payment reminder settings"
      caption="Daily reminders for overdue customer invoices, sent by the n8n workflow at 8 am"
      onClose={onClose}
      onSubmit={submit}
      wide
      testId="modal-reminder-settings"
      footer={<>
        <button type="button" className="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary" disabled={!form || mutation.isPending || !stageDays.length}>{mutation.isPending ? "Saving…" : "Save settings"}</button>
      </>}
    >
      {query.isLoading && <p className="hh-fin-note">Loading settings…</p>}
      {query.isError && <p className="hh-field-error" role="alert">{errorText(query.error)}</p>}
      {form && (
        <>
          <div className={`hh-rem-switch ${form.autoEnabled ? "on" : ""}`}>
            <label className="hh-switch">
              <button type="button" role="switch" aria-checked={form.autoEnabled} onClick={() => set("autoEnabled", !form.autoEnabled)} data-testid="switch-auto-reminders"><span /></button>
              <strong>Automatic follow-up reminders {form.autoEnabled ? "on" : "off"}</strong>
            </label>
            <p>{form.autoEnabled ? "The workflow emails due reminders every morning." : "No automatic reminders are sent. Staff can still send one from an invoice."}</p>
          </div>

          <fieldset className="hh-rem-choices inline">
            <legend className="hh-label">Mode</legend>
            <label><input type="radio" name="mode" checked={form.mode === "test"} onChange={() => set("mode", "test")} /> <span><strong>Test</strong><small>Everything goes to the internal address below.</small></span></label>
            <label><input type="radio" name="mode" checked={form.mode === "live"} onChange={() => set("mode", "live")} /> <span><strong>Live</strong><small>Reminders go to customers; the final one copies the internal address.</small></span></label>
          </fieldset>

          <div className="form-grid">
            <label className="field full">
              Internal email (test mode, missing customer emails, final-notice copy)
              <input type="email" value={form.internalEmail} onChange={(event) => set("internalEmail", event.target.value)} />
            </label>
            <label className="field full">
              Reminder stages (days overdue)
              <input value={stages} onChange={(event) => setStages(event.target.value)} aria-describedby="stage-hint" />
              <small className="hh-rem-hint" id="stage-hint">{STAGE_HINT}</small>
            </label>
            {number("maxOverdueDays", "Don't start reminders after (days overdue)", "Older invoices are left for a phone call.")}
            {number("minDaysBetween", "Days between reminders", "Minimum gap between two reminders to the same invoice.")}
            {number("manualChaseCooldownDays", "Wait after a staff chase (days)", "Skip if someone logged a chase this recently.")}
            {number("xeroReminderCooldownDays", "Wait after a Xero reminder (days)", "Skip if Xero's own reminder went out this recently.")}
          </div>

          <div className="hh-rem-checks">
            <label><input type="checkbox" checked={form.weekdaysOnly} onChange={(event) => set("weekdaysOnly", event.target.checked)} /> Send Monday to Friday only</label>
            <label><input type="checkbox" checked={form.xeroHistoryNotes} onChange={(event) => set("xeroHistoryNotes", event.target.checked)} /> Note each live reminder in the invoice's History in Xero</label>
          </div>

          <fieldset className="hh-rem-companies">
            <legend className="hh-label">Companies whose customers get automatic reminders</legend>
            {form.companies.map((company, index) => (
              <label key={company.tenantId}>
                <input type="checkbox" checked={company.enabled} onChange={(event) => set("companies", form.companies.map((item, position) => (position === index ? { ...item, enabled: event.target.checked } : item)))} />
                <span>
                  {company.name}
                  <small>
                    {company.xeroRemindersOn === true ? "Xero's own reminders are ON: ours wait after each one" : company.xeroRemindersOn === false ? "Xero's own reminders are off" : "Xero reminder setting unknown"}
                    {!company.holdsPropertyMoney ? " · no property money" : ""}
                  </small>
                </span>
              </label>
            ))}
          </fieldset>
          {mutation.isError && <p className="hh-field-error" role="alert">{errorText(mutation.error)}</p>}
          {form.updatedBy && <p className="hh-fin-foot">Last changed by {form.updatedBy} on {new Date(form.updatedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.</p>}
        </>
      )}
    </ModalShell>
  );
}
