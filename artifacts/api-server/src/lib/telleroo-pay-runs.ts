import { desc, gte, max, notInArray, or } from "drizzle-orm";
import { getDb, tellerooEventsTable, tellerooPayRunsTable } from "@workspace/db";
import { payeeChecks } from "./telleroo-payees";

// Pay runs for the Supplier bills page. The app never calls Telleroo: the n8n
// workflow "Telleroo events (production)" saves each webhook and re-reads the
// pay run into telleroo_pay_runs (every 30 minutes while it is open), and this
// only reads those rows from Supabase.

const CLOSED = ["paid", "cancelled"];
const RECENT_DAYS = 60;
const LIMIT = 100;

const amount = (value: string | null) => (value === null ? null : Number(value));
const round = (value: number) => Math.round(value * 100) / 100;
const ukMonth = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date()).slice(0, 7);
const ukMonthOf = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(date).slice(0, 7);

export async function payRuns() {
  const db = getDb();
  const t = tellerooPayRunsTable;
  const since = new Date(Date.now() - RECENT_DAYS * 86_400_000);
  const [rows, [last], payees] = await Promise.all([
    db.select().from(t).where(or(notInArray(t.status, CLOSED), gte(t.updatedAt, since))).orderBy(desc(t.tellerooCreatedAt), desc(t.createdAt)).limit(LIMIT),
    db.select({ at: max(tellerooEventsTable.receivedAt) }).from(tellerooEventsTable),
    payeeChecks(),
  ]);
  const open = rows.filter((row) => !CLOSED.includes(row.status));
  const month = ukMonth();
  return {
    asOf: new Date().toISOString(),
    open: open.length,
    awaitingApproval: rows.filter((row) => row.status === "awaiting_approval").length,
    openAmount: round(open.reduce((sum, row) => sum + (amount(row.requestedAmount) ?? 0), 0)),
    paidThisMonth: round(
      rows
        .filter((row) => ukMonthOf(row.tellerooCreatedAt ?? row.createdAt) === month)
        .reduce((sum, row) => sum + (amount(row.paidAmount) ?? 0), 0),
    ),
    lastEventAt: last?.at ? last.at.toISOString() : null,
    payeesChecked: payees.length,
    payeesMatching: payees.filter((payee) => payee.status === "match").length,
    payeesDiffering: payees.filter((payee) => payee.status === "differs" || payee.status === "old").length,
    // Only the payees that need a look; matches are counted above.
    payeeIssues: payees.filter((payee) => payee.status !== "match").map(({ key: id, supplierId: _supplierId, ...payee }) => ({ id, ...payee })),
    payRuns: rows.map((row) => ({
      id: row.tellerooId,
      name: row.name,
      status: row.status,
      payeesType: row.payeesType,
      scheduledFor: row.scheduledFor?.toISOString() ?? null,
      requestedAmount: amount(row.requestedAmount),
      paidAmount: amount(row.paidAmount),
      payments: row.payments.length,
      rejected: row.payments.filter((payment) => payment.state === "rejected").length,
      tellerooUrl: row.tellerooUrl,
      createdAt: row.tellerooCreatedAt?.toISOString() ?? null,
      lastCheckedAt: row.lastCheckedAt.toISOString(),
    })),
  };
}
