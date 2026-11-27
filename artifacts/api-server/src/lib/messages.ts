import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { ukToday } from "./performance";
import { guestMessages } from "./stays";

// Messages page (/messages): WhatsApp conversations saved by the Supabase Edge
// Function whatsapp-inbound (forwarded by Ed's server), and the newest Smoobu
// guest threads. Read-only: replies are sent in WhatsApp and Smoobu.
// Privacy: the browser gets the contact's profile name and the last 4 digits of
// their number, never the full number.

const WINDOW_DAYS = 30;
const MAX_CONVERSATIONS = 40;

type ConversationRow = {
  contact_number: string;
  contact_name: string | null;
  direction: "in" | "out";
  body: string | null;
  message_type: string;
  sent_at: Date | string;
  unanswered: number | string;
  waiting_since: Date | string | null;
};

const iso = (value: Date | string) => new Date(value).toISOString();
const contactKey = (number: string) => createHash("sha256").update(`whatsapp:${number}`).digest("hex").slice(0, 16);

export async function whatsappInbox() {
  const db = getDb();
  const [totals] = (await db.execute(sql`
    select
      exists (select 1 from whatsapp_messages) as receiving,
      exists (select 1 from whatsapp_messages where direction = 'out') as replies_tracked,
      (select max(received_at) from whatsapp_messages) as last_received_at
  `)).rows as { receiving: boolean; replies_tracked: boolean; last_received_at: Date | string | null }[];

  // Latest message per contact in the window, the newest name they've used,
  // and the messages from them since our last reply.
  const rows = (await db.execute(sql`
    with latest as (
      select distinct on (contact_number) contact_number, direction, body, message_type, sent_at
      from whatsapp_messages
      where sent_at > now() - make_interval(days => ${WINDOW_DAYS})
      order by contact_number, sent_at desc
    ),
    last_reply as (
      select contact_number, max(sent_at) as at
      from whatsapp_messages
      where direction = 'out' and contact_number in (select contact_number from latest)
      group by contact_number
    )
    select
      l.contact_number, l.direction, l.body, l.message_type, l.sent_at,
      (select m.contact_name from whatsapp_messages m where m.contact_number = l.contact_number and m.contact_name is not null order by m.sent_at desc limit 1) as contact_name,
      (select count(*) from whatsapp_messages m where m.contact_number = l.contact_number and m.direction = 'in' and (r.at is null or m.sent_at > r.at)) as unanswered,
      (select min(m.sent_at) from whatsapp_messages m where m.contact_number = l.contact_number and m.direction = 'in' and (r.at is null or m.sent_at > r.at)) as waiting_since
    from latest l
    left join last_reply r on r.contact_number = l.contact_number
    order by l.sent_at desc
  `)).rows as ConversationRow[];

  const today = ukToday();
  const ukDay = (value: Date | string) => new Date(value).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  return {
    receiving: Boolean(totals?.receiving),
    repliesTracked: Boolean(totals?.replies_tracked),
    lastReceivedAt: totals?.last_received_at ? iso(totals.last_received_at) : null,
    waiting: rows.filter((row) => row.direction === "in").length,
    today: rows.filter((row) => ukDay(row.sent_at) === today).length,
    conversations: rows.slice(0, MAX_CONVERSATIONS).map((row) => ({
      id: contactKey(row.contact_number),
      name: row.contact_name,
      numberEnding: row.contact_number.slice(-4),
      lastMessageAt: iso(row.sent_at),
      lastDirection: row.direction,
      preview: row.body ? row.body.replace(/\s+/g, " ").trim().slice(0, 160) : null,
      messageType: row.message_type,
      unanswered: Number(row.unanswered),
      waitingSince: row.direction === "in" && row.waiting_since ? iso(row.waiting_since) : null,
    })),
  };
}

export async function messages() {
  const [whatsapp, smoobu] = await Promise.all([whatsappInbox(), guestMessages()]);
  return { whatsapp, smoobu };
}
