import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { billCodingReviewsTable, exceptionQueueTable, getDb, integrationSyncRunsTable, invoiceIntakeChecksTable } from "@workspace/db";

// Popup notices (web: components/notices/InvoiceNotices.tsx) for updates pushed
// in the background, read from the rows n8n and the scheduled jobs already write:
//   invoice  accounts inbox checks (invoice_intake_checks): passed, for review, missing details
//   bill     bill coding (bill_coding_reviews): held for a property, coded in test mode,
//            draft written to Xero, or the Xero write failed
//   bank     supplier bank details flagged (exception_queue, bank_detail_change)
//   sync     a background sync that failed (integration_sync_runs), once until it works again
// The page asks with the time of its last read; each read looks back 2 more
// minutes (the page skips ids it has shown), which covers rows committed late
// and small clock gaps between n8n and the app.

export type Notice = {
  id: string;
  kind: "invoice" | "bill" | "bank" | "sync";
  tone: "ok" | "warn" | "alert";
  title: string;
  text: string;
  detail: string | null;
  href: string;
  link: string;
  sticky: boolean;
  at: string;
};

const LOOK_BACK_MS = 2 * 60_000;
const PER_SOURCE = 10;
const pounds = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(" · ") || null;
const clip = (text: string, max = 180) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const money = (value: string | null) => (value === null ? null : pounds.format(Number(value)));

const INVOICE: Record<string, Pick<Notice, "tone" | "title" | "href" | "link" | "sticky">> = {
  pass: { tone: "ok", title: "New invoice passed", href: "/bills", link: "Open inbox", sticky: false },
  review: { tone: "warn", title: "New invoice for review", href: "/bills?tab=review", link: "Review", sticky: true },
  bounce: { tone: "alert", title: "Invoice missing details", href: "/bills", link: "Open inbox", sticky: true },
};

const BILL: Record<string, Pick<Notice, "tone" | "title" | "sticky">> = {
  held: { tone: "warn", title: "Bill needs a property", sticky: true },
  shadow_planned: { tone: "ok", title: "Bill coded (test mode)", sticky: false },
  created_draft: { tone: "ok", title: "Draft bill written to Xero", sticky: false },
  updated_draft: { tone: "ok", title: "Bill updated in Xero", sticky: false },
  create_failed: { tone: "alert", title: "Bill couldn't be written to Xero", sticky: true },
};

// Background syncs, by integration and the start of their trigger.
function syncLabel(integration: string, trigger: string): { name: string; href: string } {
  const prefix = trigger.split(":")[0];
  if (integration === "coho") return prefix === "rent-match-actions" ? { name: "Rent matching", href: "/rent?tab=bank" } : { name: "COHO actions sync", href: "/actions" };
  if (integration === "smoobu") return { name: "Smoobu bookings sync", href: "/stays" };
  if (integration === "xero") return { name: "Xero daily checks", href: "/bills?tab=alerts" };
  if (integration === "accounts_inbox") return { name: "Inbox backup check", href: "/bills" };
  return { name: `${integration.replaceAll("_", " ")} sync`, href: "/dashboard" };
}

export async function latestNotices(since: Date): Promise<Notice[]> {
  const db = getDb();
  const from = new Date(since.getTime() - LOOK_BACK_MS);
  const ic = invoiceIntakeChecksTable;
  const br = billCodingReviewsTable;
  const eq_ = exceptionQueueTable;
  const sr = integrationSyncRunsTable;

  const [invoices, billsRaised, billsWritten, bank, syncs] = await Promise.all([
    db.select().from(ic)
      .where(and(gt(ic.processedAt, from), inArray(ic.verdict, ["pass", "review", "bounce"])))
      .orderBy(asc(ic.processedAt)).limit(PER_SOURCE),
    // A bill is checked again each run; only its first held or test-mode row counts.
    db.select().from(br)
      .where(and(
        gt(br.createdAt, from),
        inArray(br.status, ["held", "shadow_planned"]),
        sql`not exists (select 1 from bill_coding_reviews p where p.idempotency_key = ${br.idempotencyKey} and p.status = ${br.status} and p.created_at < ${br.createdAt})`,
      ))
      .orderBy(asc(br.createdAt)).limit(PER_SOURCE),
    db.select().from(br)
      .where(and(gt(br.updatedAt, from), inArray(br.status, ["created_draft", "updated_draft", "create_failed"])))
      .orderBy(asc(br.updatedAt)).limit(PER_SOURCE),
    db.select().from(eq_)
      .where(and(gt(eq_.createdAt, from), eq(eq_.kind, "bank_detail_change")))
      .orderBy(asc(eq_.createdAt)).limit(PER_SOURCE),
    // A failed run counts only when the run before it (same job) didn't fail too.
    db.select().from(sr)
      .where(and(
        gt(sr.finishedAt, from),
        eq(sr.status, "failed"),
        sql`coalesce((select p.status::text from integration_sync_runs p where p.integration = ${sr.integration} and split_part(p.trigger, ':', 1) = split_part(${sr.trigger}, ':', 1) and p.status <> 'running' and p.started_at < ${sr.startedAt} order by p.started_at desc limit 1), 'succeeded') <> 'failed'`,
      ))
      .orderBy(asc(sr.finishedAt)).limit(PER_SOURCE),
  ]);

  const notices: Notice[] = [
    ...invoices.flatMap((row): Notice[] => {
      const kind = INVOICE[row.verdict];
      if (!kind) return [];
      return [{
        id: `invoice:${row.id}`,
        kind: "invoice",
        ...kind,
        text: row.supplierName || row.subject || "Unknown supplier",
        detail: join(row.invoiceNumber && `No. ${row.invoiceNumber}`, money(row.totalGross)),
        at: row.processedAt.toISOString(),
      }];
    }),
    ...[...billsRaised, ...billsWritten].flatMap((row): Notice[] => {
      const kind = BILL[row.status];
      if (!kind) return [];
      const why = row.status === "held"
        ? row.needs.length ? `${row.needs.length} ${row.needs.length === 1 ? "line needs" : "lines need"} a property` : String(row.reasons[0]?.message ?? "") || null
        : row.status === "create_failed" ? row.error && clip(row.error, 140) : null;
      const at = row.status === "held" || row.status === "shadow_planned" ? row.createdAt : row.updatedAt;
      return [{
        id: `bill:${row.id}:${row.status}`,
        kind: "bill",
        ...kind,
        text: join(row.supplierName || "Unknown supplier", row.company) ?? "Supplier bill",
        detail: join(row.invoiceNumber && `No. ${row.invoiceNumber}`, money(row.total), why),
        href: "/bills?tab=coding",
        link: row.status === "held" ? "Choose property" : "Open bill coding",
        at: at.toISOString(),
      }];
    }),
    ...bank.map((row): Notice => ({
      id: `bank:${row.id}`,
      kind: "bank",
      tone: "alert",
      title: "Supplier bank details to check",
      text: clip(row.summary, 220),
      detail: null,
      href: "/bills?tab=alerts",
      link: "Open alerts",
      sticky: true,
      at: row.createdAt.toISOString(),
    })),
    ...syncs.map((row): Notice => {
      const label = syncLabel(row.integration, row.trigger);
      return {
        id: `sync:${row.id}`,
        kind: "sync",
        tone: "alert",
        title: "Background update failed",
        text: label.name,
        detail: row.error ? clip(row.error, 140) : null,
        href: label.href,
        link: "Open page",
        sticky: true,
        at: (row.finishedAt ?? row.startedAt).toISOString(),
      };
    }),
  ];
  return notices.sort((a, b) => a.at.localeCompare(b.at)).slice(-20);
}
