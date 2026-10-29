import { eq, inArray, isNull, or } from "drizzle-orm";
import { auditLogTable, getDb, integrationSyncRunsTable, rentMatchActionsTable } from "@workspace/db";
import { CohoApiError, cohoRequest } from "./coho-api";
import { refreshCohoAction } from "./coho-actions-sync";
import { logger } from "./logger";
import { matchReason, rentMatchingData, suggestPayments, ukToday, type BankLine, type OverdueTenancy } from "./rent-matching";

// Tells staff in COHO that rent is ready to match. For each bank line the Rent
// bank feed suggests as an overdue rent payment, a custom COHO action is raised
// on that property and room ("Match rent: £650.00 from J Smith"). Once COHO
// shows the line as matched, or it no longer looks like that rent, the action
// is completed again. COHO's API can't do the matching itself, so staff still
// reconcile in COHO (Transactions → Reconcile transactions).
// Run by the n8n schedule (POST /integrations/coho/rent-match-actions).

export type RentMatchActionsResult = {
  status: "succeeded" | "failed";
  created: number;
  closed: number;
  open: number;
  waiting: number;
  error: string | null;
};

// Keeps the first run (and any backlog) from flooding COHO's Actions list.
const MAX_NEW_PER_RUN = 20;
const TRIGGER_PREFIX = "rent-match-actions:";

const pence = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const longDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const formatDate = (date: string) => longDate.format(new Date(`${date}T12:00:00Z`));

// Same window as the Rent bank feed (the 1st of the month 11 months ago), so both share one COHO read.
function feedStart(today: string) {
  const [year, month] = today.split("-").map(Number);
  return new Date(Date.UTC(year, month - 12, 1)).toISOString().slice(0, 10);
}

function actionText(line: BankLine, arrear: OverdueTenancy) {
  const where = [arrear.propertyName, arrear.roomName].filter(Boolean).join(", ");
  const title = `Match rent: ${pence.format(line.amount)} from ${line.payer ?? "unknown payer"}`.slice(0, 100);
  const message = [
    `A bank payment of ${pence.format(line.amount)} on ${formatDate(line.date)}${line.reference ? ` (ref ${line.reference})` : ""} looks like the overdue rent for ${arrear.tenantName ?? "the tenant"} at ${where}.`,
    matchReason(arrear, line),
    "Reconcile it in Transactions → Reconcile transactions. This action completes itself once the payment is matched.",
  ].join(" ");
  return { title, message: message.slice(0, 400) };
}

async function audit(action: string, reference: string, before: unknown, after: unknown) {
  await getDb()
    .insert(auditLogTable)
    .values({ actorEmail: null, actorUserId: null, action, tableName: "coho_actions", recordId: reference, before, after })
    .catch((error: unknown) => logger.error({ err: error, action, reference }, "Could not write the audit log entry"));
}

const actionPath = (reference: string, suffix = "") => `/actions/${encodeURIComponent(reference)}${suffix}`;

let running: Promise<RentMatchActionsResult> | null = null;
export function syncRentMatchActions(trigger: "schedule" | "manual"): Promise<RentMatchActionsResult> {
  running ??= run(trigger).finally(() => {
    running = null;
  });
  return running;
}

async function run(trigger: string): Promise<RentMatchActionsResult> {
  const db = getDb();
  const [syncRun] = await db
    .insert(integrationSyncRunsTable)
    .values({ integration: "coho", trigger: `${TRIGGER_PREFIX}${trigger}` })
    .returning({ id: integrationSyncRunsTable.id });
  const t = rentMatchActionsTable;
  let created = 0, closed = 0;
  try {
    const today = ukToday();
    const { lines, arrears } = await rentMatchingData(feedStart(today), true);
    const byTenancy = new Map(arrears.map((arrear) => [arrear.tenancyGuid, arrear]));
    const suggested = [...suggestPayments(arrears, lines, today)].map(([tenancyGuid, line]) => ({ line, arrear: byTenancy.get(tenancyGuid)! }));
    const key = (lineId: string, tenancyGuid: string) => `${lineId}|${tenancyGuid}`;
    const current = new Set(suggested.map(({ line, arrear }) => key(line.id, arrear.tenancyGuid)));
    const lineById = new Map(lines.map((line) => [line.id, line]));

    const rows = await db
      .select()
      .from(t)
      .where(or(isNull(t.closedAt), suggested.length ? inArray(t.bankLineGuid, suggested.map(({ line }) => line.id)) : undefined));
    const known = new Set(rows.map((row) => key(row.bankLineGuid, row.tenancyGuid)));

    // Complete the actions whose payment has been matched or no longer looks like that rent.
    for (const row of rows) {
      if (row.closedAt || current.has(key(row.bankLineGuid, row.tenancyGuid))) continue;
      const status = lineById.get(row.bankLineGuid)?.status;
      const reason = status === "matched" || status === "excluded" ? status : "no_longer_suggested";
      if (row.cohoActionReference) {
        try {
          await cohoRequest("PATCH", actionPath(row.cohoActionReference, "/status"), { status: "COMPLETED" });
        } catch (error) {
          // Already completed or deleted in COHO counts as done; anything else is retried next run.
          if (!(error instanceof CohoApiError && (error.status === 400 || error.status === 404))) {
            logger.warn({ err: error, reference: row.cohoActionReference }, "Rent match action could not be completed in COHO");
            continue;
          }
        }
        await refreshCohoAction(row.cohoActionReference).catch(() => undefined);
        await audit("rent_match_action.complete", row.cohoActionReference, { status: "open" }, { status: "completed", reason });
      }
      await db.update(t).set({ closedAt: new Date(), closedReason: reason }).where(eq(t.id, row.id));
      closed += 1;
    }

    // Raise an action for each new suggestion, oldest payment first.
    const fresh = suggested
      .filter(({ line, arrear }) => !known.has(key(line.id, arrear.tenancyGuid)))
      .sort((a, b) => a.line.date.localeCompare(b.line.date));
    for (const { line, arrear } of fresh.slice(0, MAX_NEW_PER_RUN)) {
      // Claim the line first so a crash between COHO and the database can't raise it twice.
      const [claim] = await db
        .insert(t)
        .values({ bankLineGuid: line.id, tenancyGuid: arrear.tenancyGuid, cohoPropertyReference: arrear.propertyReference || null, amount: String(line.amount) })
        .onConflictDoNothing()
        .returning({ id: t.id });
      if (!claim) continue;
      const { title, message } = actionText(line, arrear);
      let reference: string;
      try {
        const result = (await cohoRequest("POST", "/actions", {
          title,
          message,
          dueDate: new Date().toISOString(),
          status: "NEW",
          propertyReference: arrear.propertyReference || null,
          roomReference: arrear.propertyReference ? arrear.roomReference : null,
        })) as { reference?: unknown };
        if (typeof result.reference !== "string" || !result.reference) throw new CohoApiError("COHO did not return the new action's reference.");
        reference = result.reference;
      } catch (error) {
        await db.delete(t).where(eq(t.id, claim.id));
        throw error;
      }
      await db.update(t).set({ cohoActionReference: reference }).where(eq(t.id, claim.id));
      await refreshCohoAction(reference).catch((error: unknown) => logger.warn({ err: error, reference }, "Rent match action created but not yet mirrored"));
      await audit("rent_match_action.create", reference, null, { title, bankLine: line.id, tenancyGuid: arrear.tenancyGuid });
      created += 1;
    }

    const waiting = Math.max(fresh.length - MAX_NEW_PER_RUN, 0);
    const open = await db.$count(t, isNull(t.closedAt));
    const result: RentMatchActionsResult = { status: "succeeded", created, closed, open, waiting, error: null };
    await db
      .update(integrationSyncRunsTable)
      .set({ status: "succeeded", finishedAt: new Date(), recordsProcessed: created + closed, details: { created, closed, open, waiting } })
      .where(eq(integrationSyncRunsTable.id, syncRun.id));
    logger.info(result, "Rent match actions synced");
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "The rent match actions could not be synced.";
    await db
      .update(integrationSyncRunsTable)
      .set({ status: "failed", finishedAt: new Date(), recordsProcessed: created + closed, error: message, details: { created, closed } })
      .where(eq(integrationSyncRunsTable.id, syncRun.id));
    logger.warn({ err: error, created, closed }, "Rent match actions sync failed");
    return { status: "failed", created, closed, open: 0, waiting: 0, error: message };
  }
}

// Bank line id -> COHO action reference, for the open actions (shown on the Rent bank feed).
export async function openRentMatchActions(): Promise<Map<string, string>> {
  const t = rentMatchActionsTable;
  const rows = await getDb()
    .select({ bankLineGuid: t.bankLineGuid, reference: t.cohoActionReference })
    .from(t)
    .where(isNull(t.closedAt));
  return new Map(rows.filter((row) => row.reference).map((row) => [row.bankLineGuid, row.reference!]));
}
