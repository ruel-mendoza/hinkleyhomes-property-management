import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeftRight, BedDouble, ExternalLink, LogIn, LogOut, MessageSquare, PlugZap, RefreshCw } from "lucide-react";
import { getGetStaysQueryKey, useGetStays, useSyncStays, type StaysOverview } from "@workspace/api-client-react";
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

export default function StaysPage() {
  const queryClient = useQueryClient();
  const query = useGetStays(staysQueryOptions);
  const sync = useSyncStays();
  const [syncMessage, setSyncMessage] = useState("");
  const data = query.data;

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
            <div><LogIn size={17} /><strong>{data.counts.arrivingToday}</strong> arriving today</div>
            <div><LogOut size={17} /><strong>{data.counts.leavingToday}</strong> leaving today</div>
            <div className="good"><BedDouble size={17} /><strong>{data.counts.inHouse}</strong> in house</div>
            <div className={data.messages.unreadMessages ? "warn" : ""}><MessageSquare size={17} /><strong>{data.messages.unreadMessages}</strong> unread {data.messages.unreadMessages === 1 ? "message" : "messages"}</div>
          </div>
          <GuestMessagesPanel messages={data.messages} />
          <ChangeoversPanel data={data} />
          <BookingsPanel data={data} />
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
    <section className="panel hh-stay-panel">
      <div className="panel-head">
        <div><div className="panel-title">Guest messages waiting</div><div className="panel-caption">Airbnb, Booking.com and direct guests with unread messages in Smoobu</div></div>
        <a className="button" href={SMOOBU_URL} target="_blank" rel="noreferrer">Reply in Smoobu <ExternalLink size={13} /></a>
      </div>
      {messages.error ? <div className="empty-state"><MessageSquare size={21} /><h3>Messages could not be loaded</h3><p>{messages.error}</p></div>
        : !messages.threads.length ? <div className="empty-state"><MessageSquare size={21} /><h3>No unread guest messages</h3></div>
          : (
            <ul className="hh-stay-threads">
              {messages.threads.map((thread, index) => (
                <li key={thread.bookingId ?? index}>
                  <div>
                    <strong>{thread.guestName ?? "Guest"}</strong>
                    <small>{[thread.apartmentName, thread.lastMessageAt ? when(thread.lastMessageAt) : null].filter(Boolean).join(" · ")}</small>
                    {thread.preview && <p>{thread.preview}</p>}
                  </div>
                  <span className="status pending">{thread.unread} unread</span>
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

function BookingsPanel({ data }: { data: StaysOverview }) {
  return (
    <section className="panel table-panel hh-stay-panel">
      <div className="panel-head"><div><div className="panel-title">Bookings</div><div className="panel-caption">In house now or arriving in the next 7 days</div></div></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Guest</th><th>Apartment</th><th>Stay</th><th>Channel</th><th>Price</th></tr></thead>
          <tbody>
            {data.bookings.map((booking) => (
              <tr key={booking.id}>
                <td><strong>{booking.guestName ?? "Guest"}</strong>{booking.guests !== null && <small className="hh-stay-sub">{booking.guests} {booking.guests === 1 ? "guest" : "guests"}</small>}</td>
                <td>{booking.apartmentName}</td>
                <td>{dayLabel(booking.arrival, data.asOf)} → {dayLabel(booking.departure, data.asOf)}<small className="hh-stay-sub">{booking.nights} {booking.nights === 1 ? "night" : "nights"}</small></td>
                <td>{booking.channel ?? "—"}</td>
                <td>
                  {booking.price === null ? "—" : pounds.format(booking.price)}
                  {booking.pricePaid === false && <span className="status overdue hh-stay-unpaid">Unpaid</span>}
                </td>
              </tr>
            ))}
            {!data.bookings.length && <tr><td colSpan={5}><div className="empty-state"><BedDouble size={21} /><h3>No bookings this week</h3><p>{data.lastSync ? "Smoobu has no stays in the next 7 days." : "Run Sync now to read bookings from Smoobu."}</p></div></td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// Headline figures for the Operations overview, linking to the full page.
export function StaysStrip() {
  const query = useGetStays(staysQueryOptions);
  const data = query.data;
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
                {stat("Changeovers this week", data.counts.changeoversThisWeek)}
                {stat("Unread guest messages", data.messages.unreadMessages, data.messages.unreadMessages ? "warn" : "")}
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
