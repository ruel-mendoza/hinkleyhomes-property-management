import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeftRight, BedDouble, CalendarDays, DoorOpen, ExternalLink, LogIn, LogOut, MessageSquare, PlugZap, RefreshCw, ShieldCheck } from "lucide-react";
import { getGetStayAvailabilityQueryKey, getGetStaysQueryKey, useGetStayAvailability, useGetStays, useSyncStays, type StayAvailability, type StayBooking, type StaysOverview } from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import { formatDate } from "@/services/properties";
import "./stays.css";

// Stays (Hinkley Homes Stays): short-stay bookings mirrored read-only from
// Smoobu, the channel manager. Prices, availability and replies to guests stay
// in Smoobu (PriceLabs sets prices there); this page only shows what's coming up.

const SMOOBU_URL = "https://login.smoobu.com";
const pounds = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const dayLabel = (date: string, today: string) => (date === today ? "Today" : formatDate(date));
const staysQueryOptions = { query: { queryKey: getGetStaysQueryKey(), refetchInterval: 5 * 60_000, retry: false } };
const availabilityQueryOptions = { query: { queryKey: getGetStayAvailabilityQueryKey(), refetchInterval: 10 * 60_000, retry: false } };
const wholePounds = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
const nightLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", timeZone: "UTC" });
const nextDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

// The summary tiles filter the bookings table; same rules as the server's counts.
type BookingFilter = "arriving" | "leaving" | "inHouse" | "notReady";
const FILTERS: Record<BookingFilter, { label: string; test: (booking: StayBooking, today: string) => boolean }> = {
  arriving: { label: "Arriving today", test: (b, today) => b.arrival === today },
  leaving: { label: "Leaving today", test: (b, today) => b.departure === today },
  inHouse: { label: "In house", test: (b, today) => b.arrival <= today && b.departure > today },
  notReady: { label: "Not ready to arrive", test: (b, today) => b.arrival >= today && b.arrival <= nextDay(today) && !!b.checks?.issues.length },
};
const scrollToId = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

export default function StaysPage() {
  const queryClient = useQueryClient();
  const query = useGetStays(staysQueryOptions);
  const sync = useSyncStays();
  const [syncMessage, setSyncMessage] = useState("");
  const [filter, setFilter] = useState<BookingFilter | null>(null);
  const data = query.data;
  const availability = useGetStayAvailability({ query: { ...availabilityQueryOptions.query, enabled: !!data } });

  const pick = (next: BookingFilter) => {
    const turnOff = filter === next;
    setFilter(turnOff ? null : next);
    if (!turnOff) requestAnimationFrame(() => scrollToId("stays-bookings"));
  };
  const tile = (key: BookingFilter, icon: ReactNode, count: number, label: string, tone = "") => (
    <button type="button" className={`${tone}${filter === key ? " active" : ""}`} aria-pressed={filter === key} onClick={() => pick(key)} title={filter === key ? "Show all bookings" : `Show only these in Bookings`}>
      {icon}<strong>{count}</strong> {label}
    </button>
  );

  const runSync = async () => {
    setSyncMessage("");
    try {
      const result = await sync.mutateAsync();
      await queryClient.invalidateQueries({ queryKey: getGetStaysQueryKey() });
      setSyncMessage(result.status === "skipped" ? "A sync was already running." : `Synced ${result.bookings} ${result.bookings === 1 ? "booking" : "bookings"} from Smoobu.`);
    } catch (error) {
      setSyncMessage(`Sync failed: ${errorText(error)}`);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Hinkley Homes Stays · Smoobu</div>
          <h1 className="page-title">Stays</h1>
          <p className="page-sub">Arrivals, departures, changeovers and guest messages for today and the next 7 days</p>
        </div>
        <div className="head-actions hh-stay-sync">
          <span className={syncMessage.startsWith("Sync failed") ? "failed" : ""} role="status">
            {sync.isPending ? "Syncing with Smoobu…" : syncMessage || (data?.lastSync ? `Last synced ${when(data.lastSync.at)}` : data ? "Not synced yet" : "")}
          </span>
          <button className="button" onClick={() => void runSync()} disabled={sync.isPending || query.isError} data-testid="button-sync-stays">
            <RefreshCw size={14} className={sync.isPending ? "spin" : ""} /> Sync now
          </button>
          <a className="button" href={SMOOBU_URL} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open Smoobu</a>
        </div>
      </div>

      {query.isLoading && <section className="panel hh-stay-note">Loading stays from Smoobu…</section>}
      {query.isError && (
        <section className="panel"><div className="empty-state"><PlugZap size={21} /><h3>Smoobu isn't connected</h3><p>{errorText(query.error)}</p></div></section>
      )}
      {data?.lastSync?.status === "failed" && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> The last Smoobu sync failed: {data.lastSync.error ?? "unknown error"}</p>}

      {data && (
        <>
          <div className="hh-stay-sum">
            {tile("arriving", <LogIn size={17} />, data.counts.arrivingToday, "arriving today")}
            {tile("leaving", <LogOut size={17} />, data.counts.leavingToday, "leaving today")}
            {tile("inHouse", <BedDouble size={17} />, data.counts.inHouse, "in house", "good")}
            <button type="button" onClick={() => scrollToId("stays-messages")} title="Go to guest messages"><MessageSquare size={17} /><strong>{data.messages.threadsToday}</strong> guest {data.messages.threadsToday === 1 ? "conversation" : "conversations"} today</button>
            {data.guestChecks && tile("notReady", <ShieldCheck size={17} />, data.counts.notReady, "not ready to arrive", data.counts.notReady ? "warn" : "")}
            {availability.data && <button type="button" onClick={() => scrollToId("stays-availability")} title="Go to availability"><DoorOpen size={17} /><strong>{availability.data.freeTonight}</strong> free tonight</button>}
          </div>
          <GuestMessagesPanel messages={data.messages} />
          <ChangeoversPanel data={data} />
          <BookingsPanel data={data} filter={filter} onClear={() => setFilter(null)} />
          <AvailabilityPanel query={availability} />
          <p className="hh-stay-foot">
            Read-only from Smoobu across <Link href="/properties?tab=smoobu">{data.apartments} {data.apartments === 1 ? "apartment" : "apartments"}</Link>. Prices and availability are set in Smoobu by PriceLabs, and replies to guests are sent from Smoobu. Only guest names are kept here.
          </p>
        </>
      )}
    </>
  );
}

function GuestMessagesPanel({ messages }: { messages: StaysOverview["messages"] }) {
  return (
    <section className="panel hh-stay-panel" id="stays-messages">
      <div className="panel-head">
        <div><div className="panel-title">Latest guest messages</div><div className="panel-caption">Newest Airbnb, Booking.com and direct conversations in Smoobu{messages.unreadMessages ? ` · ${messages.unreadMessages.toLocaleString("en-GB")} unread there` : ""}</div></div>
        <a className="button" href={SMOOBU_URL} target="_blank" rel="noreferrer">Reply in Smoobu <ExternalLink size={13} /></a>
      </div>
      {messages.error ? <div className="empty-state"><MessageSquare size={21} /><h3>Messages could not be loaded</h3><p>{messages.error}</p></div>
        : !messages.threads.length ? <div className="empty-state"><MessageSquare size={21} /><h3>No guest messages yet</h3></div>
          : (
            <ul className="hh-stay-threads">
              {messages.threads.map((thread, index) => (
                <li key={thread.bookingId ?? index}>
                  <div>
                    <strong>{thread.guestName ?? "Guest"}</strong>
                    <small>{[thread.apartmentName, thread.lastMessageAt ? when(thread.lastMessageAt) : null].filter(Boolean).join(" · ")}</small>
                    {thread.preview && <p>{thread.preview}</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}
    </section>
  );
}

function ChangeoversPanel({ data }: { data: StaysOverview }) {
  return (
    <section className="panel table-panel hh-stay-panel">
      <div className="panel-head"><div><div className="panel-title">Changeovers this week</div><div className="panel-caption">Every departure needs a clean; same-day turnarounds first. The guest's cleaning fee is the cleaning allowance.</div></div></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Day</th><th>Apartment</th><th>Leaving</th><th>Arriving</th><th>Cleaning allowance</th></tr></thead>
          <tbody>
            {data.changeovers.map((changeover, index) => (
              <tr key={`${changeover.date}-${changeover.apartmentName}-${index}`}>
                <td><strong>{dayLabel(changeover.date, data.asOf)}</strong></td>
                <td>{changeover.apartmentName}</td>
                <td>{changeover.leavingGuest ?? "Guest"}{changeover.checkOutTime && <small className="hh-stay-sub">Out by {changeover.checkOutTime}</small>}</td>
                <td>
                  {changeover.sameDay ? <><span className="status pending">Same day</span> {changeover.arrivingGuest ?? "Guest"}{changeover.checkInTime && <small className="hh-stay-sub">In from {changeover.checkInTime}</small>}</> : <span className="secondary-text">No arrival that day</span>}
                </td>
                <td>{changeover.cleaningFee === null ? "—" : pounds.format(changeover.cleaningFee)}</td>
              </tr>
            ))}
            {!data.changeovers.length && <tr><td colSpan={5}><div className="empty-state"><ArrowLeftRight size={21} /><h3>No changeovers in the next 7 days</h3></div></td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BookingsPanel({ data, filter, onClear }: { data: StaysOverview; filter: BookingFilter | null; onClear: () => void }) {
  const bookings = filter ? data.bookings.filter((booking) => FILTERS[filter].test(booking, data.asOf)) : data.bookings;
  return (
    <section className="panel table-panel hh-stay-panel" id="stays-bookings">
      <div className="panel-head">
        <div><div className="panel-title">Bookings{filter && ` · ${FILTERS[filter].label}`}</div><div className="panel-caption">{filter ? `${bookings.length} of ${data.bookings.length} bookings` : "In house now or arriving in the next 7 days"}{data.guestChecks ? ". Guest checks come from ChargeAutomation." : ""}</div></div>
        {filter && <button type="button" className="button" onClick={onClear}>Show all</button>}
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Guest</th><th>Apartment</th><th>Stay</th><th>Channel</th><th>Price</th>{data.guestChecks && <th>Guest checks <small className="hh-stay-sub">ChargeAutomation</small></th>}</tr></thead>
          <tbody>
            {bookings.map((booking) => (
              <tr key={booking.id}>
                <td><strong>{booking.guestName ?? "Guest"}</strong>{booking.guests !== null && <small className="hh-stay-sub">{booking.guests} {booking.guests === 1 ? "guest" : "guests"}</small>}</td>
                <td>{booking.apartmentName}</td>
                <td>{dayLabel(booking.arrival, data.asOf)} → {dayLabel(booking.departure, data.asOf)}<small className="hh-stay-sub">{booking.nights} {booking.nights === 1 ? "night" : "nights"}</small></td>
                <td>{booking.channel ?? "—"}</td>
                <td>
                  {booking.price === null ? "—" : pounds.format(booking.price)}
                  {booking.pricePaid === false && <span className="status overdue hh-stay-unpaid">Unpaid</span>}
                </td>
                {data.guestChecks && <td><GuestChecksCell checks={booking.checks} arrived={booking.arrival <= data.asOf} /></td>}
              </tr>
            ))}
            {!bookings.length && filter && <tr><td colSpan={data.guestChecks ? 6 : 5}><div className="empty-state"><BedDouble size={21} /><h3>No bookings to show</h3><p>Nothing matches "{FILTERS[filter].label}" right now.</p></div></td></tr>}
            {!data.bookings.length && !filter && <tr><td colSpan={data.guestChecks ? 6 : 5}><div className="empty-state"><BedDouble size={21} /><h3>No bookings this week</h3><p>{data.lastSync ? "Smoobu has no stays in the next 7 days." : "Run Sync now to read bookings from Smoobu."}</p></div></td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// Free nights per apartment for the next 14 nights, from Smoobu rates (set by PriceLabs).
function AvailabilityPanel({ query }: { query: { data?: StayAvailability; isLoading: boolean; isError: boolean; error: unknown } }) {
  const data = query.data;
  return (
    <section className="panel table-panel hh-stay-panel" id="stays-availability">
      <div className="panel-head">
        <div><div className="panel-title">Availability</div><div className="panel-caption">{data ? `${data.freeTonight} of ${data.apartments.length} apartments free tonight. ` : ""}Free nights for the next 14 nights with the nightly price and minimum stay from Smoobu, set by PriceLabs.</div></div>
        <a className="button" href={SMOOBU_URL} target="_blank" rel="noreferrer">Open calendar in Smoobu <ExternalLink size={13} /></a>
      </div>
      {query.isLoading ? <div className="empty-state"><CalendarDays size={21} /><h3>Loading availability from Smoobu…</h3></div>
        : query.isError ? <div className="empty-state"><PlugZap size={21} /><h3>Availability could not be loaded</h3><p>{errorText(query.error)}</p></div>
          : !data?.apartments.length ? <div className="empty-state"><CalendarDays size={21} /><h3>No apartments yet</h3><p>Run Sync now to read apartments from Smoobu.</p></div>
            : (
              <div className="table-wrap">
                <table className="hh-av">
                  <thead><tr><th>Apartment</th>{data.dates.map((date, index) => <th key={date}>{index === 0 ? "Tonight" : nightLabel(date)}</th>)}<th>Free</th></tr></thead>
                  <tbody>
                    {data.apartments.map((apartment) => (
                      <tr key={apartment.smoobuApartmentId}>
                        <td>{apartment.name}</td>
                        {apartment.nights.map((night) => (
                          <td key={night.date} className={night.available ? "free" : "taken"} title={`${nightLabel(night.date)}: ${night.available ? ["Free", night.price === null ? null : wholePounds.format(night.price), night.minStay && night.minStay > 1 ? `min ${night.minStay} nights` : null].filter(Boolean).join(" · ") : "Booked or blocked"}`}>
                            {night.available ? (night.price === null ? "Free" : wholePounds.format(night.price)) : ""}
                          </td>
                        ))}
                        <td><strong>{apartment.freeNights}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
    </section>
  );
}

// ChargeAutomation guest checks: what to sort first, else ready, plus what passed.
function GuestChecksCell({ checks, arrived }: { checks: StayBooking["checks"]; arrived: boolean }) {
  if (!checks) return <span className="secondary-text">—</span>;
  const passed = [
    checks.preCheckin && "Checked in online",
    checks.idVerification === "succeeded" && "ID checked",
    checks.deposit === "authorized" && (checks.depositAmount === null ? "Deposit held" : `${pounds.format(checks.depositAmount)} deposit held`),
    checks.payment === "successful" && "Paid",
  ].filter(Boolean).join(" · ");
  return (
    <>
      {checks.issues.length ? <div className="hh-stay-issues">{checks.issues.map((issue) => <span key={issue} className="status overdue">{issue}</span>)}</div>
        : checks.preCheckin ? <span className="status ready">Ready</span>
          : <span className="secondary-text">{arrived ? "No online check-in" : "Online check-in to do"}</span>}
      {passed && <small className="hh-stay-sub">{passed}</small>}
    </>
  );
}

// Headline figures for the Operations overview, linking to the full page.
export function StaysStrip() {
  const query = useGetStays(staysQueryOptions);
  const data = query.data;
  const free = useGetStayAvailability({ query: { ...availabilityQueryOptions.query, enabled: !!data } }).data;
  const stat = (label: string, value: number, tone = "") => <div><span>{label}</span><strong className={tone}>{value}</strong></div>;
  return (
    <section className="panel hh-stay-strip" aria-label="Stays">
      <div><div className="panel-title">Stays</div><div className="panel-caption">Today, from Smoobu</div></div>
      <div className="hh-stay-strip-stats">
        {query.isLoading ? <div><span>Loading…</span></div>
          : !data ? <div><span>Smoobu isn't connected yet</span></div>
            : (
              <>
                {stat("Arriving", data.counts.arrivingToday)}
                {stat("Leaving", data.counts.leavingToday)}
                {stat("In house", data.counts.inHouse)}
                {free && stat("Free tonight", free.freeTonight)}
                {stat("Changeovers this week", data.counts.changeoversThisWeek)}
                {stat("Guest conversations today", data.messages.threadsToday)}
                {data.guestChecks && stat("Not ready to arrive", data.counts.notReady, data.counts.notReady ? "warn" : "")}
                {data.unlinkedApartments > 0 && stat("Apartments not linked", data.unlinkedApartments, "warn")}
              </>
            )}
      </div>
      <div className="hh-stay-strip-links">
        <Link href="/properties?tab=smoobu" className="button">Apartments</Link>
        <Link href="/stays" className="button">Open stays</Link>
      </div>
    </section>
  );
}
