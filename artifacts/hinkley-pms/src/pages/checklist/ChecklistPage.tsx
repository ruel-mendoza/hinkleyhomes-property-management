import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, ExternalLink, ListChecks, Pencil, Plus, StickyNote, Trash2 } from "lucide-react";
import { getGetChecklistQueryKey, useGetChecklist, useTickChecklistStep, useUpdateChecklistSteps, type Checklist, type ChecklistItem } from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import "./checklist.css";

// Staff daily checklist, shared by the office. Anyone can tick today's steps;
// the list starts fresh each morning (UK time) and past days are read-only.
// Steps are edited here; every change and tick is in the audit log.

const longDay = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const shiftDay = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
const who = (email: string) => { const name = email.split("@")[0].split(/[._-]/)[0]; return name.charAt(0).toUpperCase() + name.slice(1); };

export const checklistQueryKey = (day?: string) => getGetChecklistQueryKey(day ? { day } : undefined);

function StepLink({ link }: { link: string | null }) {
  if (!link) return null;
  if (link.startsWith("/")) return <Link href={link} className="button">Open <ExternalLink size={13} /></Link>;
  return <a href={link} target="_blank" rel="noreferrer" className="button">Open <ExternalLink size={13} /></a>;
}

export default function ChecklistPage() {
  const queryClient = useQueryClient();
  const [day, setDay] = useState<string | undefined>(undefined);
  // The list being edited: its name, or "" for a new list.
  const [editing, setEditing] = useState<string | null>(null);
  const query = useGetChecklist(day ? { day } : undefined, { query: { queryKey: checklistQueryKey(day), refetchInterval: 60_000 } });
  const data = query.data;
  const isToday = !!data && data.day === data.today;
  const saved = (next: Checklist) => {
    queryClient.setQueryData(checklistQueryKey(), next);
    queryClient.setQueryData(checklistQueryKey(next.day), next);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Office routine</div>
          <h1 className="page-title">Daily checklist</h1>
          <p className="page-sub">Tick each step once it's done. The list is shared by the office and starts fresh every morning.</p>
        </div>
        <div className="head-actions">
          {data && editing === null && (
            <>
              <button type="button" className="button" onClick={() => setDay(shiftDay(data.day, -1))} aria-label="Previous day"><ChevronLeft size={14} /></button>
              <button type="button" className="button" disabled={isToday} onClick={() => setDay(shiftDay(data.day, 1) >= data.today ? undefined : shiftDay(data.day, 1))} aria-label="Next day"><ChevronRight size={14} /></button>
              {!isToday && <button type="button" className="button" onClick={() => setDay(undefined)}>Today</button>}
              {isToday && <button type="button" className="button" onClick={() => setEditing("")}><Plus size={14} /> <span>New list</span></button>}
            </>
          )}
        </div>
      </div>

      {query.isLoading && <section className="panel hh-ck-note">Loading the checklist…</section>}
      {query.isError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> The checklist could not be loaded: {errorText(query.error)}</p>}

      {data && (editing !== null
        ? <StepsEditor data={data} section={editing} onDone={(next) => { if (next) saved(next); setEditing(null); }} />
        : !data.sections.length
          ? <section className="panel"><div className="empty-state"><ListChecks size={21} /><h3>No lists yet</h3><p>Use New list to add the office's daily steps.</p></div></section>
          : data.sections.map((section) => <ChecklistPanel key={section} data={data} section={section} isToday={isToday} onSaved={saved} onEdit={() => setEditing(section)} />))}
    </>
  );
}

function ChecklistPanel({ data, section, isToday, onSaved, onEdit }: { data: Checklist; section: string; isToday: boolean; onSaved: (next: Checklist) => void; onEdit: () => void }) {
  const tick = useTickChecklistStep({ mutation: { onSuccess: onSaved } });
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const steps = data.steps.filter((step) => step.section === section);
  const done = steps.filter((step) => step.doneBy).length;
  const allDone = steps.length > 0 && done === steps.length;
  const save = (item: ChecklistItem, done: boolean, text: string | null = item.note) => tick.mutate({ data: { stepId: item.id, day: data.day, done, note: text } });

  return (
    <section className="panel hh-ck">
      <div className="panel-head">
        <div>
          <div className="panel-title">{section}</div>
          <div className="panel-caption">{isToday ? `Today, ${longDay(data.day)}` : longDay(data.day)} · {allDone ? "everything is done." : `${done} of ${steps.length} done.`}{!isToday && " Past days can't be changed."}</div>
        </div>
        <div className="hh-ck-actions">
          <span className={`status ${allDone ? "paid" : done ? "pending" : "na"}`}>{allDone ? "Done" : done ? "In progress" : "Not started"}</span>
          {isToday && <button type="button" className="button" onClick={onEdit}><Pencil size={13} /> <span>Edit</span></button>}
        </div>
      </div>
      {tick.isError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> {errorText(tick.error)}</p>}
      {!steps.length ? (
        <div className="empty-state"><ListChecks size={21} /><h3>No steps in this list</h3><p>Use Edit to add steps.</p></div>
      ) : (
        <ol className="hh-ck-list">
          {steps.map((item, index) => {
            const done = !!item.doneBy;
            return (
              <li key={item.id} className={done ? "done" : ""}>
                <button type="button" className="hh-ck-box" role="checkbox" aria-checked={done} aria-label={done ? `Untick ${item.title}` : `Tick ${item.title}`} disabled={!isToday || tick.isPending} onClick={() => save(item, !done, done ? null : item.note)}>
                  {done ? <Check size={15} /> : <span>{index + 1}</span>}
                </button>
                <div className="hh-ck-body">
                  <strong>{item.title}</strong>
                  {item.detail && <p>{item.detail}</p>}
                  {item.live && <span className={`hh-ck-live${item.liveWarn ? " warn" : ""}`}>{item.live}</span>}
                  {done && <small className="hh-ck-by">Done by {who(item.doneBy!)}{item.doneAt ? ` at ${time(item.doneAt)}` : ""}{item.note ? ` · ${item.note}` : ""}</small>}
                  {noteFor === item.id && (
                    <form className="hh-ck-note-form" onSubmit={(event) => { event.preventDefault(); save(item, true, note.trim() || null); setNoteFor(null); }}>
                      <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder="Short note, e.g. 2 same-day changeovers, cleaner booked" autoFocus />
                      <button type="submit" className="button primary">Save and tick</button>
                      <button type="button" className="button" onClick={() => setNoteFor(null)}>Cancel</button>
                    </form>
                  )}
                </div>
                <div className="hh-ck-actions">
                  {isToday && noteFor !== item.id && <button type="button" className="button" onClick={() => { setNoteFor(item.id); setNote(item.note ?? ""); }} title="Add a note"><StickyNote size={13} /> <span>Note</span></button>}
                  <StepLink link={item.link} />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

type Draft = { key: string; id: string | null; title: string; detail: string; link: string };

function StepsEditor({ data, section, onDone }: { data: Checklist; section: string; onDone: (next?: Checklist) => void }) {
  const update = useUpdateChecklistSteps({ mutation: { onSuccess: (next) => onDone(next) } });
  const isNew = !section;
  const [name, setName] = useState(section);
  const [steps, setSteps] = useState<Draft[]>(() => isNew
    ? [{ key: "new-0", id: null, title: "", detail: "", link: "" }]
    : data.steps.filter((step) => step.section === section).map((step) => ({ key: step.id, id: step.id, title: step.title, detail: step.detail ?? "", link: step.link ?? "" })));
  const change = (key: string, patch: Partial<Draft>) => setSteps((current) => current.map((step) => (step.key === key ? { ...step, ...patch } : step)));
  const move = (index: number, by: number) => setSteps((current) => { const next = [...current]; const [step] = next.splice(index, 1); next.splice(index + by, 0, step); return next; });
  const taken = isNew && data.sections.some((item) => item.toLowerCase() === name.trim().toLowerCase());
  const canSave = !!name.trim() && !taken && steps.length > 0 && steps.every((step) => step.title.trim());

  return (
    <section className="panel hh-ck">
      <div className="panel-head">
        <div>
          <div className="panel-title">{isNew ? "New list" : `Edit ${section}`}</div>
          <div className="panel-caption">Changes apply from today for everyone. A link can be a page in the app, like /stays, or a full https:// address.</div>
        </div>
      </div>
      {isNew && (
        <div className="hh-ck-name">
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="List name, e.g. Weekly checks" aria-label="List name" autoFocus />
          {taken && <small className="hh-fin-sub bad">There is already a list with that name.</small>}
        </div>
      )}
      {update.isError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> {errorText(update.error)}</p>}
      <ol className="hh-ck-edit">
        {steps.map((step, index) => (
          <li key={step.key}>
            <span className="hh-ck-num">{index + 1}</span>
            <div className="hh-ck-fields">
              <input value={step.title} onChange={(event) => change(step.key, { title: event.target.value })} maxLength={200} placeholder="Step" aria-label="Step" />
              <input value={step.detail} onChange={(event) => change(step.key, { detail: event.target.value })} maxLength={1000} placeholder="What it involves (optional)" aria-label="Details" />
              <input value={step.link} onChange={(event) => change(step.key, { link: event.target.value })} maxLength={500} placeholder="Link (optional), e.g. /stays" aria-label="Link" />
            </div>
            <div className="hh-ck-actions">
              <button type="button" className="icon-btn" disabled={index === 0} onClick={() => move(index, -1)} aria-label="Move up"><ArrowUp size={14} /></button>
              <button type="button" className="icon-btn" disabled={index === steps.length - 1} onClick={() => move(index, 1)} aria-label="Move down"><ArrowDown size={14} /></button>
              <button type="button" className="icon-btn" onClick={() => setSteps((current) => current.filter((item) => item.key !== step.key))} aria-label="Remove step"><Trash2 size={14} /></button>
            </div>
          </li>
        ))}
      </ol>
      <div className="hh-ck-edit-foot">
        <button type="button" className="button" onClick={() => setSteps((current) => [...current, { key: `new-${Date.now()}`, id: null, title: "", detail: "", link: "" }])}><Plus size={14} /> Add step</button>
        <span />
        <button type="button" className="button" onClick={() => onDone()}>Cancel</button>
        <button type="button" className="button primary" disabled={!canSave || update.isPending} onClick={() => update.mutate({ data: { section: name.trim(), steps: steps.map((step) => ({ id: step.id, title: step.title.trim(), detail: step.detail.trim() || null, link: step.link.trim() || null })) } })}>
          {update.isPending ? "Saving…" : "Save steps"}
        </button>
      </div>
    </section>
  );
}

// Overview entry: today's progress and the next step to do.
export function ChecklistStrip() {
  const query = useGetChecklist(undefined, { query: { queryKey: checklistQueryKey(), refetchInterval: 60_000 } });
  const data = query.data;
  const next = data?.steps.find((step) => !step.doneBy);
  return (
    <section className="panel hh-perf-strip" aria-label="Daily checklist">
      <div><div className="panel-title">Daily checklist</div><div className="panel-caption">Done today, shared by the office</div></div>
      <div className="hh-perf-strip-stats">
        {query.isLoading ? <div><span>Loading…</span></div>
          : !data ? <div><span>The checklist could not be loaded</span></div>
            : (
              <>
                {data.sections.map((section) => {
                  const steps = data.steps.filter((step) => step.section === section);
                  const done = steps.filter((step) => step.doneBy).length;
                  return <div key={section}><span>{section}</span><strong className={steps.length && done === steps.length ? "good" : done ? "warn" : ""}>{done} of {steps.length}</strong></div>;
                })}
                <div className="hh-ck-strip-next"><span>{next ? "Next step" : "All done"}</span><strong>{next ? next.title : "Nothing left today"}</strong></div>
              </>
            )}
      </div>
      <div className="hh-perf-strip-links"><Link href="/checklist" className="button">Open checklist</Link></div>
    </section>
  );
}
