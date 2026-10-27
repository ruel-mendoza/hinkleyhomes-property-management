import { and, asc, eq, inArray, sql, type AnyColumn } from "drizzle-orm";
import {
  auditLogTable,
  billCodingReviewsTable,
  getDb,
  invoiceIntakeFilesTable,
  invoiceIntakeReviewsTable,
  xeroBillHistoryTable,
  type InvoiceIntakeReview,
} from "@workspace/db";
import { supplierKey } from "./bill-checks";
import { logger } from "./logger";

// Inbox intake check (n8n "Hinkley Intake check"): emails to accounts@ it sent
// for review are posted here and listed on the Invoices page ("For review").
// The workflow decides the verdict; the app only keeps the queue, and only
// while a review is open: once it is done, dismissed or found in Xero the row
// is deleted and a short summary kept in the audit log.

export type IntakeReviewIssue = { code: string; message: string; lines: { text: string; amount: number | null }[] };

export type IncomingIntakeReview = {
  internetMessageId: string;
  outlookMessageId: string | null;
  webLink: string | null;
  receivedAt: Date | null;
  senderEmail: string | null;
  senderName: string | null;
  subject: string | null;
  supplierName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  total: number | null;
  currency: string | null;
  billTo: string | null;
  billToCompany: string | null;
  reasons: { code: string; message: string }[];
  issues: IntakeReviewIssue[];
};

const DAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

// What the workflow posts (checked by hand; n8n sends plain JSON). Field names
// follow the workflow's own: internet_message_id, sender_email, reasons, issues...
export function parseIntakeReview(body: unknown): IncomingIntakeReview | null {
  const value = (body ?? {}) as Record<string, unknown>;
  const text = (input: unknown, max: number) =>
    typeof input === "string" && input.trim() ? input.trim().slice(0, max) : typeof input === "number" ? String(input) : null;
  const amount = (input: unknown) => {
    const n = typeof input === "number" ? input : typeof input === "string" && input.trim() ? Number(input.replace(/[£$€,\s]/g, "")) : NaN;
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  };
  const internetMessageId = text(value.internet_message_id, 500) ?? text(value.outlook_message_id, 500);
  if (!internetMessageId) return null;
  const received = text(value.received_at, 40);
  const receivedAt = received && !Number.isNaN(Date.parse(received)) ? new Date(received) : null;
  const date = text(value.invoice_date, 10);
  const link = text(value.web_link, 2000);
  const reasons = (Array.isArray(value.reasons) ? value.reasons : []).slice(0, 50).flatMap((item) => {
    const r = (item ?? {}) as Record<string, unknown>;
    const message = text(r.message, 1000);
    return message ? [{ code: text(r.code, 60) ?? "other", message }] : [];
  });
  const issues = (Array.isArray(value.issues) ? value.issues : []).slice(0, 50).flatMap((item) => {
    const r = (item ?? {}) as Record<string, unknown>;
    const message = text(r.message, 1000);
    if (!message) return [];
    const lines = (Array.isArray(r.lines) ? r.lines : []).slice(0, 40).map((line) => {
      const l = (line ?? {}) as Record<string, unknown>;
      return { text: text(l.text, 500) ?? "(no description)", amount: amount(l.amount) };
    });
    return [{ code: text(r.code, 60) ?? "other", message, lines }];
  });
  return {
    internetMessageId,
    outlookMessageId: text(value.outlook_message_id, 500),
    // Only Outlook links: the page opens it in a new tab.
    webLink: link && /^https:\/\/outlook\.(office365|office|live)\.com\//i.test(link) ? link : null,
    receivedAt,
    senderEmail: text(value.sender_email, 300)?.toLowerCase() ?? null,
    senderName: text(value.sender_name, 300),
    subject: text(value.subject, 500),
    supplierName: text(value.supplier_name, 300),
    invoiceNumber: text(value.invoice_number, 100),
    invoiceDate: date && DAY_FORMAT.test(date) && !Number.isNaN(Date.parse(date)) ? date : null,
    total: amount(value.total),
    currency: text(value.currency, 3)?.toUpperCase() ?? null,
    billTo: text(value.bill_to, 300),
    billToCompany: text(value.bill_to_company, 200),
    reasons,
    issues,
  };
}

// The same email sent again refreshes what was read. An email whose review was
// already resolved (and so deleted) is not added back.
export async function recordIntakeReview(review: IncomingIntakeReview): Promise<{ id: string | null; created: boolean }> {
  const t = invoiceIntakeReviewsTable;
  const a = auditLogTable;
  const [resolved] = await getDb()
    .select({ id: a.id })
    .from(a)
    .where(and(eq(a.tableName, AUDIT_TABLE), sql`${a.before}->>'internetMessageId' = ${review.internetMessageId}`))
    .limit(1);
  if (resolved) return { id: null, created: false };
  const values = { ...review, total: review.total === null ? null : review.total.toFixed(2) };
  const { internetMessageId: _key, ...update } = values;
  const [row] = await getDb()
    .insert(t)
    .values(values)
    .onConflictDoUpdate({ target: t.internetMessageId, set: update })
    .returning({ id: t.id, created: sql<boolean>`(xmax = 0)` });
  return { id: row.id, created: row.created };
}

export type IntakeFileView = { kind: "file" | "link"; name: string | null; url: string };

// Saved files must be on SharePoint/OneDrive; invoice links just https. Anything
// else the workflow wrote is left out rather than shown as a link.
function safeUrl(kind: string, url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return kind === "link" || u.hostname.endsWith(".sharepoint.com");
  } catch {
    return false;
  }
}

// The files and invoice links the workflow saved for these emails, by message id.
export async function intakeFilesFor(messageIds: string[]): Promise<Map<string, IntakeFileView[]>> {
  const map = new Map<string, IntakeFileView[]>();
  const ids = [...new Set(messageIds.filter(Boolean))];
  if (!ids.length) return map;
  const t = invoiceIntakeFilesTable;
  const rows = await getDb().select().from(t).where(inArray(t.internetMessageId, ids)).orderBy(asc(t.kind), asc(t.createdAt));
  for (const row of rows) {
    if ((row.kind !== "file" && row.kind !== "link") || !safeUrl(row.kind, row.url)) continue;
    const list = map.get(row.internetMessageId) ?? [];
    list.push({ kind: row.kind, name: row.name, url: row.url });
    map.set(row.internetMessageId, list);
  }
  return map;
}

export function intakeReviewView(row: InvoiceIntakeReview, files: IntakeFileView[] = []) {
  return {
    id: row.id,
    receivedAt: row.receivedAt?.toISOString() ?? null,
    senderEmail: row.senderEmail,
    senderName: row.senderName,
    subject: row.subject,
    webLink: row.webLink,
    supplierName: row.supplierName,
    invoiceNumber: row.invoiceNumber,
    invoiceDate: row.invoiceDate,
    total: row.total === null ? null : Number(row.total),
    currency: row.currency,
    billTo: row.billTo,
    billToCompany: row.billToCompany,
    reasons: row.reasons,
    issues: row.issues as IntakeReviewIssue[],
    createdAt: row.createdAt.toISOString(),
    files,
  };
}

// --- Removing resolved reviews ---------------------------------------------------

const AUDIT_TABLE = "invoice_intake_reviews";

type Actor = { email: string | null; userId?: string | null; requestId?: string | null; ipAddress?: string | null };

// Deletes the review and writes what it was to the audit log in one go, so a
// review never disappears without a trace. False when it was already gone.
export async function removeIntakeReview(row: InvoiceIntakeReview, action: string, after: Record<string, unknown>, actor: Actor): Promise<boolean> {
  const t = invoiceIntakeReviewsTable;
  return getDb().transaction(async (tx) => {
    const [gone] = await tx.delete(t).where(eq(t.id, row.id)).returning({ id: t.id });
    if (!gone) return false;
    await tx.insert(auditLogTable).values({
      actorEmail: actor.email,
      actorUserId: actor.userId ?? null,
      action,
      tableName: AUDIT_TABLE,
      recordId: row.id,
      before: {
        internetMessageId: row.internetMessageId,
        receivedAt: row.receivedAt?.toISOString() ?? null,
        senderEmail: row.senderEmail,
        subject: row.subject,
        supplierName: row.supplierName,
        invoiceNumber: row.invoiceNumber,
        invoiceDate: row.invoiceDate,
        total: row.total,
        billToCompany: row.billToCompany,
      },
      after,
      requestId: actor.requestId ?? null,
      ipAddress: actor.ipAddress ?? null,
    });
    return true;
  });
}

// "INV-00123" and "inv 123" are the same invoice number.
const invoiceKey = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^0+/, "");
const invoiceKeySql = (column: AnyColumn) => sql<string>`ltrim(regexp_replace(upper(${column}), '[^A-Z0-9]', '', 'g'), '0')`;

type XeroBill = { source: "xero_bill_history" | "bill_coding"; xeroBillId: string; company: string; supplierName: string | null; billNumber: string | null; total: number | null; status: string | null };

// Same invoice number, and the same supplier or the same total. A number on its
// own is not enough: different suppliers reuse "INV-001".
export function findXeroBill(review: Pick<InvoiceIntakeReview, "invoiceNumber" | "supplierName" | "total">, bills: XeroBill[]): XeroBill | null {
  const key = review.invoiceNumber ? invoiceKey(review.invoiceNumber) : "";
  if (!key) return null;
  const supplier = review.supplierName ? supplierKey(review.supplierName) : "";
  const total = review.total === null ? null : Number(review.total);
  return bills.find((bill) =>
    bill.billNumber !== null && invoiceKey(bill.billNumber) === key &&
    ((supplier !== "" && bill.supplierName !== null && supplierKey(bill.supplierName) === supplier) ||
      (total !== null && bill.total !== null && Math.abs(bill.total - total) < 0.005)),
  ) ?? null;
}

// Bills Xero has with these invoice numbers: those the daily checks stored
// (submitted, approved or paid) and drafts bill coding has read or written.
// Bills since voided or deleted in Xero don't count.
async function xeroBillsNumbered(keys: string[]): Promise<XeroBill[]> {
  const h = xeroBillHistoryTable;
  const b = billCodingReviewsTable;
  const [history, coded] = await Promise.all([
    getDb()
      .select({ xeroBillId: h.xeroBillId, company: h.company, supplierName: h.supplierName, billNumber: h.billNumber, total: h.total, status: h.status })
      .from(h)
      .where(inArray(invoiceKeySql(h.billNumber), keys)),
    getDb()
      .select({ xeroBillId: b.xeroBillId, company: b.company, supplierName: b.supplierName, billNumber: b.invoiceNumber, total: b.total })
      .from(b)
      .where(inArray(invoiceKeySql(b.invoiceNumber), keys)),
  ]);
  const gone = new Set(history.filter((bill) => bill.status === "VOIDED" || bill.status === "DELETED").map((bill) => bill.xeroBillId));
  const amount = (value: string | null) => (value === null ? null : Number(value));
  return [
    ...history.filter((bill) => !gone.has(bill.xeroBillId)).map((bill) => ({ ...bill, source: "xero_bill_history" as const, total: amount(bill.total) })),
    ...coded.filter((bill) => !gone.has(bill.xeroBillId)).map((bill) => ({ ...bill, source: "bill_coding" as const, total: amount(bill.total), status: null })),
  ];
}

async function clearReviews(): Promise<number> {
  const t = invoiceIntakeReviewsTable;
  const rows = await getDb().select().from(t);
  let cleared = 0;
  // Reviews marked done or dismissed before resolving deleted them.
  for (const row of rows.filter((item) => item.status !== "open")) {
    const after = { outcome: row.status, note: row.resolution, resolvedAt: row.resolvedAt?.toISOString() ?? null };
    if (await removeIntakeReview(row, `intake_review.${row.status}`, after, { email: row.resolvedBy })) cleared += 1;
  }
  const open = rows.filter((item) => item.status === "open" && item.invoiceNumber && invoiceKey(item.invoiceNumber));
  if (!open.length) return cleared;
  const bills = await xeroBillsNumbered([...new Set(open.map((item) => invoiceKey(item.invoiceNumber!)))]);
  for (const row of open) {
    const bill = findXeroBill(row, bills);
    if (bill && (await removeIntakeReview(row, "intake_review.in_xero", { inXero: bill }, { email: null }))) cleared += 1;
  }
  if (cleared) logger.info({ cleared }, "Intake reviews cleared");
  return cleared;
}

// Run when the list or the overview is read (at most once a minute) and after
// the daily checks have fetched new bills (force).
let lastRun = 0;
let running: Promise<number> | null = null;
export function clearResolvedIntakeReviews(force = false): Promise<number> {
  if (running) return running;
  if (!force && Date.now() - lastRun < 60_000) return Promise.resolve(0);
  running = clearReviews().finally(() => {
    lastRun = Date.now();
    running = null;
  });
  return running;
}
