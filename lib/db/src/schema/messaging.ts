import { sql } from "drizzle-orm";
import { index, jsonb, pgPolicy, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { id } from "./columns";
import { whatsappInboundWriterRole } from "./roles";

// Every message on the main WhatsApp Business number, as forwarded by Ed's
// server (the number's one webhook belongs to it; we never hold the token).
// Saved by the Supabase Edge Function supabase/functions/whatsapp-inbound,
// which is always on, so nothing is lost while the app sleeps and no n8n
// execution is used. "in" is from a guest or tenant; "out" is a reply sent
// from the WhatsApp Business app on the phone (message echoes), when forwarded.
export const whatsappMessagesTable = pgTable(
  "whatsapp_messages",
  {
    id: id(),
    // WhatsApp's own message id (wamid…); repeats of the same message are ignored.
    waMessageId: text("wa_message_id").notNull(),
    direction: text("direction", { enum: ["in", "out"] }).notNull(),
    // The guest's or tenant's number (digits, no +), whichever way the message went.
    contactNumber: text("contact_number").notNull(),
    contactName: text("contact_name"),
    // Our number that received or sent it.
    businessNumber: text("business_number"),
    messageType: text("message_type").notNull(),
    // Text, caption, button title or file name; null for stickers and the like.
    body: text("body"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    // The message as WhatsApp sent it, for anything not copied into a column.
    raw: jsonb("raw").notNull(),
  },
  (t) => [
    uniqueIndex("whatsapp_messages_wa_message_id_uq").on(t.waMessageId),
    index("whatsapp_messages_contact_sent_idx").on(t.contactNumber, t.sentAt.desc()),
    index("whatsapp_messages_sent_at_idx").on(t.sentAt.desc()),
    pgPolicy("whatsapp_messages_inbound_insert", { for: "insert", to: whatsappInboundWriterRole, withCheck: sql`true` }),
  ],
).enableRLS();

export type WhatsappMessage = typeof whatsappMessagesTable.$inferSelect;
