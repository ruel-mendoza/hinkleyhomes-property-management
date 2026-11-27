// Supabase Edge Function: whatsapp-inbound
//
// Receives a copy of every message on the main WhatsApp Business number,
// forwarded by Ed's server (360dialog, WhatsApp Cloud API format), and saves it
// to public.whatsapp_messages. It runs on Supabase, so it is always on (the app
// server sleeps) and uses no n8n executions. It only adds rows: it never sends
// WhatsApp messages and holds no WhatsApp token.
//
// Deploy with JWT verification off, because Ed's server calls it with our own
// key instead of a Supabase key:
//   npx supabase@2 functions deploy whatsapp-inbound --no-verify-jwt --project-ref <project ref>
//
// Secrets (Supabase > Edge Functions > Secrets):
//   WHATSAPP_FORWARD_KEY  long random value; Ed's server sends it in the
//                         X-Hinkley-Forward-Key header (or Authorization: Bearer)
//   WHATSAPP_DB_URL       login from lib/db/sql/whatsapp-inbound-writer.sql
//
// Accepts any of: the full webhook ({ object, entry: [{ changes: [{ value }] }] }),
// a bare value ({ messages, contacts, metadata }), or a list of either.
// Delivery reports (statuses) are ignored. Returns 500 if the save fails, so the
// sender can retry; repeats are ignored by WhatsApp message id.

import postgres from "npm:postgres@3.4.5";

const FORWARD_KEY = Deno.env.get("WHATSAPP_FORWARD_KEY") ?? "";
const DB_URL = Deno.env.get("WHATSAPP_DB_URL") ?? "";
const MAX_BODY_BYTES = 1_000_000;

const sql = DB_URL ? postgres(DB_URL, { prepare: false, max: 1, idle_timeout: 20 }) : null;

type Json = Record<string, unknown>;
type Row = {
  wa_message_id: string;
  direction: "in" | "out";
  contact_number: string;
  contact_name: string | null;
  business_number: string | null;
  message_type: string;
  body: string | null;
  sent_at: Date;
  raw: Json;
};

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const at = (value: unknown, ...path: string[]): unknown => path.reduce<unknown>((node, key) => (isObject(node) ? node[key] : undefined), value);

function sameKey(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// The readable part of a message, whatever its type.
function bodyOf(message: Json): string | null {
  return (
    str(at(message, "text", "body")) ??
    str(at(message, "image", "caption")) ??
    str(at(message, "video", "caption")) ??
    str(at(message, "document", "caption")) ??
    str(at(message, "document", "filename")) ??
    str(at(message, "button", "text")) ??
    str(at(message, "interactive", "button_reply", "title")) ??
    str(at(message, "interactive", "list_reply", "title")) ??
    str(at(message, "reaction", "emoji")) ??
    str(at(message, "location", "name")) ??
    str(at(message, "location", "address"))
  );
}

function sentAt(message: Json): Date {
  const seconds = Number(message.timestamp);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
}

// The "value" objects in whatever shape arrived.
function valuesOf(payload: unknown): Json[] {
  if (Array.isArray(payload)) return payload.flatMap(valuesOf);
  if (!isObject(payload)) return [];
  if (Array.isArray(payload.entry)) {
    return payload.entry.flatMap((entry) => list(at(entry, "changes")).flatMap((change) => (isObject(at(change, "value")) ? [at(change, "value") as Json] : [])));
  }
  return [payload];
}

function rowsOf(value: Json): Row[] {
  const businessNumber = str(at(value, "metadata", "display_phone_number"));
  const names = new Map<string, string>();
  for (const contact of list(value.contacts)) {
    const number = str(at(contact, "wa_id"));
    const name = str(at(contact, "profile", "name"));
    if (number && name) names.set(number, name);
  }
  const rows: Row[] = [];
  for (const message of list(value.messages)) {
    if (!isObject(message)) continue;
    const waMessageId = str(message.id);
    const from = str(message.from);
    if (!waMessageId || !from) continue;
    rows.push({
      wa_message_id: waMessageId,
      direction: "in",
      contact_number: from,
      contact_name: names.get(from) ?? null,
      business_number: businessNumber,
      message_type: str(message.type) ?? "unknown",
      body: bodyOf(message),
      sent_at: sentAt(message),
      raw: message,
    });
  }
  // Replies sent from the WhatsApp Business app on the phone (coexistence echoes).
  for (const message of list(value.message_echoes)) {
    if (!isObject(message)) continue;
    const waMessageId = str(message.id);
    const to = str(message.to);
    if (!waMessageId || !to) continue;
    rows.push({
      wa_message_id: waMessageId,
      direction: "out",
      contact_number: to,
      contact_name: names.get(to) ?? null,
      business_number: businessNumber ?? str(message.from),
      message_type: str(message.type) ?? "unknown",
      body: bodyOf(message),
      sent_at: sentAt(message),
      raw: message,
    });
  }
  return rows;
}

const reply = (status: number, body: Json) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (request) => {
  if (request.method !== "POST") return reply(405, { error: "Use POST." });
  if (!FORWARD_KEY || !sql) return reply(503, { error: "Not set up: add WHATSAPP_FORWARD_KEY and WHATSAPP_DB_URL." });

  const given = request.headers.get("x-hinkley-forward-key") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!sameKey(given, FORWARD_KEY)) return reply(401, { error: "Wrong or missing key." });

  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return reply(413, { error: "Too large." });
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return reply(400, { error: "Not JSON." });
  }

  const rows = valuesOf(payload).flatMap(rowsOf);
  if (!rows.length) return reply(200, { saved: 0, ignored: 0 });

  try {
    const saved = await sql`
      insert into public.whatsapp_messages ${sql(rows.map((row) => ({ ...row, raw: sql.json(row.raw) })), "wa_message_id", "direction", "contact_number", "contact_name", "business_number", "message_type", "body", "sent_at", "raw")}
      on conflict do nothing
    `;
    return reply(200, { saved: saved.count, ignored: rows.length - saved.count });
  } catch (error) {
    console.error("whatsapp-inbound: save failed", error instanceof Error ? error.message : error);
    return reply(500, { error: "Save failed; please retry." });
  }
});
