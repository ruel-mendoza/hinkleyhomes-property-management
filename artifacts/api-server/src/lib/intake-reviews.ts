import { asc, inArray, sql } from "drizzle-orm";
import { getDb, invoiceIntakeFilesTable, invoiceIntakeReviewsTable, type InvoiceIntakeReview } from "@workspace/db";

// Inbox intake check (n8n "Hinkley Intake check"): emails to accounts@ it sent
// for review are posted here and listed on the Invoices page ("For review").
// The workflow decides the verdict; the app only keeps the queue.

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

// The same email sent again refreshes what was read but keeps the review's status.
export async function recordIntakeReview(review: IncomingIntakeReview): Promise<{ id: string; created: boolean }> {
  const t = invoiceIntakeReviewsTable;
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
    status: row.status,
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
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolution: row.resolution,
    files,
  };
}
