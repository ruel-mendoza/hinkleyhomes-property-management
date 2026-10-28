import { and, desc, eq, gt, gte, isNotNull, isNull, like, lte, ne, or } from "drizzle-orm";
import {
  auditLogTable,
  cleaningAllowancesTable,
  getDb,
  integrationSyncRunsTable,
  propertiesTable,
  propertyAliasesTable,
  shortStayBookingsTable,
  smoobuApartmentsTable,
} from "@workspace/db";
import { aliasKey } from "./bill-coding-rules";
import { fetchCohoProperties } from "./coho-properties";
import { cohoApiKey } from "./integrations-env";
import { guestChecksFor, guestChecksReceived, syncGuestChecks } from "./guest-checks";
import { logger } from "./logger";
import { ukToday } from "./performance";
import { SmoobuApiError, smoobuGet } from "./smoobu-api";

// Hinkley Homes Stays: short-stay bookings mirrored read-only from Smoobu.
// Smoobu webhooks reach n8n, which forwards them to the app; the app re-reads
// each booking from Smoobu rather than trusting the webhook (Smoobu doesn't sign
// them). n8n also starts a catch-up sync every hour for anything missed.

const SYNC_TRIGGER = "bookings";
const FIRST_SYNC_DAYS = 120;
const ALLOWANCE_RULE = "Guest cleaning fee charged in Smoobu";

type Raw = Record<string, unknown>;
const obj = (value: unknown): Raw => (value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : {});
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : null);
const num = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};
// Smoobu documents "price-paid" as a boolean but sends "Yes" / "No".
const yesNo = (value: unknown): boolean | null => {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ["yes", "true", "1"].includes(s) ? true : ["no", "false", "0"].includes(s) ? false : null;
};
const day = (value: unknown): string | null => {
  const s = text(value)?.slice(0, 10);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const time = (value: unknown): string | null => {
  const s = text(value);
  return s && /^\d{1,2}:\d{2}/.test(s) ? s.slice(0, 5) : null;
};
const listIn = (payload: unknown, ...keys: string[]): Raw[] => {
  if (Array.isArray(payload)) return payload.map(obj);
  const o = obj(payload);
  for (const key of keys) if (Array.isArray(o[key])) return (o[key] as unknown[]).map(obj);
  return [];
};
export const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

// --- Apartments ---------------------------------------------------------------

async function syncApartments(): Promise<number> {
  const list = listIn(await smoobuGet("/api/apartments"), "apartments");
  let count = 0;
  for (const item of list) {
    const apartmentId = num(item.id);
    if (apartmentId === null) continue;
    let details: Raw = {};
    try {
      details = obj(await smoobuGet(`/api/apartments/${apartmentId}`));
    } catch (error) {
      logger.warn({ apartmentId, err: error }, "Smoobu apartment details could not be read");
    }
    const location = obj(details.location);
    const rooms = obj(details.rooms);
    const values = {
      smoobuApartmentId: apartmentId,
      name: text(item.name) ?? text(details.name) ?? `Apartment ${apartmentId}`,
      street: text(location.street),
      city: text(location.city),
      postcode: text(location.zip),
      maxOccupancy: num(rooms.maxOccupancy),
      bedrooms: num(rooms.bedrooms),
    };
    const { smoobuApartmentId: _key, ...update } = values;
    await getDb().insert(smoobuApartmentsTable).values(values).onConflictDoUpdate({ target: smoobuApartmentsTable.smoobuApartmentId, set: update });
    count += 1;
  }
  return count;
}

// The register property each Smoobu apartment's bookings belong to: the one
// staff linked it to (directly, or through its COHO reference), else an older
// link on properties.smoobu_property_id. COHO-only properties have no register
// row, so their bookings keep property_id null and are found by apartment.
async function linkedProperties(): Promise<Map<number, string>> {
  const p = propertiesTable;
  const a = smoobuApartmentsTable;
  const [apartments, register] = await Promise.all([
    getDb().select({ apartmentId: a.smoobuApartmentId, propertyId: a.propertyId, coho: a.cohoPropertyReference }).from(a),
    getDb().select({ id: p.id, coho: p.cohoPropertyReference, smoobuId: p.smoobuPropertyId }).from(p).where(or(isNotNull(p.cohoPropertyReference), isNotNull(p.smoobuPropertyId))),
  ]);
  const byCoho = new Map(register.flatMap((row) => (row.coho ? [[row.coho, row.id] as [string, string]] : [])));
  const linked = new Map(register.flatMap((row) => (num(row.smoobuId) === null ? [] : [[num(row.smoobuId)!, row.id] as [number, string]])));
  for (const apartment of apartments) {
    const propertyId = apartment.propertyId ?? (apartment.coho ? byCoho.get(apartment.coho) : undefined);
    if (propertyId) linked.set(apartment.apartmentId, propertyId);
  }
  return linked;
}

export class StaysError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// Smoobu apartments for the Properties page, with whether someone is staying
// tonight and the next arrival.
export async function listApartments(onlyApartmentId?: number) {
  const today = ukToday();
  const a = smoobuApartmentsTable;
  const t = shortStayBookingsTable;
  const [apartments, upcoming, lastSync] = await Promise.all([
    getDb().select().from(a).where(onlyApartmentId === undefined ? undefined : eq(a.smoobuApartmentId, onlyApartmentId)).orderBy(a.name),
    getDb()
      .select({ apartmentId: t.smoobuApartmentId, arrival: t.arrivalDate })
      .from(t)
      .where(and(ne(t.status, "cancelled"), gt(t.departureDate, today), onlyApartmentId === undefined ? undefined : eq(t.smoobuApartmentId, onlyApartmentId)))
      .orderBy(t.arrivalDate),
    lastSyncRun(),
  ]);
  const items = apartments.map((apartment) => {
    const stays = upcoming.filter((booking) => booking.apartmentId === apartment.smoobuApartmentId);
    return {
      smoobuApartmentId: apartment.smoobuApartmentId,
      name: apartment.name,
      address: [apartment.street, apartment.city, apartment.postcode].filter(Boolean).join(", ") || null,
      bedrooms: apartment.bedrooms,
      maxOccupancy: apartment.maxOccupancy,
      cohoReference: apartment.cohoPropertyReference,
      propertyId: apartment.propertyId,
      linkedBy: apartment.linkedBy === "auto" || apartment.linkedBy === "staff" ? apartment.linkedBy : null,
      inHouse: stays.some((booking) => booking.arrival <= today),
      nextArrival: stays.find((booking) => booking.arrival > today)?.arrival ?? null,
    };
  });
  return { items, lastSync: lastSync?.status === "succeeded" ? (lastSync.finishedAt ?? lastSync.startedAt).toISOString() : null };
}

// Links a Smoobu apartment to the property it is in (only in this app; Smoobu
// is never changed) and moves its bookings to that property.
export async function linkApartment(
  apartmentId: number,
  link: { cohoReference: string | null; propertyId: string | null },
  actor: { email: string | null; userId: string | null; requestId: string | null; ipAddress: string | null },
) {
  const cohoReference = link.cohoReference?.trim() || null;
  const propertyId = link.propertyId || null;
  if (cohoReference && propertyId) throw new StaysError("Link the apartment to one property only.", 400);
  const db = getDb();
  const a = smoobuApartmentsTable;
  const [before] = await db.select().from(a).where(eq(a.smoobuApartmentId, apartmentId));
  if (!before) throw new StaysError("That Smoobu apartment isn't in the app yet. Sync Stays first.", 404);
  if (propertyId) {
    const [property] = await db.select({ id: propertiesTable.id }).from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    if (!property) throw new StaysError("That property isn't in the register.", 404);
  }
  await db.transaction(async (tx) => {
    await tx.update(a).set({ cohoPropertyReference: cohoReference, propertyId, linkedBy: "staff" }).where(eq(a.smoobuApartmentId, apartmentId));
    await tx.insert(auditLogTable).values({
      actorEmail: actor.email,
      actorUserId: actor.userId,
      action: cohoReference || propertyId ? "smoobu_apartment.link" : "smoobu_apartment.unlink",
      tableName: "smoobu_apartments",
      recordId: String(apartmentId),
      before: { name: before.name, cohoReference: before.cohoPropertyReference, propertyId: before.propertyId },
      after: { name: before.name, cohoReference, propertyId },
      requestId: actor.requestId,
      ipAddress: actor.ipAddress,
    });
  });
  const t = shortStayBookingsTable;
  await db.update(t).set({ propertyId: (await linkedProperties()).get(apartmentId) ?? null }).where(eq(t.smoobuApartmentId, apartmentId));
  const [item] = (await listApartments(apartmentId)).items;
  return item;
}

// --- Automatic links ------------------------------------------------------------

// A property an apartment could be in, with the spellings it is known by: its
// name, its address line, and its property aliases (normalised like aliases are).
type LinkCandidate = { cohoReference: string | null; propertyId: string | null; postcode: string; keys: Set<string> };
const postcodeKey = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, "").toUpperCase();
const keysOf = (...values: (string | null | undefined)[]) => values.map((value) => aliasKey(value ?? "")).filter((key) => /[a-z]/.test(key));

async function linkCandidates(): Promise<LinkCandidate[]> {
  const p = propertiesTable;
  const al = propertyAliasesTable;
  const [coho, register, aliases] = await Promise.all([
    cohoApiKey() ? fetchCohoProperties() : Promise.resolve([]),
    getDb().select({ id: p.id, name: p.name, line: p.addressLine1, postcode: p.postcode, coho: p.cohoPropertyReference, status: p.status }).from(p),
    getDb().select({ propertyId: al.propertyId, key: al.normalizedAlias }).from(al).where(and(eq(al.kind, "text"), isNotNull(al.propertyId), isNull(al.roomId))),
  ]);
  const candidates: LinkCandidate[] = [];
  const byCoho = new Map<string, LinkCandidate>();
  for (const row of coho) {
    const candidate = { cohoReference: row.reference, propertyId: null, postcode: postcodeKey(row.postcode), keys: new Set(keysOf(row.name, `${row.houseNumber ?? ""} ${row.streetName ?? ""}`)) };
    candidates.push(candidate);
    byCoho.set(row.reference, candidate);
  }
  // A register row for a listed COHO property is the same property: its
  // spellings count towards the COHO one.
  const byRegister = new Map<string, LinkCandidate>();
  for (const row of register) {
    if (row.status === "archived") continue;
    const listed = row.coho ? byCoho.get(row.coho) : undefined;
    if (listed) {
      for (const key of keysOf(row.name, row.line)) listed.keys.add(key);
      byRegister.set(row.id, listed);
      continue;
    }
    const candidate = { cohoReference: null, propertyId: row.id, postcode: postcodeKey(row.postcode), keys: new Set(keysOf(row.name, row.line)) };
    candidates.push(candidate);
    byRegister.set(row.id, candidate);
  }
  for (const alias of aliases) if (alias.propertyId && alias.key) byRegister.get(alias.propertyId)?.keys.add(alias.key);
  return candidates;
}

// The apartment's name first (what staff typed in Smoobu), then its street
// address. Postcodes must agree when both are known, and a spelling with no
// house number needs both postcodes. Two or more matches is left for staff.
function matchApartment(apartment: { name: string; street: string | null; postcode: string | null }, candidates: LinkCandidate[]): LinkCandidate | null {
  const postcode = postcodeKey(apartment.postcode);
  for (const key of keysOf(apartment.name, apartment.street)) {
    const numbered = /\d/.test(key);
    const found = candidates.filter((candidate) => candidate.keys.has(key) && (numbered ? !postcode || !candidate.postcode || candidate.postcode === postcode : postcode !== "" && candidate.postcode === postcode));
    if (found.length === 1) return found[0];
    if (found.length > 1) return null;
  }
  return null;
}

// Links apartments nobody has linked or unlinked yet to their one clear match.
// Runs after every sync, and from the Properties page.
export async function autoLinkApartments(actorEmail: string | null = null): Promise<{ linked: number; notMatched: number; error: string | null }> {
  const db = getDb();
  const a = smoobuApartmentsTable;
  const unlinked = and(isNull(a.cohoPropertyReference), isNull(a.propertyId));
  const countUnlinked = async () => (await db.select({ id: a.id }).from(a).where(unlinked)).length;
  const open = await db.select().from(a).where(and(unlinked, isNull(a.linkedBy)));
  if (!open.length) return { linked: 0, notMatched: await countUnlinked(), error: null };
  let candidates: LinkCandidate[];
  try {
    candidates = await linkCandidates();
  } catch (error) {
    return { linked: 0, notMatched: await countUnlinked(), error: error instanceof Error ? error.message : String(error) };
  }
  const linkedIds: number[] = [];
  for (const apartment of open) {
    const match = matchApartment(apartment, candidates);
    if (!match) continue;
    const saved = await db.transaction(async (tx) => {
      const rows = await tx
        .update(a)
        .set({ cohoPropertyReference: match.cohoReference, propertyId: match.propertyId, linkedBy: "auto" })
        .where(and(eq(a.id, apartment.id), unlinked, isNull(a.linkedBy)))
        .returning({ id: a.id });
      if (!rows.length) return false;
      await tx.insert(auditLogTable).values({
        actorEmail,
        action: "smoobu_apartment.auto_link",
        tableName: "smoobu_apartments",
        recordId: String(apartment.smoobuApartmentId),
        before: { name: apartment.name, cohoReference: null, propertyId: null },
        after: { name: apartment.name, cohoReference: match.cohoReference, propertyId: match.propertyId },
      });
      return true;
    });
    if (saved) linkedIds.push(apartment.smoobuApartmentId);
  }
  if (linkedIds.length) {
    const properties = await linkedProperties();
    const t = shortStayBookingsTable;
    for (const apartmentId of new Set(linkedIds)) {
      const propertyId = properties.get(apartmentId);
      if (propertyId) await db.update(t).set({ propertyId }).where(and(eq(t.smoobuApartmentId, apartmentId), isNull(t.propertyId)));
    }
  }
  return { linked: linkedIds.length, notMatched: await countUnlinked(), error: null };
}

function lastSyncRun() {
  const r = integrationSyncRunsTable;
  return getDb()
    .select({ startedAt: r.startedAt, finishedAt: r.finishedAt, status: r.status, error: r.error })
    .from(r)
    .where(and(eq(r.integration, "smoobu"), like(r.trigger, `${SYNC_TRIGGER}:%`)))
    .orderBy(desc(r.startedAt))
    .limit(1)
    .then(([row]) => row);
}

// --- Bookings -----------------------------------------------------------------

const cleaningFeeOf = (elements: Raw[]): number | null => {
  const fees = elements.filter((element) => text(element.type) === "cleaningFee").map((element) => num(element.amount)).filter((n): n is number => n !== null);
  return fees.length ? Math.round(fees.reduce((sum, n) => sum + n, 0) * 100) / 100 : null;
};

async function storeBooking(raw: Raw, properties: Map<number, string>, elements?: Raw[]): Promise<"stored" | "skipped"> {
  const bookingId = text(raw.id);
  const arrival = day(raw.arrival);
  const departure = day(raw.departure);
  if (!bookingId || !arrival || !departure || departure < arrival) return "skipped";
  const t = shortStayBookingsTable;
  // Blocked dates (owner stays, maintenance) are not bookings.
  if (raw["is-blocked-booking"] === true || raw["is-blocked-booking"] === 1) {
    await getDb().delete(t).where(eq(t.smoobuBookingId, bookingId)).catch(() => undefined);
    return "skipped";
  }
  const apartment = obj(raw.apartment);
  const apartmentId = num(apartment.id);
  const modified = text(raw["modified-at"] ?? raw.modifiedAt);
  const modifiedAt = modified && !Number.isNaN(Date.parse(modified.replace(" ", "T"))) ? new Date(modified.replace(" ", "T")) : null;
  const priceElements = elements ?? (Array.isArray(raw.priceElements) ? (raw.priceElements as unknown[]).map(obj) : undefined);
  const price = num(raw.price);
  const values = {
    smoobuBookingId: bookingId,
    smoobuApartmentId: apartmentId,
    apartmentName: text(apartment.name),
    propertyId: apartmentId === null ? null : properties.get(apartmentId) ?? null,
    guestName: text(raw["guest-name"]) ?? "",
    channel: text(obj(raw.channel).name),
    status: text(raw.type) === "cancellation" ? ("cancelled" as const) : ("confirmed" as const),
    arrivalDate: arrival,
    departureDate: departure,
    checkInTime: time(raw["check-in"]),
    checkOutTime: time(raw["check-out"]),
    adults: num(raw.adults),
    children: num(raw.children),
    totalAmount: price === null ? null : price.toFixed(2),
    pricePaid: yesNo(raw["price-paid"]),
    smoobuModifiedAt: modifiedAt,
    // Only replaced when the price elements were read with the booking.
    ...(priceElements ? { cleaningFee: cleaningFeeOf(priceElements)?.toFixed(2) ?? null } : {}),
  };
  const { smoobuBookingId: _key, ...update } = values;
  const [row] = await getDb().insert(t).values(values).onConflictDoUpdate({ target: t.smoobuBookingId, set: update }).returning({ id: t.id, status: t.status, cleaningFee: t.cleaningFee });
  await syncAllowance(row);
  return "stored";
}

// A changeover earns the guest's cleaning fee as the cleaning allowance, which
// is taken off the cleaner's invoice before anything is on-charged.
async function syncAllowance(booking: { id: string; status: string; cleaningFee: string | null }): Promise<void> {
  const a = cleaningAllowancesTable;
  const amount = booking.cleaningFee === null ? 0 : Number(booking.cleaningFee);
  if (booking.status === "cancelled" || !(amount > 0)) {
    // Left in place if an on-charge already uses it.
    await getDb().delete(a).where(eq(a.bookingId, booking.id)).catch(() => undefined);
    return;
  }
  await getDb()
    .insert(a)
    .values({ bookingId: booking.id, amount: amount.toFixed(2), rule: ALLOWANCE_RULE })
    .onConflictDoUpdate({ target: a.bookingId, set: { amount: amount.toFixed(2), rule: ALLOWANCE_RULE, calculatedAt: new Date() } });
}

// One booking, read fresh from Smoobu (after a webhook).
export async function refreshBooking(bookingId: number, properties?: Map<number, string>): Promise<"stored" | "skipped" | "cancelled"> {
  let raw: Raw;
  try {
    raw = obj(await smoobuGet(`/api/reservations/${bookingId}`));
  } catch (error) {
    if (error instanceof SmoobuApiError && error.status === 404) {
      const t = shortStayBookingsTable;
      const rows = await getDb().update(t).set({ status: "cancelled" }).where(eq(t.smoobuBookingId, String(bookingId))).returning({ id: t.id, status: t.status, cleaningFee: t.cleaningFee });
      for (const row of rows) await syncAllowance(row);
      return "cancelled";
    }
    throw error;
  }
  let elements: Raw[] | undefined;
  try {
    elements = listIn(await smoobuGet(`/api/reservations/${bookingId}/price-elements`), "priceElements", "data");
  } catch (error) {
    logger.warn({ bookingId, err: error }, "Smoobu price elements could not be read");
  }
  return storeBooking(raw, properties ?? (await linkedProperties()), elements);
}

// --- Full sync ----------------------------------------------------------------

export type StaysSyncResult = { status: "succeeded" | "failed" | "skipped"; runId: string | null; apartments: number; bookings: number; error: string | null };

let running: Promise<StaysSyncResult> | null = null;

export function syncStays(trigger: "schedule" | "manual"): Promise<StaysSyncResult> {
  if (running) return running.then((result) => ({ ...result, status: "skipped" as const }));
  running = runSync(trigger).finally(() => {
    running = null;
  });
  return running;
}

async function runSync(trigger: "schedule" | "manual"): Promise<StaysSyncResult> {
  const db = getDb();
  const r = integrationSyncRunsTable;
  const [lastGood] = await db
    .select({ startedAt: r.startedAt })
    .from(r)
    .where(and(eq(r.integration, "smoobu"), eq(r.status, "succeeded"), like(r.trigger, `${SYNC_TRIGGER}:%`)))
    .orderBy(desc(r.startedAt))
    .limit(1);
  const [run] = await db.insert(r).values({ integration: "smoobu", trigger: `${SYNC_TRIGGER}:${trigger}` }).returning({ id: r.id });
  let apartments = 0;
  let bookings = 0;
  try {
    apartments = await syncApartments();
    const auto = await autoLinkApartments();
    if (auto.error) logger.warn({ error: auto.error }, "Smoobu apartments could not be matched to properties");
    const properties = await linkedProperties();
    // Changed since the day before the last good run, or the last few months the first time.
    const window = lastGood
      ? { modifiedFrom: addDays(lastGood.startedAt.toISOString().slice(0, 10), -1) }
      : { departureFrom: addDays(ukToday(), -FIRST_SYNC_DAYS) };
    for (let page = 1; page <= 200; page += 1) {
      const payload = obj(await smoobuGet("/api/reservations", { ...window, page, pageSize: 100, showCancellation: true, excludeBlocked: true, includePriceElements: true }));
      for (const raw of listIn(payload, "bookings")) if ((await storeBooking(raw, properties)) === "stored") bookings += 1;
      if (page >= (num(payload.page_count) ?? 1)) break;
    }
    // Online check-in from ChargeAutomation for stays in the last fortnight and
    // the next week. A failure here doesn't fail the Smoobu sync.
    const today = ukToday();
    const guestChecks = await syncGuestChecks(addDays(today, -14), addDays(today, 7)).catch((error: unknown) => {
      logger.warn({ err: error }, "ChargeAutomation online check-ins could not be read");
      return null;
    });
    await db.update(r).set({ status: "succeeded", finishedAt: new Date(), recordsProcessed: bookings, details: { apartments, bookings, guestChecks } }).where(eq(r.id, run.id));
    return { status: "succeeded", runId: run.id, apartments, bookings, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(r).set({ status: "failed", finishedAt: new Date(), recordsProcessed: bookings, details: { apartments, bookings }, error: message.slice(0, 1000) }).where(eq(r.id, run.id)).catch(() => undefined);
    logger.warn({ trigger, err: error }, "Smoobu sync failed");
    return { status: "failed", runId: run.id, apartments, bookings, error: message };
  }
}

// --- Webhook events (forwarded by n8n) ------------------------------------------

const BOOKING_EVENTS = new Set(["newReservation", "updateReservation", "cancelReservation", "deleteReservation"]);

export async function handleSmoobuEvent(body: unknown): Promise<{ action: string; result: string }> {
  const event = obj(body);
  const action = text(event.action) ?? "unknown";
  const data = obj(event.data);
  if (BOOKING_EVENTS.has(action)) {
    const bookingId = num(data.id);
    return { action, result: bookingId === null ? "no booking id" : await refreshBooking(bookingId) };
  }
  if (action === "priceElementCreated" || action === "priceElementUpdated") {
    const bookingId = num(obj(data.booking).id);
    return { action, result: bookingId === null ? "no booking id" : await refreshBooking(bookingId) };
  }
  if (action === "newMessage") {
    threadsCache = null;
    return { action, result: "messages refreshed" };
  }
  // updateRates, onlineCheckInUpdate, priceElementDeleted (no booking id; the hourly sync catches it).
  return { action, result: "ignored" };
}

// --- Guest messages -------------------------------------------------------------

export type GuestThread = { bookingId: string | null; guestName: string | null; apartmentName: string | null; lastMessageAt: string | null; preview: string | null };
export type GuestMessages = { threadsToday: number; unreadMessages: number; threads: GuestThread[]; error: string | null };

const THREADS_TTL_MS = 2 * 60_000;
let threadsCache: { at: number; value: GuestMessages } | null = null;

const plain = (value: string | null) => (value ? value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) || null : null);

// The newest Airbnb, Booking.com and direct-booking conversations. Smoobu lists
// threads newest first, 25 a page, and only gives an unread total for the whole
// account: no unread count or sender per thread (checked October 2026).
export async function guestMessages(): Promise<GuestMessages> {
  if (threadsCache && Date.now() - threadsCache.at < THREADS_TTL_MS) return threadsCache.value;
  try {
    const payload = await smoobuGet("/api/threads", { page_number: 1, page_size: 25 });
    const threads = listIn(payload, "threads", "data", "items").map((thread): GuestThread => {
      const booking = obj(thread.booking);
      const latest = obj(thread.latest_message ?? thread.latestMessage);
      return {
        bookingId: text(booking.id),
        guestName: text(booking.guest_name ?? booking["guest-name"] ?? booking.guestName),
        apartmentName: text(obj(thread.apartment).name ?? obj(booking.apartment).name),
        // "YYYY-MM-DD HH:MM:SS", UK time.
        lastMessageAt: text(latest.created_at)?.replace(" ", "T") ?? null,
        preview: plain(text(latest.text_content) ?? text(latest.html_content) ?? text(latest.subject)),
      };
    });
    const today = ukToday();
    const value = {
      threadsToday: threads.filter((thread) => thread.lastMessageAt?.startsWith(today)).length,
      unreadMessages: num(obj(payload).unread_messages) ?? 0,
      threads: threads.slice(0, 8),
      error: null,
    };
    threadsCache = { at: Date.now(), value };
    return value;
  } catch (error) {
    return { threadsToday: 0, unreadMessages: 0, threads: [], error: error instanceof Error ? error.message : String(error) };
  }
}

// --- Availability ---------------------------------------------------------------

// Free nights, prices and minimum stays from Smoobu rates (GET /api/rates), set
// there by PriceLabs. Read live, directly with the signed key: the n8n gateway
// doesn't allow rates. Read-only: nothing is written back.
const AVAILABILITY_NIGHTS = 14;
const AVAILABILITY_TTL_MS = 10 * 60_000;
const RATES_BATCH = 20;

export type StayNight = { date: string; available: boolean; price: number | null; minStay: number | null };
export type StayAvailability = { from: string; to: string; dates: string[]; freeTonight: number; apartments: { smoobuApartmentId: number; name: string; freeNights: number; nights: StayNight[] }[] };
let availabilityCache: { at: number; value: StayAvailability } | null = null;

export async function stayAvailability(): Promise<StayAvailability> {
  const from = ukToday();
  if (availabilityCache && availabilityCache.value.from === from && Date.now() - availabilityCache.at < AVAILABILITY_TTL_MS) return availabilityCache.value;
  const dates = Array.from({ length: AVAILABILITY_NIGHTS }, (_, index) => addDays(from, index));
  const to = dates[dates.length - 1]!;
  const a = smoobuApartmentsTable;
  const apartments = await getDb().select({ id: a.smoobuApartmentId, name: a.name }).from(a).orderBy(a.name);

  const rates = new Map<string, Raw>();
  for (let start = 0; start < apartments.length; start += RATES_BATCH) {
    const ids = apartments.slice(start, start + RATES_BATCH).map((apartment) => apartment.id);
    const payload = obj(await smoobuGet("/api/rates", { apartments: ids, start_date: from, end_date: to }, { direct: true }));
    for (const [id, days] of Object.entries(obj(payload.data))) rates.set(id, obj(days));
  }

  const rows = apartments.map((apartment) => {
    const days = rates.get(String(apartment.id)) ?? {};
    const nights = dates.map((date): StayNight => {
      const day = obj(days[date]);
      return { date, available: (num(day.available) ?? 0) > 0, price: num(day.price), minStay: num(day.min_length_of_stay) };
    });
    return { smoobuApartmentId: apartment.id, name: apartment.name, freeNights: nights.filter((night) => night.available).length, nights };
  });
  const value = { from, to, dates, freeTonight: rows.filter((row) => row.nights[0]?.available).length, apartments: rows };
  availabilityCache = { at: Date.now(), value };
  return value;
}

// --- Page data ------------------------------------------------------------------

export async function staysOverview() {
  const today = ukToday();
  const end = addDays(today, 7);
  const t = shortStayBookingsTable;
  const a = smoobuApartmentsTable;
  const [rows, apartments, lastRun, messages, guestChecks] = await Promise.all([
    getDb()
      .select()
      .from(t)
      .where(and(ne(t.status, "cancelled"), lte(t.arrivalDate, end), gte(t.departureDate, today)))
      .orderBy(t.arrivalDate),
    getDb().select({ id: a.smoobuApartmentId, name: a.name, coho: a.cohoPropertyReference, propertyId: a.propertyId }).from(a),
    lastSyncRun(),
    guestMessages(),
    guestChecksReceived(),
  ]);
  const tomorrow = addDays(today, 1);
  const checksOf = await guestChecksFor(rows.flatMap((row) => (row.smoobuBookingId ? [{ smoobuBookingId: row.smoobuBookingId, arrival: row.arrivalDate }] : [])), today, tomorrow);
  const nameOf = new Map(apartments.map((apartment) => [apartment.id, apartment.name]));
  const bookings = rows.map((row) => ({
    id: row.smoobuBookingId ?? row.id,
    apartmentId: row.smoobuApartmentId,
    apartmentName: (row.smoobuApartmentId !== null ? nameOf.get(row.smoobuApartmentId) : null) ?? row.apartmentName ?? "Unknown apartment",
    guestName: row.guestName || null,
    channel: row.channel,
    arrival: row.arrivalDate,
    departure: row.departureDate,
    nights: Math.round((Date.parse(row.departureDate) - Date.parse(row.arrivalDate)) / 86_400_000),
    guests: (row.adults ?? 0) + (row.children ?? 0) || null,
    checkInTime: row.checkInTime,
    checkOutTime: row.checkOutTime,
    price: row.totalAmount === null ? null : Number(row.totalAmount),
    pricePaid: row.pricePaid,
    cleaningFee: row.cleaningFee === null ? null : Number(row.cleaningFee),
    checks: (row.smoobuBookingId ? checksOf.get(row.smoobuBookingId) : undefined) ?? null,
  }));
  const changeovers = bookings
    .filter((booking) => booking.departure >= today && booking.departure <= end)
    .map((leaving) => {
      const arriving = bookings.find((other) => other.apartmentId === leaving.apartmentId && other.arrival === leaving.departure && other.id !== leaving.id);
      return {
        date: leaving.departure,
        apartmentName: leaving.apartmentName,
        leavingGuest: leaving.guestName,
        checkOutTime: leaving.checkOutTime,
        arrivingGuest: arriving ? arriving.guestName : null,
        checkInTime: arriving?.checkInTime ?? null,
        sameDay: Boolean(arriving),
        cleaningFee: leaving.cleaningFee,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || Number(b.sameDay) - Number(a.sameDay) || a.apartmentName.localeCompare(b.apartmentName));
  return {
    asOf: today,
    apartments: apartments.length,
    unlinkedApartments: apartments.filter((apartment) => !apartment.coho && !apartment.propertyId).length,
    lastSync: lastRun ? { at: (lastRun.finishedAt ?? lastRun.startedAt).toISOString(), status: lastRun.status, error: lastRun.error } : null,
    counts: {
      arrivingToday: bookings.filter((booking) => booking.arrival === today).length,
      leavingToday: bookings.filter((booking) => booking.departure === today).length,
      inHouse: bookings.filter((booking) => booking.arrival <= today && booking.departure > today).length,
      changeoversThisWeek: changeovers.length,
      notReady: bookings.filter((booking) => booking.arrival >= today && booking.arrival <= tomorrow && booking.checks?.issues.length).length,
    },
    bookings,
    changeovers,
    messages,
    guestChecks,
  };
}
