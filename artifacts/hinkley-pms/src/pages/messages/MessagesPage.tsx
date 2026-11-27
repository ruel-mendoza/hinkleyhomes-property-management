import type { ReactNode } from "react";
import { Link } from "wouter";
import { Clock, ExternalLink, MessageCircle, MessageSquare, PlugZap } from "lucide-react";
import { getGetMessagesQueryKey, useGetMessages, type Messages, type WhatsappConversation } from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import "./messages.css";

// Messages: WhatsApp conversations from the main number (forwarded by Ed's
// server to our Supabase receiver) and the newest Smoobu guest threads, in one
// place. Read-only: staff reply in the WhatsApp Business app and in Smoobu.

const WHATSAPP_URL = "https://web.whatsapp.com";
const SMOOBU_URL = "https://login.smoobu.com";
const messagesQueryOptions = { query: { queryKey: getGetMessagesQueryKey(), refetchInterval: 60_000, retry: false } };
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

const TYPE_LABELS: Record<string, string> = { image: "Photo", video: "Video", audio: "Voice note", voice: "Voice note", document: "File", sticker: "Sticker", location: "Location", reaction: "Reaction", contacts: "Contact card" };

function waitedFor(since: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} days`;
}

export default function MessagesPage() {
  const query = useGetMessages(messagesQueryOptions);
  const data = query.data;
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">WhatsApp · Smoobu</div>
          <h1 className="page-title">Messages</h1>
          <p className="page-sub">Guest and tenant messages in one place. Replies are sent in WhatsApp and Smoobu.</p>
        </div>
        <div className="head-actions hh-msg-actions">
          <a className="button" href={WHATSAPP_URL} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open WhatsApp</a>
          <a className="button" href={SMOOBU_URL} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open Smoobu</a>
        </div>
      </div>

      {query.isLoading && <section className="panel hh-msg-note">Loading messages…</section>}
      {query.isError && <section className="panel"><div className="empty-state"><PlugZap size={21} /><h3>Messages could not be loaded</h3><p>{errorText(query.error)}</p></div></section>}

      {data && (
        <>
          <div className="hh-msg-sum">
            {data.whatsapp.repliesTracked && tile(<Clock size={17} />, data.whatsapp.waiting, "waiting for a reply on WhatsApp", data.whatsapp.waiting ? "warn" : "good")}
            {tile(<MessageCircle size={17} />, data.whatsapp.today, `WhatsApp ${data.whatsapp.today === 1 ? "conversation" : "conversations"} today`)}
            {!data.smoobu.error && tile(<MessageSquare size={17} />, data.smoobu.unreadMessages, "unread in Smoobu", data.smoobu.unreadMessages ? "warn" : "")}
          </div>
          <div className="hh-msg-grid">
            <WhatsappPanel inbox={data.whatsapp} />
            <SmoobuPanel smoobu={data.smoobu} />
          </div>
        </>
      )}
    </>
  );
}

function tile(icon: ReactNode, value: number, label: string, tone = "") {
  return <div className={tone}>{icon}<strong>{value.toLocaleString("en-GB")}</strong> {label}</div>;
}

function WhatsappPanel({ inbox }: { inbox: Messages["whatsapp"] }) {
  return (
    <section className="panel hh-msg-panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">WhatsApp</div>
          <div className="panel-caption">Main number, last 30 days, newest first{inbox.receiving && !inbox.repliesTracked ? ". Replies sent from the phone aren't forwarded yet, so answered conversations aren't marked." : ""}</div>
        </div>
        <a className="button" href={WHATSAPP_URL} target="_blank" rel="noreferrer">Reply in WhatsApp <ExternalLink size={13} /></a>
      </div>
      {!inbox.receiving ? <div className="empty-state"><MessageCircle size={21} /><h3>WhatsApp isn't forwarding yet</h3><p>Messages to the main WhatsApp number will appear here once forwarding is switched on.</p></div>
        : !inbox.conversations.length ? <div className="empty-state"><MessageCircle size={21} /><h3>No WhatsApp messages in the last 30 days</h3></div>
          : <ul className="hh-msg-list">{inbox.conversations.map((conversation) => <WhatsappRow key={conversation.id} conversation={conversation} repliesTracked={inbox.repliesTracked} />)}</ul>}
    </section>
  );
}

function WhatsappRow({ conversation, repliesTracked }: { conversation: WhatsappConversation; repliesTracked: boolean }) {
  const preview = conversation.preview ?? TYPE_LABELS[conversation.messageType] ?? "Message";
  const waiting = repliesTracked && conversation.lastDirection === "in" && conversation.waitingSince;
  return (
    <li>
      <div>
        <strong>{conversation.name ?? "WhatsApp contact"}</strong>
        <small>Number ending {conversation.numberEnding} · {when(conversation.lastMessageAt)}</small>
        <p>{conversation.lastDirection === "out" && <span className="hh-msg-you">We replied: </span>}{preview}</p>
      </div>
      <div className="hh-msg-end">
        {waiting ? <span className="status pending" title={`Waiting since ${when(conversation.waitingSince!)}`}>Waiting {waitedFor(conversation.waitingSince!)}</span>
          : repliesTracked && conversation.lastDirection === "out" ? <span className="hh-msg-done">Replied</span> : null}
        {conversation.unanswered > 1 && conversation.lastDirection === "in" && <small>{plural(conversation.unanswered, "message")}</small>}
      </div>
    </li>
  );
}

function SmoobuPanel({ smoobu }: { smoobu: Messages["smoobu"] }) {
  return (
    <section className="panel hh-msg-panel">
      <div className="panel-head">
        <div><div className="panel-title">Smoobu guests</div><div className="panel-caption">Newest Airbnb, Booking.com and direct conversations{smoobu.unreadMessages ? ` · ${smoobu.unreadMessages.toLocaleString("en-GB")} unread` : ""}</div></div>
        <a className="button" href={SMOOBU_URL} target="_blank" rel="noreferrer">Reply in Smoobu <ExternalLink size={13} /></a>
      </div>
      {smoobu.error ? <div className="empty-state"><MessageSquare size={21} /><h3>Smoobu messages could not be loaded</h3><p>{smoobu.error}</p></div>
        : !smoobu.threads.length ? <div className="empty-state"><MessageSquare size={21} /><h3>No guest messages yet</h3></div>
          : (
            <ul className="hh-msg-list">
              {smoobu.threads.map((thread, index) => (
                <li key={thread.bookingId ?? index}>
                  <div>
                    <strong>{thread.guestName ?? "Guest"}</strong>
                    <small>{[thread.apartmentName, thread.lastMessageAt ? new Date(thread.lastMessageAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : null].filter(Boolean).join(" · ")}</small>
                    {thread.preview && <p>{thread.preview}</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}
    </section>
  );
}

// Overview strip: WhatsApp and Smoobu at a glance, with a link that always works.
export function MessagesStrip() {
  const query = useGetMessages(messagesQueryOptions);
  const data = query.data;
  return (
    <section className="panel hh-perf-strip" aria-label="Messages">
      <div><div className="panel-title">Messages</div><div className="panel-caption">WhatsApp and Smoobu guests</div></div>
      <div className="hh-perf-strip-stats">
        {query.isLoading ? <div><span>Loading…</span></div>
          : !data ? <div><span>Messages could not be loaded</span></div>
            : (
              <>
                {!data.whatsapp.receiving ? <div><span>WhatsApp</span><strong>Not forwarding yet</strong></div>
                  : data.whatsapp.repliesTracked ? <div><span>WhatsApp waiting</span><strong className={data.whatsapp.waiting ? "warn" : "good"}>{data.whatsapp.waiting}</strong></div>
                    : <div><span>WhatsApp today</span><strong>{plural(data.whatsapp.today, "conversation")}</strong></div>}
                <div><span>Smoobu unread</span><strong className={data.smoobu.unreadMessages ? "warn" : ""}>{data.smoobu.error ? "—" : data.smoobu.unreadMessages}</strong></div>
              </>
            )}
      </div>
      <div className="hh-perf-strip-links"><Link href="/messages" className="button">Open messages</Link></div>
    </section>
  );
}
