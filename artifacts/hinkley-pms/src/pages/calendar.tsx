import { useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BedDouble,
  CalendarDays,
  Check,
  ChevronDown,
  Clock3,
  List,
  Plus,
  RefreshCw,
  Search,
  Table2,
  UsersRound,
} from "lucide-react";
import {
  getGetCohoStatusQueryKey,
  getListCohoCalendarQueryKey,
  type CohoCalendarEntry,
  useGetCohoStatus,
  useListCohoCalendar,
} from "@workspace/api-client-react";
import "./calendar.css";

type Reservation = { id: string; guestId: string; room: string; arrival: string; departure: string; status: string; totalPhp: number };
type Guest = { id: string; name: string; email: string; phone: string };
type Room = { id: string; number: string; type: string; status: string; ratePhp: number };
type CalendarProps = {
  reservations: Reservation[];
  guests: Guest[];
  rooms: Room[];
  selectedPropertyReference?: string;
  onNewReservation: () => void;
  onCheckIn: (reservationId: string) => void;
};
type Mode = "calendar" | "log" | "agenda";
type CalendarEvent = {
  id: string;
  title: string;
  date: string;
  endDate: string;
  person: string;
  room: string;
  type: string;
  source: "demo" | "coho";
  status?: string;
  reservation?: Reservation;
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
const money = (value: number) => new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}).format(value);
const eventType = (entry: CohoCalendarEntry) => entry.entryType || entry.source;
const typeClass = (type: string) => type.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const errorText = (error: unknown) => error instanceof Error ? error.message : "Please try again in a moment.";

export default function CalendarPage({
  reservations,
  guests,
  rooms,
  selectedPropertyReference,
  onNewReservation,
  onCheckIn,
}: CalendarProps) {
  const [month, setMonth] = useState(() => monthStart(new Date(2026, 8, 1)));
  const [selectedDay, setSelectedDay] = useState("2026-09-18");
  const [mode, setMode] = useState<Mode>("calendar");
  const [roomType, setRoomType] = useState("all");
  const [kind, setKind] = useState("all");
  const [search, setSearch] = useState("");

  const statusQuery = useGetCohoStatus({
    query: { queryKey: getGetCohoStatusQueryKey(), refetchInterval: 15_000 },
  });
  const fromDate = new Date(Date.UTC(month.getFullYear(), month.getMonth(), 1)).toISOString();
  const calendarParams = useMemo(() => ({ fromDate }), [fromDate]);
  const calendarQuery = useListCohoCalendar(calendarParams, {
    query: {
      queryKey: getListCohoCalendarQueryKey(calendarParams),
      enabled: statusQuery.data?.configured === true,
    },
  });
  const configured = statusQuery.data?.configured === true;

  const demoEvents = useMemo<CalendarEvent[]>(() => reservations.map((reservation) => {
    const guest = guests.find((item) => item.id === reservation.guestId);
    return {
      id: reservation.id,
      title: guest?.name || "Guest reservation",
      date: reservation.arrival,
      endDate: reservation.departure,
      person: guest?.name || "Guest",
      room: reservation.room,
      type: "Reservation",
      source: "demo",
      status: reservation.status,
      reservation,
    };
  }), [reservations, guests]);

  const cohoEvents = useMemo<CalendarEvent[]>(() => {
    const entries = calendarQuery.data?.items ?? [];
    return entries
      .filter((entry) => !selectedPropertyReference || entry.propertyReference === selectedPropertyReference)
      .map((entry) => ({
        id: entry.id,
        title: entry.title || eventType(entry),
        date: dateKey(new Date(entry.entryDate)),
        endDate: entry.endDate ? dateKey(new Date(entry.endDate)) : dateKey(new Date(entry.entryDate)),
        person: entry.personName || "",
        room: entry.roomName || entry.roomReference || "",
        type: eventType(entry),
        source: "coho" as const,
      }));
  }, [calendarQuery.data, selectedPropertyReference]);

  const allEvents = useMemo(() => [...demoEvents, ...cohoEvents], [demoEvents, cohoEvents]);
  const visibleEvents = useMemo(() => allEvents.filter((event) => {
    const room = rooms.find((item) => item.number === event.room);
    const matchesRoom = roomType === "all" || (event.source === "demo" && room?.type === roomType);
    const matchesKind = kind === "all" || (kind === "demo" ? event.source === "demo" : event.source === "coho" && event.type === kind);
    const matchesSearch = !search || `${event.title} ${event.person} ${event.room} ${event.type}`.toLowerCase().includes(search.toLowerCase());
    return matchesRoom && matchesKind && matchesSearch;
  }), [allEvents, rooms, roomType, kind, search]);
  const monthDays = useMemo(() => {
    const start = monthStart(month);
    const firstMondayOffset = (start.getDay() + 6) % 7;
    const gridStart = new Date(start.getTime() - firstMondayOffset * DAY_MS);
    return Array.from({ length: 42 }, (_, index) => new Date(gridStart.getTime() + index * DAY_MS));
  }, [month]);
  const roomTypes = [...new Set(rooms.map((room) => room.type))];
  const selectedEvents = visibleEvents.filter((event) => event.date <= selectedDay && event.endDate >= selectedDay);
  const localStaysOnDate = reservations.filter((reservation) =>
    reservation.arrival <= selectedDay &&
    reservation.departure > selectedDay &&
    !/cancel|complete|checked out/i.test(reservation.status),
  );
  const localArrivalsOnDate = localStaysOnDate.filter((reservation) => reservation.arrival === selectedDay);
  const occupiedRoomNumbers = new Set(localStaysOnDate.map((reservation) => reservation.room));
  const roomAvailability = roomTypes.map((type) => {
    const typedRooms = rooms.filter((room) => room.type === type);
    const occupied = typedRooms.filter((room) => occupiedRoomNumbers.has(room.number)).length;
    return { type, total: typedRooms.length, occupied, available: typedRooms.length - occupied };
  });
  const selectedCohoEvents = selectedEvents.filter((event) => event.source === "coho");
  const monthReservations = visibleEvents.filter((event) => event.source === "demo" && event.date.slice(0, 7) === dateKey(month).slice(0, 7)).length;
  const monthLiveCount = visibleEvents.filter((event) => event.source === "coho" && event.date.slice(0, 7) === dateKey(month).slice(0, 7)).length;
  const monthLabel = month.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const cohoTypes = [...new Set(cohoEvents.map((event) => event.type))];

  const moveMonth = (delta: number) => {
    const next = new Date(month.getFullYear(), month.getMonth() + delta, 1);
    setMonth(next);
    setSelectedDay(dateKey(next));
  };
  const visibleForDate = (date: Date) => {
    const key = dateKey(date);
    return visibleEvents.filter((event) => event.date <= key && event.endDate >= key);
  };
  const sourceState = statusQuery.isLoading
    ? "loading"
    : statusQuery.isError
      ? "error"
      : configured && calendarQuery.isLoading
        ? "loading"
        : configured && calendarQuery.isError
          ? "error"
          : !configured
            ? "unconfigured"
            : cohoEvents.length === 0
              ? "empty"
              : "ready";

  return (
    <div className="hh-calendar" data-testid="page-calendar">
      <header className="hh-cal-head">
        <div>
          <div className="hh-cal-kicker"><span className="hh-cal-kicker-dot" /> FRONT DESK / STAYS & AVAILABILITY</div>
          <h1>Room calendar</h1>
          <p>Bookings, property activity and the day ahead — together in one view.</p>
        </div>
        <div className="hh-cal-head-actions">
          <span className="hh-cal-property"><i />{selectedPropertyReference ? "Selected property" : "All properties"}</span>
          <button className="hh-cal-primary" onClick={onNewReservation} data-testid="button-new-reservation"><Plus size={15} /> New reservation</button>
        </div>
      </header>

      <div className="hh-cal-summary">
        <div className="hh-cal-summary-main"><span className="hh-cal-summary-label">Showing</span><strong>{monthLabel}</strong><span className="hh-cal-summary-divider" /><span>{monthReservations} demo stays</span><span className="hh-cal-summary-live"><i /> {monthLiveCount} COHO events</span></div>
        <div className="hh-cal-legend"><span><i className="hh-dot-demo" /> Demo reservations</span><span><i className="hh-dot-live" /> Live COHO</span></div>
      </div>

      <section className="hh-cal-toolbar" aria-label="Calendar controls">
        <div className="hh-cal-modes" role="tablist" aria-label="Calendar view">
          <button className={mode === "log" ? "selected" : ""} onClick={() => setMode("log")} role="tab" aria-selected={mode === "log"} data-testid="button-view-booking-log"><Table2 size={14} /> Booking log</button>
          <button className={mode === "calendar" ? "selected" : ""} onClick={() => setMode("calendar")} role="tab" aria-selected={mode === "calendar"} data-testid="button-view-calendar"><CalendarDays size={14} /> Calendar</button>
          <button className={mode === "agenda" ? "selected" : ""} onClick={() => setMode("agenda")} role="tab" aria-selected={mode === "agenda"} data-testid="button-view-agenda"><List size={14} /> Daily agenda</button>
        </div>
        <div className="hh-cal-controls">
          <div className="hh-cal-month-nav">
            <button onClick={() => moveMonth(-1)} aria-label="Previous month" data-testid="button-previous-month"><ArrowLeft size={14} /></button>
            <strong>{monthLabel}</strong>
            <button onClick={() => moveMonth(1)} aria-label="Next month" data-testid="button-next-month"><ArrowRight size={14} /></button>
          </div>
          <button className="hh-cal-today" onClick={() => { const now = new Date(); setMonth(monthStart(now)); setSelectedDay(dateKey(now)); }} data-testid="button-calendar-today">Today</button>
          <label className="hh-cal-select"><span>Room type</span><select value={roomType} onChange={(event) => setRoomType(event.target.value)} aria-label="Filter room type" data-testid="select-room-type"><option value="all">All room types</option>{roomTypes.map((type) => <option key={type}>{type}</option>)}</select><ChevronDown size={13} /></label>
          <label className="hh-cal-select hh-cal-kind"><span>Source</span><select value={kind} onChange={(event) => setKind(event.target.value)} aria-label="Filter event type" data-testid="select-event-type"><option value="all">All activity</option><option value="demo">Demo reservations</option>{cohoTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select><ChevronDown size={13} /></label>
          <label className="hh-cal-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a guest or room" aria-label="Search calendar" data-testid="input-calendar-search" /></label>
        </div>
      </section>

      {sourceState !== "ready" && (
        <section className={`hh-cal-api-state ${sourceState}`} aria-live="polite" data-testid={`calendar-api-${sourceState}`}>
          {sourceState === "loading" ? <><div className="hh-cal-skeleton-mark" /><div><strong>Connecting to COHO calendar</strong><span>Checking live property activity…</span></div></>
            : sourceState === "error" ? <><AlertCircle size={17} /><div><strong>COHO calendar could not be loaded</strong><span>{errorText(statusQuery.error || calendarQuery.error)}</span></div><button onClick={() => { void statusQuery.refetch(); void calendarQuery.refetch(); }}><RefreshCw size={13} /> Retry</button></>
              : sourceState === "unconfigured" ? <><AlertCircle size={17} /><div><strong>COHO is not configured</strong><span>Live calendar activity is unavailable. Local demo reservations remain available. Add the COHO API key to enable live entries.</span></div></>
                : <><CalendarDays size={17} /><div><strong>No live COHO events in this month</strong><span>The selected property has no calendar activity in this view. Local demo stays are shown separately.</span></div></>}
        </section>
      )}

      {mode === "calendar" && (
        <div className="hh-cal-layout">
          <section className="hh-cal-grid-panel" aria-label={`${monthLabel} calendar`}>
            <div className="hh-cal-weekdays">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => <span key={day}>{day}</span>)}</div>
            <div className="hh-cal-grid">
              {monthDays.map((date) => {
                const key = dateKey(date);
                const dayEvents = visibleForDate(date);
                const inMonth = date.getMonth() === month.getMonth();
                return <button key={key} className={`hh-cal-day ${inMonth ? "" : "outside"} ${key === selectedDay ? "active" : ""}`} onClick={() => setSelectedDay(key)} aria-label={`Select ${formatDay(date)}, ${dayEvents.length} events`} aria-pressed={key === selectedDay} data-testid={`calendar-day-${key}`}>
                  <span className="hh-cal-day-number">{date.getDate()}</span>
                  {dayEvents.length > 0 && <span className="hh-cal-day-count">{dayEvents.length} {dayEvents.length === 1 ? "stay" : "events"}</span>}
                  <div className="hh-cal-day-events">{dayEvents.slice(0, 3).map((event) => <span className={`hh-cal-event ${event.source} ${typeClass(event.type)}`} key={`${event.source}-${event.id}`} title={`${event.title} · ${event.type}`}><i />{event.source === "demo" ? `${event.room} · ${event.person.split(" ")[0]}` : event.title}</span>)}</div>
                  {dayEvents.length > 3 && <span className="hh-cal-more">+{dayEvents.length - 3} more</span>}
                </button>;
              })}
            </div>
          </section>
          <aside className="hh-cal-inspector">
            <div className="hh-inspector-title"><div><span>DAY INSPECTOR</span><h2>{formatDay(parseLocal(selectedDay))}</h2></div><span className="hh-inspector-count">{localArrivalsOnDate.length} local arrivals</span></div>
            <div className="hh-inspector-section-title"><span className="hh-inspector-icon"><BedDouble size={13} /></span>Room availability</div>
            <div className="hh-room-availability">
              {roomAvailability.length ? roomAvailability.map((availability) => {
                const occupiedPercent = availability.total ? (availability.occupied / availability.total) * 100 : 0;
                return <div className="hh-room-type-row" key={availability.type} data-testid={`availability-${typeClass(availability.type)}`}>
                  <div className="hh-room-type-heading"><strong>{availability.type}</strong><span>{availability.available} available <i>·</i> {availability.occupied} occupied</span></div>
                  <div className="hh-room-type-bar" role="img" aria-label={`${availability.type}: ${availability.occupied} occupied, ${availability.available} available`}>
                    <span className="occupied" style={{ width: `${occupiedPercent}%` }} />
                    <span className="available" style={{ width: `${100 - occupiedPercent}%` }} />
                  </div>
                </div>;
              }) : <div className="hh-availability-empty">No rooms available in this PMS view.</div>}
            </div>
            <div className="hh-inspector-section-title"><span className="hh-inspector-icon"><UsersRound size={13} /></span>Guests on date <span className="hh-section-count">{localStaysOnDate.length}</span></div>
            {localStaysOnDate.length ? <div className="hh-day-guests">{localStaysOnDate.map((reservation) => {
              const guest = guests.find((item) => item.id === reservation.guestId);
              const isArrival = reservation.arrival === selectedDay;
              const canCheckIn = isArrival && !/checked in|checked out|complete|cancel/i.test(reservation.status);
              return <article className="hh-day-guest" key={reservation.id} data-testid={`guest-stay-${reservation.id}`}>
                <span className="hh-day-guest-avatar">{(guest?.name || "Guest").split(" ").map((part) => part[0]).slice(0, 2).join("").toUpperCase()}</span>
                <div className="hh-day-guest-info"><strong>{guest?.name || "Guest"}</strong><span>Room {reservation.room} · {isArrival ? "Arriving" : "In house"}</span><small>{formatShort(reservation.arrival)} – {formatShort(reservation.departure)}</small></div>
                {canCheckIn && <button className="hh-checkin hh-day-checkin" onClick={() => onCheckIn(reservation.id)} data-testid={`button-day-check-in-${reservation.id}`}><Check size={12} /> Check in</button>}
              </article>;
            })}</div> : <div className="hh-cal-empty hh-day-empty"><UsersRound size={17} /><strong>No local guests staying</strong><span>No local demo reservations cover this date.</span></div>}
            <div className="hh-inspector-section-title hh-live-section-title"><span className="hh-inspector-icon live"><CalendarDays size={13} /></span>Live COHO activity <span className="hh-section-count live">{selectedCohoEvents.length}</span></div>
            {selectedCohoEvents.length ? <div className="hh-inspector-events">{selectedCohoEvents.map((event) => <EventCard key={`coho-${event.id}`} event={event} onCheckIn={onCheckIn} selectedDay={selectedDay} />)}</div>
              : <div className="hh-live-empty">{configured ? "No COHO events on this date." : "Live activity unavailable until COHO is configured."}</div>}
            <div className="hh-inspector-footer"><span><i className="hh-dot-demo" /> Local demo data</span><span><i className="hh-dot-live" /> COHO Public API 1.1</span></div>
          </aside>
        </div>
      )}

      {mode === "agenda" && <Agenda events={selectedEvents} date={selectedDay} onCheckIn={onCheckIn} />}
      {mode === "log" && <BookingLog events={visibleEvents.filter((event) => event.source === "demo")} guests={guests} onCheckIn={onCheckIn} />}
      <footer className="hh-cal-foot"><span><Clock3 size={12} /> COHO timestamps display in your browser’s local timezone; demo stays use their entered calendar dates.</span><span>Live entries refresh when the calendar month changes.</span></footer>
    </div>
  );
}

function EventCard({ event, onCheckIn, selectedDay }: { event: CalendarEvent; onCheckIn: (id: string) => void; selectedDay: string }) {
  const canCheckIn = event.source === "demo" && event.reservation && event.reservation.status !== "Checked in" && event.reservation.status !== "Completed" && event.date === selectedDay;
  return <article className={`hh-inspector-event ${event.source}`} data-testid={`event-${event.source}-${event.id}`}>
    <div className="hh-event-top"><span className={`hh-source-label ${event.source}`}>{event.source === "demo" ? "DEMO BOOKING" : "COHO · " + event.type.toUpperCase()}</span>{event.status && <span className="hh-event-status">{event.status}</span>}</div>
    <strong>{event.title}</strong>
    <div className="hh-event-meta">{event.room ? `Room ${event.room} · ` : ""}{event.person || event.type}</div>
    <div className="hh-event-dates">{formatShort(event.date)}{event.endDate !== event.date ? ` — ${formatShort(event.endDate)}` : ""}</div>
    {canCheckIn && <button className="hh-checkin" onClick={() => onCheckIn(event.reservation!.id)} data-testid={`button-check-in-${event.reservation!.id}`}><Check size={13} /> Check in</button>}
  </article>;
}

function Agenda({ events, date, onCheckIn }: { events: CalendarEvent[]; date: string; onCheckIn: (id: string) => void }) {
  return <section className="hh-cal-agenda">
    <div className="hh-agenda-head"><div><span>DAILY AGENDA</span><h2>{formatDay(parseLocal(date))}</h2></div><span className="hh-agenda-total">{events.length} scheduled</span></div>
    {events.length ? <div className="hh-agenda-list">{events.map((event, index) => <div className="hh-agenda-row" key={`${event.source}-${event.id}`}><div className="hh-agenda-time">{event.source === "demo" ? (index % 2 ? "15:00" : "14:00") : "All day"}<span /></div><EventCard event={event} selectedDay={date} onCheckIn={onCheckIn} /></div>)}</div>
      : <div className="hh-cal-empty large"><CalendarDays size={22} /><strong>A clear day</strong><span>No reservations or live COHO activity match this date.</span></div>}
  </section>;
}

function BookingLog({ events, guests, onCheckIn }: { events: CalendarEvent[]; guests: Guest[]; onCheckIn: (id: string) => void }) {
  const [statusFilter, setStatusFilter] = useState("all");
  const filtered = events.filter((event) => statusFilter === "all" || event.status?.toLowerCase() === statusFilter);
  return <section className="hh-cal-log">
    <div className="hh-log-heading"><div><span>LOCAL DEMO DATA</span><h2>Booking log</h2><p>Reservations entered in this PMS demo. COHO activity is shown separately in the calendar.</p></div><label className="hh-cal-select"><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filter reservation status"><option value="all">All statuses</option><option value="confirmed">Confirmed</option><option value="pending">Pending</option><option value="checked in">Checked in</option><option value="completed">Completed</option></select><ChevronDown size={13} /></label></div>
    <div className="hh-log-table-wrap"><table className="hh-log-table"><thead><tr><th>Guest / reference</th><th>Room</th><th>Arrival</th><th>Departure</th><th>Status</th><th>Value</th><th>Action</th></tr></thead><tbody>{filtered.map((event) => {
      const guest = guests.find((item) => item.id === event.reservation?.guestId);
      const r = event.reservation!;
      return <tr key={r.id} data-testid={`row-booking-${r.id}`}><td><strong>{guest?.name || event.title}</strong><small>{r.id}</small></td><td>{r.room}</td><td>{formatShort(r.arrival)}</td><td>{formatShort(r.departure)}</td><td><span className={`hh-log-status ${typeClass(r.status)}`}>{r.status}</span></td><td>{money(r.totalPhp)}</td><td>{r.status !== "Checked in" && r.status !== "Completed" && <button className="hh-log-checkin" onClick={() => onCheckIn(r.id)} data-testid={`button-log-check-in-${r.id}`}>Check in</button>}</td></tr>;
    })}{!filtered.length && <tr><td colSpan={7}><div className="hh-cal-empty"><Table2 size={20} /><strong>No bookings match this view</strong><span>Adjust the status or room type filters.</span></div></td></tr>}</tbody></table></div>
  </section>;
}
