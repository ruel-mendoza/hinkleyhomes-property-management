import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlarmClock, AlarmClockOff, Check, Pencil, Plus, UserRound, X } from "lucide-react";
import {
  getListCohoActionAssigneesQueryKey,
  getListCohoActionsQueryKey,
  getListCohoCalendarQueryKey,
  getListCohoPropertiesQueryKey,
  type CohoActionItem,
  type CohoActionStatusChangeStatus,
  useAssignCohoAction,
  useCreateCohoAction,
  useListCohoActionAssignees,
  useListCohoProperties,
  useSnoozeCohoAction,
  useUnsnoozeCohoAction,
  useUpdateCohoAction,
  useUpdateCohoActionStatus,
} from "@workspace/api-client-react";

const UK = "Europe/London";

// COHO due and snooze dates are UK days stored as UK midnight in UTC.
export function ukMidnightIso(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  const utcMidnight = Date.UTC(year, month - 1, date);
  const londonHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: UK, hour: "2-digit", hourCycle: "h23" }).format(new Date(utcMidnight)));
  return new Date(utcMidnight - londonHour * 3_600_000).toISOString();
}
const ukDayInput = (value: string | null | undefined) => (value ? new Intl.DateTimeFormat("en-CA", { timeZone: UK }).format(new Date(value)) : "");
const ukToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: UK }).format(new Date());
const addDays = (day: string, days: number) => {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
};
const ukDate = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleDateString("en-GB", { timeZone: UK, day: "2-digit", month: "short", year: "numeric" }) : "—";

export function errorText(error: unknown): string {
  const candidate = error as { data?: { error?: unknown }; message?: unknown } | null;
  if (typeof candidate?.data?.error === "string") return candidate.data.error;
  if (typeof candidate?.message === "string") return candidate.message;
  return "Something went wrong. Please try again.";
}

const STATUS_OPTIONS: { value: CohoActionStatusChangeStatus; label: string }[] = [
  { value: "new", label: "New" },
  { value: "in_progress", label: "In progress" },
  { value: "on_hold", label: "On hold" },
  { value: "completed", label: "Completed" },
];

function useRefreshActionViews() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: getListCohoActionsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getListCohoActionAssigneesQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getListCohoCalendarQueryKey() }),
    ]);
}

type DetailProps = { action: CohoActionItem; onClose: () => void };

export function ActionDetailModal({ action: initial, onClose }: DetailProps) {
  const [action, setAction] = useState(initial);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const refreshViews = useRefreshActionViews();
  const assigneesQuery = useListCohoActionAssignees();
  const [assignee, setAssignee] = useState(initial.assignedToGuid ?? "");
  const [snoozeDay, setSnoozeDay] = useState(addDays(ukToday(), 7));

  const statusMutation = useUpdateCohoActionStatus();
  const assignMutation = useAssignCohoAction();
  const snoozeMutation = useSnoozeCohoAction();
  const unsnoozeMutation = useUnsnoozeCohoAction();
  const editMutation = useUpdateCohoAction();
  const busy = statusMutation.isPending || assignMutation.isPending || snoozeMutation.isPending || unsnoozeMutation.isPending || editMutation.isPending;
  const locked = action.removedFromCoho || busy;

  const run = async (label: string, request: () => Promise<CohoActionItem>) => {
    setFeedback(null);
    try {
      const saved = await request();
      setAction(saved);
      setAssignee(saved.assignedToGuid ?? "");
      setFeedback({ kind: "ok", text: `${label} Saved in COHO and Supabase.` });
      await refreshViews();
      return true;
    } catch (error) {
      setFeedback({ kind: "error", text: errorText(error) });
      return false;
    }
  };
  const reference = action.reference;

  const people = assigneesQuery.data?.items ?? [];
  const assigneeKnown = !action.assignedToGuid || people.some((person) => person.guid === action.assignedToGuid);

  const saveEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    const due = text("dueDate");
    const ok = await run("Changes saved.", () =>
      editMutation.mutateAsync({
        reference,
        data: { title: text("title"), message: text("message") || null, notes: text("notes") || null, dueDate: due ? ukMidnightIso(due) : null },
      }),
    );
    if (ok) setEditing(false);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal hh-act-modal" role="dialog" aria-modal="true" aria-labelledby="action-detail-title" data-testid="modal-action-detail">
        <div className="modal-head">
          <div>
            <h2 id="action-detail-title">{action.title || action.typeName || "Untitled action"}</h2>
            <div className="panel-caption">{action.typeName}{action.isCustom ? " · custom action" : ""}</div>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><X size={17} /></button>
        </div>
        <div className="modal-body">
          {action.removedFromCoho && <p className="status overdue">This action is no longer in COHO, so it can't be changed.</p>}

          <dl className="hh-act-facts">
            <div><dt>Property</dt><dd>{action.propertyName || action.propertyReference || "—"}{action.roomName ? ` · ${action.roomName}` : ""}</dd></div>
            <div><dt>Due</dt><dd>{ukDate(action.dueDate)}{action.overdue && action.status !== "completed" ? " · overdue" : ""}</dd></div>
            <div><dt>Assigned</dt><dd>{action.assignedToName || "Unassigned"}</dd></div>
            <div><dt>Snoozed</dt><dd>{action.snoozed ? `Until ${ukDate(action.snoozedUntil)}` : "No"}</dd></div>
            {action.progressionStepsCount > 0 && <div><dt>Progress</dt><dd>Step {action.progressionStepsCompleted} of {action.progressionStepsCount}</dd></div>}
            {action.completedAt && <div><dt>Completed</dt><dd>{ukDate(action.completedAt)}</dd></div>}
            {action.tags.length > 0 && <div className="wide"><dt>Tags</dt><dd>{action.tags.join(", ")}</dd></div>}
            {action.message && <div className="wide"><dt>Message</dt><dd className="pre">{action.message}</dd></div>}
            {action.notes && <div className="wide"><dt>Notes</dt><dd className="pre">{action.notes}</dd></div>}
          </dl>

          <section className="hh-act-section" aria-label="Status">
            <h3>Status</h3>
            <div className="hh-act-segment" role="group" aria-label="Set status">
              {STATUS_OPTIONS.map(({ value, label }) => {
                const current = action.status === value;
                const blocked = value === "completed" && !action.canManuallyComplete && !current;
                return (
                  <button
                    key={value}
                    type="button"
                    className={`button ${current ? "primary" : ""}`}
                    aria-pressed={current}
                    disabled={locked || current || blocked}
                    title={blocked ? "COHO completes this action itself once the task is done" : undefined}
                    onClick={() => void run(`Status set to ${label}.`, () => statusMutation.mutateAsync({ reference, data: { status: value } }))}
                    data-testid={`button-action-status-${value}`}
                  >
                    {value === "completed" && <Check size={13} />} {label}
                  </button>
                );
              })}
            </div>
            {!action.canManuallyComplete && action.status !== "completed" && (
              <p className="hh-act-hint">COHO closes this one itself when the task behind it is done (for example, when the certificate is uploaded).</p>
            )}
          </section>

          <section className="hh-act-section" aria-label="Assign">
            <h3>Assigned to</h3>
            <div className="hh-act-inline">
              <select className="select-control" value={assignee} onChange={(event) => setAssignee(event.target.value)} disabled={locked} aria-label="Assign to">
                <option value="">Unassigned</option>
                {!assigneeKnown && action.assignedToGuid && <option value={action.assignedToGuid}>{action.assignedToName ?? "Current assignee"}</option>}
                {people.map((person) => <option key={person.guid} value={person.guid}>{person.name}</option>)}
              </select>
              <button
                type="button"
                className="button"
                disabled={locked || assignee === (action.assignedToGuid ?? "")}
                onClick={() => void run(assignee ? "Assigned." : "Unassigned.", () => assignMutation.mutateAsync({ reference, data: { assignTo: assignee || null } }))}
                data-testid="button-action-assign"
              >
                <UserRound size={13} /> {assignee ? "Assign" : "Unassign"}
              </button>
            </div>
            {people.length === 0 && !assigneesQuery.isLoading && <p className="hh-act-hint">Only people already assigned to a COHO action appear here.</p>}
          </section>

          <section className="hh-act-section" aria-label="Snooze">
            <h3>Snooze</h3>
            {action.snoozed ? (
              <div className="hh-act-inline">
                <span>Hidden from the open list until {ukDate(action.snoozedUntil)}.</span>
                <button type="button" className="button" disabled={locked} onClick={() => void run("Snooze removed.", () => unsnoozeMutation.mutateAsync({ reference }))} data-testid="button-action-unsnooze">
                  <AlarmClockOff size={13} /> Unsnooze
                </button>
              </div>
            ) : (
              <div className="hh-act-inline">
                <input type="date" className="select-control" value={snoozeDay} min={addDays(ukToday(), 1)} onChange={(event) => setSnoozeDay(event.target.value)} disabled={locked} aria-label="Snooze until" />
                <button
                  type="button"
                  className="button"
                  disabled={locked || !snoozeDay || snoozeDay <= ukToday()}
                  onClick={() => void run(`Snoozed until ${ukDate(ukMidnightIso(snoozeDay))}.`, () => snoozeMutation.mutateAsync({ reference, data: { until: ukMidnightIso(snoozeDay) } }))}
                  data-testid="button-action-snooze"
                >
                  <AlarmClock size={13} /> Snooze
                </button>
              </div>
            )}
          </section>

          {action.isCustom && (
            <section className="hh-act-section" aria-label="Edit">
              <h3>Details</h3>
              {editing ? (
                <form className="form-grid" onSubmit={saveEdit}>
                  <div className="field full"><label htmlFor="act-edit-title">Title</label><input id="act-edit-title" name="title" required maxLength={100} defaultValue={action.title ?? ""} /></div>
                  <div className="field full"><label htmlFor="act-edit-message">Message</label><textarea id="act-edit-message" name="message" rows={2} maxLength={400} defaultValue={action.message ?? ""} /></div>
                  <div className="field full"><label htmlFor="act-edit-notes">Notes</label><textarea id="act-edit-notes" name="notes" rows={3} maxLength={4000} defaultValue={action.notes ?? ""} /></div>
                  <div className="field"><label htmlFor="act-edit-due">Due date</label><input id="act-edit-due" name="dueDate" type="date" defaultValue={ukDayInput(action.dueDate)} /></div>
                  <div className="field full hh-act-inline end">
                    <button type="button" className="button" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
                    <button type="submit" className="button primary" disabled={locked}>{editMutation.isPending ? "Saving…" : "Save changes"}</button>
                  </div>
                </form>
              ) : (
                <button type="button" className="button" disabled={locked} onClick={() => setEditing(true)} data-testid="button-action-edit"><Pencil size={13} /> Edit title, message, notes or due date</button>
              )}
            </section>
          )}

          {feedback && <p className={`hh-act-feedback ${feedback.kind}`} role={feedback.kind === "error" ? "alert" : "status"}>{feedback.text}</p>}
          {busy && <p className="hh-act-feedback" role="status">Saving to COHO…</p>}
        </div>
      </div>
    </div>
  );
}

type CreateProps = { initialPropertyReference?: string; onClose: () => void; onCreated: (action: CohoActionItem) => void };

export function CreateActionModal({ initialPropertyReference, onClose, onCreated }: CreateProps) {
  const refreshViews = useRefreshActionViews();
  const createMutation = useCreateCohoAction();
  const assigneesQuery = useListCohoActionAssignees();
  const propertyParams = { page: 1, pageSize: 100 };
  const propertiesQuery = useListCohoProperties(propertyParams, { query: { queryKey: getListCohoPropertiesQueryKey(propertyParams) } });
  const properties = propertiesQuery.data?.items ?? [];
  const [propertyReference, setPropertyReference] = useState(initialPropertyReference ?? "");
  const property = properties.find((item) => item.reference === propertyReference);
  const [formError, setFormError] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError("");
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    const due = text("dueDate");
    try {
      const created = await createMutation.mutateAsync({
        data: {
          title: text("title"),
          message: text("message") || null,
          notes: text("notes") || null,
          dueDate: due ? ukMidnightIso(due) : null,
          propertyReference: propertyReference || null,
          roomReference: text("roomReference") || null,
          assignTo: text("assignTo") || null,
        },
      });
      await refreshViews();
      onCreated(created);
    } catch (error) {
      setFormError(errorText(error));
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="modal" onSubmit={submit} data-testid="form-create-action">
        <div className="modal-head">
          <div>
            <h2>New action</h2>
            <div className="panel-caption">Creates a custom action in COHO and saves it here.</div>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><X size={17} /></button>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <div className="field full"><label htmlFor="act-new-title">Title</label><input id="act-new-title" name="title" required maxLength={100} autoComplete="off" placeholder="e.g. Chase gas safety certificate" /></div>
            <div className="field full"><label htmlFor="act-new-message">Message (optional)</label><textarea id="act-new-message" name="message" rows={2} maxLength={400} /></div>
            <div className="field full">
              <label htmlFor="act-new-property">Property (optional)</label>
              <select id="act-new-property" value={propertyReference} onChange={(event) => setPropertyReference(event.target.value)}>
                <option value="">No property</option>
                {properties.map((item) => <option key={item.reference ?? item.name} value={item.reference ?? ""} disabled={!item.reference}>{item.name || item.reference || "Unnamed property"}</option>)}
              </select>
            </div>
            <div className="field full">
              <label htmlFor="act-new-room">Room (optional)</label>
              <select key={propertyReference} id="act-new-room" name="roomReference" defaultValue="" disabled={!propertyReference}>
                <option value="">Whole property</option>
                {(property?.rooms ?? []).map((room) => <option key={room.reference ?? room.name} value={room.reference ?? ""} disabled={!room.reference}>{room.name || room.reference || "Unnamed room"}</option>)}
              </select>
            </div>
            <div className="field"><label htmlFor="act-new-due">Due date (optional)</label><input id="act-new-due" name="dueDate" type="date" min={ukToday()} /></div>
            <div className="field">
              <label htmlFor="act-new-assign">Assign to (optional)</label>
              <select id="act-new-assign" name="assignTo" defaultValue="">
                <option value="">Unassigned</option>
                {(assigneesQuery.data?.items ?? []).map((person) => <option key={person.guid} value={person.guid}>{person.name}</option>)}
              </select>
            </div>
            <div className="field full"><label htmlFor="act-new-notes">Notes (optional)</label><textarea id="act-new-notes" name="notes" rows={3} maxLength={4000} /></div>
          </div>
          {formError && <p className="status overdue" role="alert">{formError}</p>}
          <div className="modal-actions">
            <button type="button" className="button" onClick={onClose}>Cancel</button>
            <button type="submit" className="button primary" disabled={createMutation.isPending}><Plus size={14} /> {createMutation.isPending ? "Creating…" : "Create action"}</button>
          </div>
        </div>
      </form>
    </div>
  );
}
