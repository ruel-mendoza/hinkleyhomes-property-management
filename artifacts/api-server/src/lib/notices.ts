import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { auditLogTable, billCodingReviewsTable, exceptionQueueTable, getDb, integrationSyncRunsTable, invoiceIntakeChecksTable, staffNoticeSettingsTable } from "@workspace/db";

// Popup notices (web: components/notices/InvoiceNotices.tsx) for updates pushed
// in the background, read from the rows n8n and the scheduled jobs already write:
//   invoice  accounts inbox checks (invoice_intake_checks): passed, for review, missing details
//   bill     bill coding (bill_coding_reviews): held for a property, coded in test mode,
//            draft written to Xero, or the Xero write failed
//   bank     supplier bank details flagged (exception_queue, bank_detail_change)
//   sync     a background sync that failed (integration_sync_runs), once until it works again
// Each staff member can turn notices off, or turn off some kinds, with the bell
// in the top bar (staff_notice_settings); what's turned off isn't sent at all.
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

export type NoticeSettings = { enabled: boolean; muted: Notice["kind"][] };
const KINDS: Notice["kind"][] = ["invoice", "bill", "bank", "sync"];
const ALL_ON: NoticeSettings = { enabled: true, muted: [] };

export async function readNoticeSettings(email: string | undefined): Promise<NoticeSettings> {
  if (!email) return ALL_ON;
  const t = staffNoticeSettingsTable;
  const [row] = await getDb().select().from(t).where(eq(t.email, email.toLowerCase())).limit(1);
  return row ? { enabled: row.enabled, muted: KINDS.filter((kind) => row.mutedKinds.includes(kind)) } : ALL_ON;
}

export async function saveNoticeSettings(
  settings: NoticeSettings,
  staff: { email: string; userId: string | null },
  request: { requestId: string | null; ipAddress: string | null },
): Promise<NoticeSettings> {
  const t = staffNoticeSettingsTable;
  const email = staff.email.toLowerCase();
  const next = { enabled: settings.enabled, muted: KINDS.filter((kind) => settings.muted.includes(kind)) };
  return getDb().transaction(async (tx) => {
    const [before] = await tx.select().from(t).where(eq(t.email, email)).limit(1);
    await tx.insert(t).values({ email, enabled: next.enabled, mutedKinds: next.muted })
      .onConflictDoUpdate({ target: t.email, set: { enabled: next.enabled, mutedKinds: next.muted } });
    await tx.insert(auditLogTable).values({
      actorEmail: staff.email,
      actorUserId: staff.userId,
      action: "notice_settings.update",
      tableName: "staff_notice_settings",
      recordId: email,
      before: before ? { enabled: before.enabled, muted: before.mutedKinds } : null,
      after: next,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
    });
    return next;
  });
}

// Popups: what's new since the page's last read, oldest first. Nothing when popups are off.
export async function latestNotices(since: Date, settings: NoticeSettings = ALL_ON): Promise<Notice[]> {
  if (!settings.enabled) return [];
  return (await collectNotices(new Date(since.getTime() - LOOK_BACK_MS), settings.muted, PER_SOURCE, "oldest")).slice(-20);
}

// The bell's list: the last 7 days (or since the person cleared it), newest first.
// Popups being off doesn't hide the list; kinds turned off are left out of both.
export type NoticeHistory = { items: Notice[]; lastSeenAt: string | null; unread: number };
const HISTORY_DAYS = 7;
const HISTORY_PER_SOURCE = 15;

export async function noticeHistory(email: string | undefined): Promise<NoticeHistory> {
  const t = staffNoticeSettingsTable;
  const [row] = email ? await getDb().select().from(t).where(eq(t.email, email.toLowerCase())).limit(1) : [];
  const weekAgo = new Date(Date.now() - HISTORY_DAYS * 86_400_000);
  const from = row?.clearedAt && row.clearedAt > weekAgo ? row.clearedAt : weekAgo;
  const muted = row ? KINDS.filter((kind) => row.mutedKinds.includes(kind)) : [];
  const items = (await collectNotices(from, muted, HISTORY_PER_SOURCE, "newest")).reverse().slice(0, 50);
  const lastSeenAt = row?.lastSeenAt?.toISOString() ?? null;
  return { items, lastSeenAt, unread: items.filter((item) => !lastSeenAt || item.at > lastSeenAt).length };
}

// Opening the list marks everything in it as seen; the trash button clears it.
export async function markNoticesSeen(email: string, clear: boolean): Promise<NoticeHistory> {
  const t = staffNoticeSettingsTable;
  const now = new Date();
  const set = clear ? { lastSeenAt: now, clearedAt: now } : { lastSeenAt: now };
  await getDb().insert(t).values({ email: email.toLowerCase(), ...set }).onConflictDoUpdate({ target: t.email, set });
  return noticeHistory(email);
}

async function collectNotices(from: Date, muted: Notice["kind"][], perSource: number, first: "oldest" | "newest"): Promise<Notice[]> {
  if (muted.length === KINDS.length) return [];
  const on = (kind: Notice["kind"]) => !muted.includes(kind);
  const order = first === "oldest" ? asc : desc;
  const limit = perSource;
  const db = getDb();
  const ic = invoiceIntakeChecksTable;
  const br = billCodingReviewsTable;
  const eq_ = exceptionQueueTable;
  const sr = integrationSyncRunsTable;

  const none = Promise.resolve([]);
  const [invoices, billsRaised, billsWritten, bank, syncs] = await Promise.all([
    !on("invoice") ? none : db.select().from(ic)
      .where(and(gt(ic.processedAt, from), inArray(ic.verdict, ["pass", "review", "bounce"])))
      .orderBy(order(ic.processedAt)).limit(limit),
    // A bill is checked again each run; only its first held or test-mode row counts.
    !on("bill") ? none : db.select().from(br)
      .where(and(
        gt(br.createdAt, from),
        inArray(br.status, ["held", "shadow_planned"]),
        sql`not exists (select 1 from bill_coding_reviews p where p.idempotency_key = ${br.idempotencyKey} and p.status = ${br.status} and p.created_at < ${br.createdAt})`,
      ))
      .orderBy(order(br.createdAt)).limit(limit),
    !on("bill") ? none : db.select().from(br)
      .where(and(gt(br.updatedAt, from), inArray(br.status, ["created_draft", "updated_draft", "create_failed"])))
      .orderBy(order(br.updatedAt)).limit(limit),
    !on("bank") ? none : db.select().from(eq_)
      .where(and(gt(eq_.createdAt, from), eq(eq_.kind, "bank_detail_change")))
      .orderBy(order(eq_.createdAt)).limit(limit),
    // A failed run counts only when the run before it (same job) didn't fail too.
    !on("sync") ? none : db.select().from(sr)
      .where(and(
        gt(sr.finishedAt, from),
        eq(sr.status, "failed"),
        sql`coalesce((select p.status::text from integration_sync_runs p where p.integration = ${sr.integration} and split_part(p.trigger, ':', 1) = split_part(${sr.trigger}, ':', 1) and p.status <> 'running' and p.started_at < ${sr.startedAt} order by p.started_at desc limit 1), 'succeeded') <> 'failed'`,
      ))
      .orderBy(order(sr.finishedAt)).limit(limit),
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
  return notices.sort((a, b) => a.at.localeCompare(b.at));
}
