import { and, asc, count, eq, gte, inArray, lte, ne, or, isNull, lt, sql } from "drizzle-orm";
import { auditLogTable, checklistStepsTable, checklistTicksTable, cohoActionsTable, getDb, shortStayBookingsTable } from "@workspace/db";
import { ukToday } from "./performance";
import { addDays, guestMessages } from "./stays";

// Staff daily checklist (/checklist). The list is shared by the office: anyone
// can tick a step for today, and each tick, untick and change to the steps is
// written to audit_log. Days run on UK time, so the list starts fresh at
// midnight in London. Past days are read-only.

export class ChecklistError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

type Staff = { email: string; userId: string | null };
type RequestInfo = { requestId: string | null; ipAddress: string | null };

// The office's checklists as first written (Nov 2026); staff can change them on
// the page. A section is added once, when no step of it exists yet (so a section
// whose steps were all removed isn't put back).
const SMOOBU_INBOX = "https://login.smoobu.com";
const DEFAULT_SECTIONS: { section: string; steps: { title: string; detail: string | null; link: string | null; live: string | null }[] }[] = [
  { section: "Daily operations", steps: [
    { title: "Check Smoobu for today and tomorrow", detail: "Check-outs, check-ins and same-day changeovers for each property.", link: "/stays#today", live: "stays" },
    { title: "Update the tracker", detail: "Update items, or add new ones to the tracker straight away.", link: "/actions", live: null },
    { title: "Finish outstanding actions", detail: "Work with guests, the team and maintenance until each action is complete.", link: "/actions", live: "actions" },
  ] },
  { section: "Guest comms", steps: [
    { title: "Airbnb: check and reply", detail: "Routine check of Airbnb guest messages, and reply.", link: SMOOBU_INBOX, live: "guest_messages" },
    { title: "Booking.com: check and reply", detail: "Routine check of Booking.com guest messages, and reply.", link: SMOOBU_INBOX, live: null },
    { title: "WhatsApp: check and reply", detail: "Routine check of WhatsApp messages, and reply.", link: "https://web.whatsapp.com", live: null },
    { title: "OpenRent: check and reply", detail: "Routine check of OpenRent messages, and reply.", link: "https://www.openrent.co.uk", live: null },
    { title: "Email: check and reply", detail: "Routine check of the email inbox, and reply.", link: "https://outlook.office.com/mail/", live: null },
    { title: "Sort and assign mail in the inbox", detail: "File each email and assign it to the right person.", link: "https://outlook.office.com/mail/", live: null },
    { title: "No message left without action", detail: "Before ticking, make sure no message on any channel above is left unanswered or not actioned.", link: null, live: null },
  ] },
];
const SECTION_ORDER = DEFAULT_SECTIONS.map((item) => item.section);
const sectionRank = (section: string) => { const index = SECTION_ORDER.indexOf(section); return index === -1 ? SECTION_ORDER.length : index; };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function checkLink(link: string | null | undefined): string | null {
  const value = link?.trim();
  if (!value) return null;
  if (/^\/(?!\/)/.test(value) || /^https:\/\/[^\s]+$/i.test(value)) return value;
  throw new ChecklistError("A link must be a page in the app (starting with /) or a full https:// address.");
}

async function steps() {
  const db = getDb();
  const read = () => db.select().from(checklistStepsTable).orderBy(asc(checklistStepsTable.position));
  let rows = await read();
  if (DEFAULT_SECTIONS.some((item) => !rows.some((row) => row.section === item.section))) {
    await db.transaction(async (tx) => {
      // One request adds missing sections at a time.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('checklist_steps_seed'))`);
      const present = new Set((await tx.selectDistinct({ section: checklistStepsTable.section }).from(checklistStepsTable)).map((row) => row.section));
      const missing = DEFAULT_SECTIONS.filter((item) => !present.has(item.section));
      if (missing.length) await tx.insert(checklistStepsTable).values(missing.flatMap((item) => item.steps.map((step, position) => ({ ...step, section: item.section, position }))));
    });
    rows = await read();
  }
  return rows.sort((a, b) => sectionRank(a.section) - sectionRank(b.section) || a.section.localeCompare(b.section) || a.position - b.position);
}

// Arrivals, departures and same-day changeovers today and tomorrow, from the Smoobu bookings the app keeps.
async function staysFigure(today: string): Promise<string> {
  const tomorrow = addDays(today, 1);
  const t = shortStayBookingsTable;
  const rows = await getDb()
    .select({ apartmentId: t.smoobuApartmentId, apartmentName: t.apartmentName, arrival: t.arrivalDate, departure: t.departureDate })
    .from(t)
    .where(and(ne(t.status, "cancelled"), or(and(gte(t.arrivalDate, today), lte(t.arrivalDate, tomorrow)), and(gte(t.departureDate, today), lte(t.departureDate, tomorrow)))));
  const day = (date: string) => {
    const apartment = (row: (typeof rows)[number]) => String(row.apartmentId ?? row.apartmentName ?? "");
    const ins = rows.filter((row) => row.arrival === date);
    const outs = rows.filter((row) => row.departure === date);
    const leaving = new Set(outs.map(apartment));
    const sameDay = new Set(ins.map(apartment).filter((id) => leaving.has(id))).size;
    return `${ins.length} in, ${outs.length} out${sameDay ? `, ${sameDay} same day` : ""}`;
  };
  return `Today ${day(today)} · Tomorrow ${day(tomorrow)}`;
}

// COHO actions not completed and not snoozed, from the app's copy of COHO.
async function actionsFigure(): Promise<string> {
  const a = cohoActionsTable;
  const [row] = await getDb()
    .select({ open: count() })
    .from(a)
    .where(and(ne(a.status, "completed"), or(eq(a.snoozed, false), isNull(a.snoozedUntil), lt(a.snoozedUntil, new Date()))));
  return `${plural(Number(row?.open ?? 0), "open action")} in COHO`;
}

// Smoobu's unread total covers Airbnb, Booking.com and direct guests together (cached in lib/stays.ts).
async function guestMessagesFigure(): Promise<string | null> {
  const messages = await guestMessages();
  if (messages.error) return null;
  return `${plural(messages.unreadMessages, "unread message")} in Smoobu (Airbnb and Booking.com) · ${plural(messages.threadsToday, "conversation")} today`;
}

async function liveFigure(live: string | null, today: string): Promise<string | null> {
  try {
    if (live === "guest_messages") return await guestMessagesFigure();
    if (live === "stays") return await staysFigure(today);
    if (live === "actions") return await actionsFigure();
  } catch {
    return null;
  }
  return null;
}

export async function checklist(requestedDay?: string) {
  const today = ukToday();
  const day = requestedDay && requestedDay <= today ? requestedDay : today;
  const all = await steps();
  const ticks = await getDb().select().from(checklistTicksTable).where(eq(checklistTicksTable.day, day));
  const tickOf = new Map(ticks.map((tick) => [tick.stepId, tick]));
  // Past days also show steps switched off since, if they were ticked that day.
  const shown = all.filter((step) => step.isActive || tickOf.has(step.id));
  const items = await Promise.all(shown.map(async (step) => {
    const tick = tickOf.get(step.id);
    const live = day === today ? await liveFigure(step.live, today) : null;
    return {
      id: step.id,
      section: step.section,
      title: step.title,
      detail: step.detail,
      link: step.link,
      live,
      liveWarn: step.live === "guest_messages" && /^[1-9]/.test(live ?? ""),
      doneBy: tick?.doneBy ?? null,
      doneAt: tick?.doneAt.toISOString() ?? null,
      note: tick?.note ?? null,
    };
  }));
  const sections = [...new Set([...all.filter((step) => step.isActive).map((step) => step.section), ...items.map((item) => item.section)])];
  return { day, today, done: items.filter((item) => item.doneBy).length, total: items.length, sections, steps: items };
}

export async function tickStep(input: { stepId: string; day: string; done: boolean; note?: string | null }, staff: Staff, request: RequestInfo) {
  const today = ukToday();
  if (input.day !== today) throw new ChecklistError("Only today's checklist can be ticked.");
  const db = getDb();
  const [step] = await db.select().from(checklistStepsTable).where(eq(checklistStepsTable.id, input.stepId));
  if (!step) throw new ChecklistError("That step isn't on the checklist.", 404);
  const t = checklistTicksTable;
  const note = input.note?.trim() || null;
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(t).where(and(eq(t.stepId, step.id), eq(t.day, today)));
    if (input.done) {
      await tx.insert(t).values({ stepId: step.id, day: today, doneBy: staff.email, note })
        .onConflictDoUpdate({ target: [t.stepId, t.day], set: { note, doneBy: staff.email, doneAt: new Date() } });
    } else {
      await tx.delete(t).where(and(eq(t.stepId, step.id), eq(t.day, today)));
    }
    await tx.insert(auditLogTable).values({
      actorEmail: staff.email, actorUserId: staff.userId, action: input.done ? "checklist.tick" : "checklist.untick",
      tableName: "checklist_ticks", recordId: step.id,
      before: before ? { day: today, step: step.title, doneBy: before.doneBy, note: before.note } : null,
      after: input.done ? { day: today, step: step.title, doneBy: staff.email, note } : null,
      requestId: request.requestId, ipAddress: request.ipAddress,
    });
  });
  return checklist(today);
}

// Replaces the steps of one section; other sections are left as they are.
export async function saveSteps(input: { section: string; steps: { id?: string | null; title: string; detail?: string | null; link?: string | null }[] }, staff: Staff, request: RequestInfo) {
  const db = getDb();
  const section = input.section.trim();
  if (!section) throw new ChecklistError("The list needs a name.");
  const cleaned = input.steps.map((step) => ({ id: step.id ?? null, title: step.title.trim(), detail: step.detail?.trim() || null, link: checkLink(step.link) }));
  if (cleaned.some((step) => !step.title)) throw new ChecklistError("Every step needs a title.");
  const existing = (await steps()).filter((step) => step.section === section);
  const known = new Set(existing.map((step) => step.id));
  if (cleaned.some((step) => step.id && !known.has(step.id))) throw new ChecklistError("One of the steps no longer exists. Reload the page and try again.", 409);
  await db.transaction(async (tx) => {
    const kept = new Set<string>();
    for (const [position, step] of cleaned.entries()) {
      if (step.id) {
        kept.add(step.id);
        await tx.update(checklistStepsTable).set({ position, title: step.title, detail: step.detail, link: step.link, isActive: true }).where(eq(checklistStepsTable.id, step.id));
      } else {
        await tx.insert(checklistStepsTable).values({ section, position, title: step.title, detail: step.detail, link: step.link });
      }
    }
    const dropped = existing.filter((step) => step.isActive && !kept.has(step.id)).map((step) => step.id);
    if (dropped.length) await tx.update(checklistStepsTable).set({ isActive: false }).where(inArray(checklistStepsTable.id, dropped));
    await tx.insert(auditLogTable).values({
      actorEmail: staff.email, actorUserId: staff.userId, action: "checklist.steps.update", tableName: "checklist_steps", recordId: section,
      before: { section, steps: existing.filter((step) => step.isActive).map(({ title, detail, link }) => ({ title, detail, link })) },
      after: { section, steps: cleaned.map(({ title, detail, link }) => ({ title, detail, link })) },
      requestId: request.requestId, ipAddress: request.ipAddress,
    });
  });
  return checklist();
}
