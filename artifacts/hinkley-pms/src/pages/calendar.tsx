import { useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  CalendarPlus,
  Check,
  ChevronDown,
  Clock3,
  List,
  RefreshCw,
  Search,
  Table2,
  Wrench,
} from "lucide-react";
import { Link } from "wouter";
import {
  getGetCohoStatusQueryKey,
  getListCohoCalendarQueryKey,
  getListCohoPropertiesQueryKey,
  type CohoCalendarEntry,
  useGetCohoStatus,
  useListCohoCalendar,
  useListCohoProperties,
} from "@workspace/api-client-react";
import { BookViewingModal } from "@/components/book-viewing-modal";
import "./calendar.css";

type CalendarProps = {
  selectedPropertyReference?: string;
};
type Mode = "calendar" | "log" | "agenda";
type CalendarEvent = {
  id: string;
  title: string;
  date: string;
  endDate: string;
  person: string;
  property: string;
  propertyReference: string;
  room: string;
  roomReference: string;
  type: string;
  allDay: boolean;
  startsAt: Date;
};

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
const dateKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const parseLocal = (value: string) => {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Date(year, month - 1, day);
};
const monthStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1);
const formatDay = (date: Date) => date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const formatShort = (value: string) => parseLocal(value).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const formatTime = (date: Date) => date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const eventType = (entry: CohoCalendarEntry) => entry.entryType || entry.source;
const typeClass = (type: string) => type.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const errorText = (error: unknown) => error instanceof Error ? error.message : "Please try again in a moment.";
// Opens the maintenance page with its "New issue" form prefilled.
const reportMaintenanceHref = (propertyReference?: string, roomReference?: string) => {
  const params = new URLSearchParams({ report: "1" });
  if (propertyReference) params.set("property", propertyReference);
  if (roomReference) params.set("room", roomReference);
  return `/maintenance?${params}`;
};

export default function CalendarPage({ selectedPropertyReference }: CalendarProps) {
  const [month, setMonth] = useState(() => monthStart(new Date()));
  const [selectedDay, setSelectedDay] = useState(() => dateKey(new Date()));
  const [mode, setMode] = useState<Mode>("calendar");
  const [kind, setKind] = useState("all");
  const [search, setSearch] = useState("");
  const [viewingOpen, setViewingOpen] = useState(false);
  const [notice, setNotice] = useState("");

  const statusQuery = useGetCohoStatus({
    query: { queryKey: getGetCohoStatusQueryKey(), refetchInterval: 15_000 },
  });
  const fromDate = new Date(Date.UTC(month.getFullYear(), month.getMonth(), 1)).toISOString();
  const calendarParams = useMemo(() => ({ fromDate }), [fromDate]);
  const configured = statusQuery.data?.configured === true;
  const calendarQuery = useListCohoCalendar(calendarParams, {
    query: {
      queryKey: getListCohoCalendarQueryKey(calendarParams),
      enabled: configured,
    },
  });
  // Same query as the app shell's property selector, so it comes from cache.
  const propertiesQuery = useListCohoProperties({ page: 1, pageSize: 100 }, {
    query: { queryKey: getListCohoPropertiesQueryKey({ page: 1, pageSize: 100 }), enabled: configured },
  });
  const properties = propertiesQuery.data?.items ?? [];

  const events = useMemo<CalendarEvent[]>(() => {
    const entries = calendarQuery.data?.items ?? [];
    return entries
      .filter((entry) => !selectedPropertyReference || entry.propertyReference === selectedPropertyReference)
      .map((entry) => {
        const startsAt = new Date(entry.entryDate);
        return {
          id: entry.id,
          title: entry.title || eventType(entry),
          date: dateKey(startsAt),
          endDate: entry.endDate ? dateKey(new Date(entry.endDate)) : dateKey(startsAt),
          person: entry.personName || "",
          property: entry.propertyName || entry.propertyReference || "",
          propertyReference: entry.propertyReference || "",
          room: entry.roomName || entry.roomReference || "",
          roomReference: entry.roomReference || "",
          type: eventType(entry),
          allDay: entry.isAllDay,
          startsAt,
        };
      });
  }, [calendarQuery.data, selectedPropertyReference]);

  const visibleEvents = useMemo(() => events.filter((event) => {
    const matchesKind = kind === "all" || event.type === kind;
    const matchesSearch = !search || `${event.title} ${event.person} ${event.property} ${event.room} ${event.type}`.toLowerCase().includes(search.toLowerCase());
    return matchesKind && matchesSearch;
  }), [events, kind, search]);
  const monthDays = useMemo(() => {
    const start = monthStart(month);
    const firstMondayOffset = (start.getDay() + 6) % 7;
    const gridStart = new Date(start.getTime() - firstMondayOffset * DAY_MS);
    return Array.from({ length: 42 }, (_, index) => new Date(gridStart.getTime() + index * DAY_MS));
  }, [month]);
  const monthKey = dateKey(month).slice(0, 7);
  const coversDay = (event: CalendarEvent, key: string) => event.date <= key && event.endDate >= key;
  const selectedEvents = visibleEvents.filter((event) => coversDay(event, selectedDay));
  const monthEvents = visibleEvents.filter((event) => event.date.slice(0, 7) === monthKey);
  const monthLabel = month.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const cohoTypes = [...new Set(events.map((event) => event.type))].sort();

  const moveMonth = (delta: number) => {
    const next = new Date(month.getFullYear(), month.getMonth() + delta, 1);
    setMonth(next);
    setSelectedDay(dateKey(next));
  };
  const goToToday = () => {
    const now = new Date();
    setMonth(monthStart(now));
    setSelectedDay(dateKey(now));
  };
  const sourceState = statusQuery.isLoading
    ? "loading"
    : statusQuery.isError
      ? "error"
      : !configured
        ? "unconfigured"
        : calendarQuery.isLoading
          ? "loading"
          : calendarQuery.isError
            ? "error"
            : monthEvents.length === 0
              ? "empty"
              : "ready";

  return (
    <div className="hh-calendar" data-testid="page-calendar">
      <header className="hh-cal-head">
        <div>
          <div className="hh-cal-kicker"><span className="hh-cal-kicker-dot" /> COHO / PROPERTY ACTIVITY</div>
          <h1>Property calendar</h1>
          <p>Tenancies, viewings, maintenance and actions from COHO in one view.</p>
        </div>
        <div className="hh-cal-head-actions">
          <span className="hh-cal-property"><i />{selectedPropertyReference ? "Selected property" : "All properties"}</span>
          <span className="hh-cal-head-buttons">
            <Link href={reportMaintenanceHref(selectedPropertyReference)} className="hh-cal-action" data-testid="link-report-maintenance"><Wrench size={14} /> Report maintenance</Link>
            <button className="hh-cal-primary" onClick={() => { setNotice(""); setViewingOpen(true); }} disabled={!configured || properties.length === 0} data-testid="button-book-viewing"><CalendarPlus size={15} /> Book a viewing</button>
          </span>
        </div>
      </header>

      {notice && <div className="status ready" role="status" style={{ margin: "0 0 12px" }} data-testid="calendar-notice"><Check size={13} /> {notice}</div>}

      <div className="hh-cal-summary">
        <div className="hh-cal-summary-main"><span className="hh-cal-summary-label">Showing</span><strong>{monthLabel}</strong><span className="hh-cal-summary-divider" /><span className="hh-cal-summary-live"><i /> {monthEvents.length} COHO {monthEvents.length === 1 ? "event" : "events"}</span></div>
        <div className="hh-cal-legend"><span><i className="hh-dot-live" /> Live COHO</span></div>
      </div>

      <section className="hh-cal-toolbar" aria-label="Calendar controls">
        <div className="hh-cal-modes" role="tablist" aria-label="Calendar view">
          <button className={mode === "log" ? "selected" : ""} onClick={() => setMode("log")} role="tab" aria-selected={mode === "log"} data-testid="button-view-event-log"><Table2 size={14} /> Event log</button>
          <button className={mode === "calendar" ? "selected" : ""} onClick={() => setMode("calendar")} role="tab" aria-selected={mode === "calendar"} data-testid="button-view-calendar"><CalendarDays size={14} /> Calendar</button>
          <button className={mode === "agenda" ? "selected" : ""} onClick={() => setMode("agenda")} role="tab" aria-selected={mode === "agenda"} data-testid="button-view-agenda"><List size={14} /> Daily agenda</button>
        </div>
        <div className="hh-cal-controls">
          <div className="hh-cal-month-nav">
            <button onClick={() => moveMonth(-1)} aria-label="Previous month" data-testid="button-previous-month"><ArrowLeft size={14} /></button>
            <strong>{monthLabel}</strong>
            <button onClick={() => moveMonth(1)} aria-label="Next month" data-testid="button-next-month"><ArrowRight size={14} /></button>
          </div>
          <button className="hh-cal-today" onClick={goToToday} data-testid="button-calendar-today">Today</button>
          <label className="hh-cal-select hh-cal-kind"><span>Type</span><select value={kind} onChange={(event) => setKind(event.target.value)} aria-label="Filter event type" data-testid="select-event-type"><option value="all">All activity</option>{cohoTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select><ChevronDown size={13} /></label>
          <label className="hh-cal-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a tenant, property or room" aria-label="Search calendar" data-testid="input-calendar-search" /></label>
        </div>
      </section>

      {sourceState !== "ready" && (
        <section className={`hh-cal-api-state ${sourceState}`} aria-live="polite" data-testid={`calendar-api-${sourceState}`}>
          {sourceState === "loading" ? <><div className="hh-cal-skeleton-mark" /><div><strong>Connecting to COHO calendar</strong><span>Checking live property activity…</span></div></>
            : sourceState === "error" ? <><AlertCircle size={17} /><div><strong>COHO calendar could not be loaded</strong><span>{errorText(statusQuery.error || calendarQuery.error)}</span></div><button onClick={() => { void statusQuery.refetch(); void calendarQuery.refetch(); }}><RefreshCw size={13} /> Retry</button></>
              : sourceState === "unconfigured" ? <><AlertCircle size={17} /><div><strong>COHO is not configured</strong><span>Add the COHO API key to show live calendar activity.</span></div></>
                : <><CalendarDays size={17} /><div><strong>No COHO events in {monthLabel}</strong><span>{selectedPropertyReference ? "The selected property has no calendar activity this month." : "There is no calendar activity this month."}</span></div></>}
        </section>
      )}

      {mode === "calendar" && (
        <div className="hh-cal-layout">
          <section className="hh-cal-grid-panel" aria-label={`${monthLabel} calendar`}>
            <div className="hh-cal-weekdays">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => <span key={day}>{day}</span>)}</div>
            <div className="hh-cal-grid">
              {monthDays.map((date) => {
                const key = dateKey(date);
                const dayEvents = visibleEvents.filter((event) => coversDay(event, key));
                const inMonth = date.getMonth() === month.getMonth();
                return <button key={key} className={`hh-cal-day ${inMonth ? "" : "outside"} ${key === selectedDay ? "active" : ""}`} onClick={() => setSelectedDay(key)} aria-label={`Select ${formatDay(date)}, ${dayEvents.length} events`} aria-pressed={key === selectedDay} data-testid={`calendar-day-${key}`}>
                  <span className="hh-cal-day-number">{date.getDate()}</span>
                  {dayEvents.length > 0 && <span className="hh-cal-day-count">{dayEvents.length} {dayEvents.length === 1 ? "event" : "events"}</span>}
                  <div className="hh-cal-day-events">{dayEvents.slice(0, 3).map((event) => <span className={`hh-cal-event coho ${typeClass(event.type)}`} key={event.id} title={`${event.title} · ${event.type}`}><i />{event.title}</span>)}</div>
                  {dayEvents.length > 3 && <span className="hh-cal-more">+{dayEvents.length - 3} more</span>}
                </button>;
              })}
            </div>
          </section>
          <aside className="hh-cal-inspector">
            <div className="hh-inspector-title"><div><span>DAY INSPECTOR</span><h2>{formatDay(parseLocal(selectedDay))}</h2></div><span className="hh-inspector-count">{selectedEvents.length} {selectedEvents.length === 1 ? "event" : "events"}</span></div>
            <div className="hh-inspector-section-title hh-live-section-title"><span className="hh-inspector-icon live"><CalendarDays size={13} /></span>COHO activity <span className="hh-section-count live">{selectedEvents.length}</span></div>
            {selectedEvents.length ? <div className="hh-inspector-events">{selectedEvents.map((event) => <EventCard key={event.id} event={event} />)}</div>
              : <div className="hh-live-empty">{configured ? "No COHO events on this date." : "Live activity unavailable until COHO is configured."}</div>}
            <div className="hh-inspector-actions">
              <button type="button" className="hh-cal-action accent" onClick={() => { setNotice(""); setViewingOpen(true); }} disabled={!configured || properties.length === 0} data-testid="button-book-viewing-day"><CalendarPlus size={14} /> Book a viewing on this day</button>
              <Link href={reportMaintenanceHref(selectedPropertyReference)} className="hh-cal-action"><Wrench size={14} /> Report maintenance</Link>
            </div>
            <div className="hh-inspector-footer"><span><i className="hh-dot-live" /> COHO Public API 1.1</span></div>
          </aside>
        </div>
      )}

      {mode === "agenda" && <Agenda events={selectedEvents} date={selectedDay} />}
      {mode === "log" && <EventLog events={monthEvents} monthLabel={monthLabel} />}
      <footer className="hh-cal-foot"><span><Clock3 size={12} /> COHO timestamps display in your browser’s local timezone.</span><span>Live entries refresh when the calendar month changes.</span></footer>
      {viewingOpen && <BookViewingModal
        properties={properties}
        initialPropertyReference={selectedPropertyReference}
        initialDate={selectedDay >= dateKey(new Date()) ? selectedDay : dateKey(new Date())}
        onClose={() => setViewingOpen(false)}
        onBooked={(message) => { setViewingOpen(false); setNotice(message); }}
      />}
    </div>
  );
}

function EventCard({ event }: { event: CalendarEvent }) {
  const location = [event.property, event.room && `Room ${event.room}`].filter(Boolean).join(" · ");
  return <article className="hh-inspector-event coho" data-testid={`event-coho-${event.id}`}>
    <div className="hh-event-top"><span className="hh-source-label coho">COHO · {event.type.toUpperCase()}</span></div>
    <strong>{event.title}</strong>
    <div className="hh-event-meta">{[location, event.person].filter(Boolean).join(" · ") || event.type}</div>
    <div className="hh-event-dates">{formatShort(event.date)}{event.endDate !== event.date ? ` — ${formatShort(event.endDate)}` : ""}</div>
    {event.propertyReference && <Link href={reportMaintenanceHref(event.propertyReference, event.roomReference)} className="hh-event-link" data-testid={`link-report-maintenance-${event.id}`}><Wrench size={12} /> Report maintenance here</Link>}
  </article>;
}

function Agenda({ events, date }: { events: CalendarEvent[]; date: string }) {
  const sorted = [...events].sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startsAt.getTime() - b.startsAt.getTime());
  return <section className="hh-cal-agenda">
    <div className="hh-agenda-head"><div><span>DAILY AGENDA</span><h2>{formatDay(parseLocal(date))}</h2></div><span className="hh-agenda-total">{events.length} scheduled</span></div>
    {sorted.length ? <div className="hh-agenda-list">{sorted.map((event) => <div className="hh-agenda-row" key={event.id}><div className="hh-agenda-time">{event.allDay || event.date !== date ? "All day" : formatTime(event.startsAt)}<span /></div><EventCard event={event} /></div>)}</div>
      : <div className="hh-cal-empty large"><CalendarDays size={22} /><strong>A clear day</strong><span>No COHO activity matches this date.</span></div>}
  </section>;
}

function EventLog({ events, monthLabel }: { events: CalendarEvent[]; monthLabel: string }) {
  return <section className="hh-cal-log">
    <div className="hh-log-heading"><div><span>LIVE COHO DATA</span><h2>Event log</h2><p>Every COHO calendar entry starting in {monthLabel}.</p></div></div>
    <div className="hh-log-table-wrap"><table className="hh-log-table"><thead><tr><th>Event</th><th>Type</th><th>Property</th><th>Room</th><th>Person</th><th>Starts</th><th>Ends</th></tr></thead><tbody>{events.map((event) =>
      <tr key={event.id} data-testid={`row-event-${event.id}`}><td><strong>{event.title}</strong></td><td><span className={`hh-log-status ${typeClass(event.type)}`}>{event.type}</span></td><td>{event.property || "—"}</td><td>{event.room || "—"}</td><td>{event.person || "—"}</td><td>{formatShort(event.date)}</td><td>{event.endDate !== event.date ? formatShort(event.endDate) : "—"}</td></tr>,
    )}{!events.length && <tr><td colSpan={7}><div className="hh-cal-empty"><Table2 size={20} /><strong>No COHO events this month</strong><span>Try another month or clear the filters.</span></div></td></tr>}</tbody></table></div>
  </section>;
}
