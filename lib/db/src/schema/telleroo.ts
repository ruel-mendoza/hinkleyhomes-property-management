import { sql } from "drizzle-orm";
import { index, jsonb, pgPolicy, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { id, money, timestamps } from "./columns";
import { n8nTellerooWriterRole } from "./roles";

// Every Telleroo webhook as it arrived, saved by n8n (n8n/telleroo-events.workflow.json).
// Payment events carry only Telleroo's transaction id and the idempotent key we
// gave the payment, so the key is how an event is matched to its bill.
export const tellerooEventsTable = pgTable(
  "telleroo_events",
  {
    id: id(),
    // type:id:key, so a repeated webhook is saved once.
    dedupeKey: text("dedupe_key").notNull(),
    // payment_sent | payment_failed | payment_cancelled | pay_run_awaiting_approval | pay_run_approved | pay_run_payments_sent
    eventType: text("event_type").notNull(),
    payRunId: text("pay_run_id"),
    transactionId: text("transaction_id"),
    idempotentKey: text("idempotent_key"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("telleroo_events_dedupe_uq").on(t.dedupeKey),
    index("telleroo_events_key_idx").on(t.idempotentKey),
    index("telleroo_events_pay_run_idx").on(t.payRunId),
    pgPolicy("telleroo_events_n8n_insert", { for: "insert", to: n8nTellerooWriterRole, withCheck: sql`true` }),
  ],
).enableRLS();

export type TellerooEvent = typeof tellerooEventsTable.$inferSelect;

export type TellerooPayRunPayment = {
  // initialized | accepted | rejected (the Telleroo list it was in)
  state: string;
  amount: string | null;
  payeeName: string | null;
  accountLast4: string | null;
  reference: string | null;
  idempotentKey: string | null;
  info: Record<string, unknown> | null;
};

// Latest state of each pay run, re-read from Telleroo by n8n after a webhook and
// every 30 minutes while it is still open. Bank account numbers are cut to the last 4 digits.
export const tellerooPayRunsTable = pgTable(
  "telleroo_pay_runs",
  {
    id: id(),
    tellerooId: text("telleroo_id").notNull(),
    idempotentKey: text("idempotent_key"),
    name: text("name"),
    accountId: text("account_id"),
    // validating | validated | processing | awaiting_review | awaiting_approval | approving
    // | awaiting_funds | sending | paid | cancelling | cancelled
    status: text("status").notNull(),
    payeesType: text("payees_type"),
    paymentsReason: text("payments_reason"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    requestedAmount: money("requested_amount"),
    acceptedAmount: money("accepted_amount"),
    paidAmount: money("paid_amount"),
    dueAmount: money("due_amount"),
    currency: text("currency"),
    payments: jsonb("payments").$type<TellerooPayRunPayment[]>().notNull().default([]),
    tellerooUrl: text("telleroo_url"),
    tellerooCreatedAt: timestamp("telleroo_created_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("telleroo_pay_runs_telleroo_id_uq").on(t.tellerooId),
    index("telleroo_pay_runs_status_idx").on(t.status, t.lastCheckedAt),
    pgPolicy("telleroo_pay_runs_n8n_read", { for: "select", to: n8nTellerooWriterRole, using: sql`true` }),
    pgPolicy("telleroo_pay_runs_n8n_insert", { for: "insert", to: n8nTellerooWriterRole, withCheck: sql`true` }),
    pgPolicy("telleroo_pay_runs_n8n_update", { for: "update", to: n8nTellerooWriterRole, using: sql`true`, withCheck: sql`true` }),
  ],
).enableRLS();

export type TellerooPayRun = typeof tellerooPayRunsTable.$inferSelect;
