import { eq, inArray, sql } from "drizzle-orm";
import { getDb, guestChecksTable, paymentsTable, shortStayBookingsTable, type GuestCheck } from "@workspace/db";
import { readChargeAutomationGatewayEnv, smoobuMode } from "./integrations-env";
import { logger } from "./logger";
import { refreshBooking } from "./stays";

// Guest checks for Hinkley Homes Stays, from ChargeAutomation. Smoobu sends
// each booking to ChargeAutomation, which runs online check-in, ID, card and
// security deposit checks and takes payments. Its webhooks reach n8n, which
// forwards them here. The app only records what happened: it never charges,
// refunds or releases a deposit, and keeps no guest documents or card data.
// ChargeAutomation doesn't sign webhooks; the n8n path is secret, and online
// check-in is confirmed by re-reading the booking through the n8n gateway.

type Raw = Record<string, unknown>;
const obj = (value: unknown): Raw => (value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : {});
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : null);
const num = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};
const first = (value: unknown): Raw => obj(Array.isArray(value) ? value[0] : value);

export class ChargeAutomationError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

// A GET through the n8n gateway, which answers { ok, status, data, error }.
export async function chargeAutomationGet(path: string, query: Record<string, string | number> = {}): Promise<unknown> {
  const gateway = readChargeAutomationGatewayEnv();
  if (!gateway) throw new ChargeAutomationError("The n8n ChargeAutomation gateway isn't set up (N8N_CHARGEAUTOMATION_GATEWAY_URL).");
  let response: Response;
  try {
    response = await fetch(gateway.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-Hinkley-Gateway-Key": gateway.key },
      body: JSON.stringify({ path, query }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    throw new ChargeAutomationError(`Could not reach the n8n ChargeAutomation gateway: ${(error as Error).message}`);
  }
  const reply = obj(await response.json().catch(() => null));
  if (typeof reply.status !== "number") {
    throw new ChargeAutomationError(
      response.status === 401 || response.status === 403
        ? "The n8n ChargeAutomation gateway rejected the key."
        : response.status === 404
          ? "The n8n ChargeAutomation gateway workflow was not found or is not published."
          : `The n8n ChargeAutomation gateway returned an unexpected HTTP ${response.status} response.`,
    );
  }
  if (reply.status >= 400) {
    const reason = text(reply.error) ?? text(obj(reply.data).message) ?? "";
    throw new ChargeAutomationError(`ChargeAutomation returned HTTP ${reply.status}${reason ? `: ${reason}` : ""}.`, reply.status);
  }
  return reply.data;
}

// --- Events -----------------------------------------------------------------------

type Patch = Partial<Omit<GuestCheck, "id" | "smoobuBookingId" | "createdAt" | "updatedAt">>;

// Online check-in done, according to ChargeAutomation itself. Undefined when it
// can't be asked (no gateway, or no ChargeAutomation booking id).
async function confirmedPreCheckin(caBookingId: string | null): Promise<boolean | undefined> {
  if (!caBookingId || !readChargeAutomationGatewayEnv()) return undefined;
  try {
    const booking = first(obj(await chargeAutomationGet(`/api/v1/booking/${encodeURIComponent(caBookingId)}`)).data);
    return booking.pre_checkin_completed === true || booking.pre_checkin_completed === 1 || booking.pre_checkin_completed === "1";
  } catch (error) {
    logger.warn({ caBookingId, err: error }, "ChargeAutomation booking could not be read to confirm online check-in");
    return undefined;
  }
}

// Makes sure the Smoobu booking is in the app, so the payment can be tied to it.
async function stayBooking(smoobuBookingId: string): Promise<{ id: string } | undefined> {
  const t = shortStayBookingsTable;
  const find = async () => (await getDb().select({ id: t.id }).from(t).where(eq(t.smoobuBookingId, smoobuBookingId)))[0];
  const found = await find();
  if (found || !smoobuMode() || num(smoobuBookingId) === null) return found;
  await refreshBooking(num(smoobuBookingId)!).catch((error: unknown) => logger.warn({ smoobuBookingId, err: error }, "Smoobu booking could not be read for a ChargeAutomation event"));
  return find();
}

export async function handleChargeAutomationEvent(body: unknown): Promise<{ event: string; result: string }> {
  const envelope = first(body);
  const event = text(envelope.event) ?? "unknown";
  const data = first(envelope.data);
  const booking = obj(data.booking);
  const caBookingId = text(event === "booking.created" || event === "booking.pre_checkin.completed" ? data.id : (booking.id ?? data.booking_id));
  // Bookings that come from Smoobu keep the Smoobu booking id as their
  // ChargeAutomation id (external_id stays empty), checked October 2026.
  const smoobuBookingId = text(data.pms_booking_id ?? booking.pms_booking_id ?? data.external_id ?? booking.external_id) ?? caBookingId;
  if (!smoobuBookingId) return { event, result: "no Smoobu booking id" };

  const patch: Patch = {};
  let payment: { status: "paid" | "failed"; ref: string | null; amount: number | null; currency: string | null } | null = null;
  switch (event) {
    case "booking.created":
      break;
    case "booking.pre_checkin.completed": {
      const confirmed = await confirmedPreCheckin(caBookingId);
      if (confirmed === false) return { event, result: "not confirmed by ChargeAutomation" };
      patch.preCheckinCompletedAt = new Date();
      break;
    }
    case "booking.payment.successful":
    case "booking.payment.failed":
      patch.paymentStatus = event.endsWith("successful") ? "successful" : "failed";
      payment = { status: event.endsWith("successful") ? "paid" : "failed", ref: text(data.charge_ref_no), amount: num(data.price), currency: text(data.currency_code) };
      break;
    case "booking.security_deposit.authorized":
    case "booking.security_deposit.failed":
      patch.depositStatus = event.endsWith("authorized") ? "authorized" : "failed";
      patch.depositAmount = num(data.hold_amount)?.toFixed(2) ?? null;
      break;
    case "booking.card_verification.successful":
    case "booking.card_verification.failed":
      patch.cardVerification = event.endsWith("successful") ? "successful" : "failed";
      break;
    case "booking.id_verification.succeeded":
    case "booking.id_verification.failed": {
      const verification = obj(data.id_verification);
      patch.idVerification = event.endsWith("succeeded") ? "succeeded" : "failed";
      patch.idVerificationNote = text(verification.verification_message)?.slice(0, 300) ?? null;
      break;
    }
    default:
      // Upsells and anything new: not used yet.
      return { event, result: "ignored" };
  }

  const g = guestChecksTable;
  const values = { ...patch, ...(caBookingId ? { chargeAutomationBookingId: caBookingId } : {}), lastEventAt: new Date() };
  await getDb().insert(g).values({ smoobuBookingId, ...values }).onConflictDoUpdate({ target: g.smoobuBookingId, set: values });

  const stay = await stayBooking(smoobuBookingId);
  if (stay && caBookingId) {
    const t = shortStayBookingsTable;
    await getDb().update(t).set({ chargeAutomationReference: caBookingId }).where(eq(t.id, stay.id)).catch(() => undefined);
  }
  // Xero stays the ledger; this row is what ChargeAutomation says it took.
  if (payment?.ref && payment.amount !== null) {
    const p = paymentsTable;
    const row = {
      source: "charge_automation" as const,
      externalId: payment.ref,
      bookingId: stay?.id ?? null,
      amount: payment.amount.toFixed(2),
      currency: (payment.currency ?? "GBP").toUpperCase(),
      status: payment.status,
      paidAt: payment.status === "paid" ? new Date() : null,
    };
    const { source: _source, externalId: _externalId, ...update } = row;
    await getDb().insert(p).values(row).onConflictDoUpdate({ target: [p.source, p.externalId], set: update });
  }
  return { event, result: stay ? "recorded" : "recorded (booking not in Smoobu yet)" };
}

// --- Catch-up with every Stays sync ---------------------------------------------

// ChargeAutomation's booking list says whether each guest has done online
// check-in, so that is read for recent and coming stays without waiting for a
// webhook. The other checks (payments, deposits, ID) only come by webhook.
export async function syncGuestChecks(from: string, to: string): Promise<number> {
  if (!readChargeAutomationGatewayEnv()) return 0;
  const g = guestChecksTable;
  let stored = 0;
  // 25 a page (ChargeAutomation's maximum); 60 reads a minute allowed.
  for (let page = 1; page <= 10; page += 1) {
    const payload = obj(await chargeAutomationGet("/api/v1/bookings", { from, to, page, page_size: 25 }));
    const items = Array.isArray(payload.data) ? payload.data.map(obj) : [];
    for (const item of items) {
      const caBookingId = text(item.id);
      const smoobuBookingId = text(item.external_id) ?? caBookingId;
      if (!smoobuBookingId || num(item.status) === 0) continue;
      const done = item.pre_checkin_completed === true || item.pre_checkin_completed === 1;
      const values = { chargeAutomationBookingId: caBookingId, preCheckinCompletedAt: done ? sql`coalesce(${g.preCheckinCompletedAt}, now())` : null };
      await getDb()
        .insert(g)
        .values({ smoobuBookingId, chargeAutomationBookingId: caBookingId, preCheckinCompletedAt: done ? new Date() : null })
        .onConflictDoUpdate({ target: g.smoobuBookingId, set: values });
      stored += 1;
    }
    if (page >= (num(obj(payload.meta).last_page) ?? 1)) break;
  }
  return stored;
}

// --- Page data --------------------------------------------------------------------

export type StayGuestChecks = {
  preCheckin: boolean;
  idVerification: "succeeded" | "failed" | null;
  cardVerification: "successful" | "failed" | null;
  deposit: "authorized" | "failed" | null;
  depositAmount: number | null;
  payment: "successful" | "failed" | null;
  issues: string[];
};

const oneOf = <T extends string>(value: string | null, allowed: readonly T[]): T | null => (allowed.includes(value as T) ? (value as T) : null);

// Checks for these Smoobu bookings, with what still needs sorting. Online
// check-in only counts as missing once the guest is due within a day.
export async function guestChecksFor(bookings: { smoobuBookingId: string; arrival: string }[], dueBy: string): Promise<Map<string, StayGuestChecks>> {
  const ids = bookings.map((booking) => booking.smoobuBookingId);
  if (!ids.length) return new Map();
  const rows = await getDb().select().from(guestChecksTable).where(inArray(guestChecksTable.smoobuBookingId, ids));
  const arrivalOf = new Map(bookings.map((booking) => [booking.smoobuBookingId, booking.arrival]));
  return new Map(
    rows.map((row) => {
      const checks = {
        preCheckin: row.preCheckinCompletedAt !== null,
        idVerification: oneOf(row.idVerification, ["succeeded", "failed"] as const),
        cardVerification: oneOf(row.cardVerification, ["successful", "failed"] as const),
        deposit: oneOf(row.depositStatus, ["authorized", "failed"] as const),
        depositAmount: row.depositAmount === null ? null : Number(row.depositAmount),
        payment: oneOf(row.paymentStatus, ["successful", "failed"] as const),
      };
      const issues = [
        checks.payment === "failed" && "Payment failed",
        checks.deposit === "failed" && "Deposit failed",
        checks.idVerification === "failed" && "ID check failed",
        checks.cardVerification === "failed" && "Card check failed",
        !checks.preCheckin && (arrivalOf.get(row.smoobuBookingId) ?? "9999") <= dueBy && "Online check-in not done",
      ].filter((issue): issue is string => Boolean(issue));
      return [row.smoobuBookingId, { ...checks, issues }];
    }),
  );
}

// Show guest checks once ChargeAutomation is connected or has sent anything.
export async function guestChecksReceived(): Promise<boolean> {
  if (readChargeAutomationGatewayEnv()) return true;
  return (await getDb().select({ id: guestChecksTable.id }).from(guestChecksTable).limit(1)).length > 0;
}
