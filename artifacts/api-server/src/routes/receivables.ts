import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  auditLogTable,
  getDb,
  isDatabaseConfigured,
  xeroInvoiceFollowUpNotesTable,
  xeroInvoiceFollowUpsTable,
  type XeroInvoiceFollowUp,
} from "@workspace/db";
import {
  GetInvoicePaymentLinkParams,
  GetReceivablesResponse,
  UpdateInvoiceFollowUpBody,
  UpdateInvoiceFollowUpParams,
  UpdateInvoiceFollowUpResponse,
} from "@workspace/api-zod";
import { cohoApiKey, readXeroGatewayEnv } from "../lib/integrations-env";
import { cohoGet } from "../lib/coho-api";
import { parseXeroDate, xeroGatewayRequest } from "../lib/xero-gateway";
import { COMPANIES } from "./money";

// Invoices page (Phase 1, read-only towards Xero): open sales invoices owed to
// each company and open bills each company owes, from Xero through the n8n
// gateway. Follow-ups (outcome, next chase date, notes) are kept in Supabase
// and never sent to Xero or the customer.

type RecordValue = Record<string, unknown>;
const asRecord = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
const list = (value: unknown): RecordValue[] => (Array.isArray(value) ? value.map(asRecord) : []);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const round = (value: number) => Math.round(value * 100) / 100;

const ukToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
// Xero dates are date-only values at UTC midnight.
const xeroDay = (value: unknown) => parseXeroDate(value)?.toISOString().slice(0, 10) ?? null;
const daysPast = (due: string | null, today: string) => (due ? Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${due}T12:00:00Z`)) / 86_400_000) : 0);

async function xeroPages(tenantId: string, where: string, statuses: string): Promise<RecordValue[]> {
  const items: RecordValue[] = [];
  for (let page = 1; page <= 10; page++) {
    const response = await xeroGatewayRequest({ tenantId, resource: "invoices", query: { where, Statuses: statuses, page, pageSize: 100 } });
    if (!response.ok) throw new Error(response.status === 429 ? "Xero is rate limiting; try again shortly." : `Xero returned HTTP ${response.status}.`);
    const batch = list(asRecord(response.data).Invoices);
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

const firstLine = (invoice: RecordValue) => asRecord(list(invoice.LineItems)[0]);
const trackingOption = (invoice: RecordValue) =>
  list(invoice.LineItems).flatMap((line) => list(line.Tracking)).map((tracking) => str(tracking.Option)).find(Boolean) ?? null;
const describe = (invoice: RecordValue) => str(firstLine(invoice).Description)?.replace(/\s+/g, " ").slice(0, 160) ?? null;

// "31 Lyndale Avenue" -> "31 lyndale": house number plus the first word of the street.
const addressKey = (name: string) => {
  const match = /^(\d+[a-z]?)\s+([a-z]+)/i.exec(name.trim());
  return match ? `${match[1]} ${match[2]}`.toLowerCase() : null;
};
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ");

async function cohoPropertyKeys(): Promise<{ key: string; propertyReference: string; propertyName: string }[]> {
  if (!cohoApiKey()) return [];
  const payload = asRecord(await cohoGet("/properties?page=1&pageSize=100"));
  return list(payload.items)
    .map((item) => ({ propertyReference: str(item.reference) ?? "", propertyName: str(item.name) ?? "", key: addressKey(str(item.name) ?? "") }))
    .filter((item): item is { key: string; propertyReference: string; propertyName: string } => Boolean(item.key && item.propertyReference));
}

type Snapshot = Awaited<ReturnType<typeof loadXero>>;
async function loadXero() {
  const today = ukToday();
  const properties = await cohoPropertyKeys().catch(() => [] as Awaited<ReturnType<typeof cohoPropertyKeys>>);
  const results = await Promise.all(
    COMPANIES.map(async (company) => {
      try {
        const [sales, bills] = await Promise.all([
          xeroPages(company.tenantId, 'Type=="ACCREC"&&AmountDue>0', "AUTHORISED"),
          xeroPages(company.tenantId, 'Type=="ACCPAY"&&AmountDue>0', "AUTHORISED,SUBMITTED"),
        ]);
        return { company, sales, bills, error: null as string | null };
      } catch (error) {
        return { company, sales: [] as RecordValue[], bills: [] as RecordValue[], error: (error as Error).message };
      }
    }),
  );

  const invoices = results.flatMap(({ company, sales }) =>
    sales.map((invoice) => {
      const dueDate = xeroDay(invoice.DueDate);
      const property = trackingOption(invoice);
      const description = describe(invoice);
      const reference = str(invoice.Reference);
      // Rent invoices in companies that hold property money may duplicate a COHO tenancy.
      const text = squash([property, description, reference].filter(Boolean).join(" "));
      const looksLikeRent = company.holdsPropertyMoney && /\brent\b/.test(text);
      const coho = looksLikeRent ? properties.find((item) => text.includes(item.key)) : undefined;
      return {
        tenantId: company.tenantId,
        company: company.name,
        invoiceId: String(invoice.InvoiceID),
        number: str(invoice.InvoiceNumber),
        contactName: str(asRecord(invoice.Contact).Name) ?? "Unknown contact",
        reference,
        description,
        property,
        date: xeroDay(invoice.Date),
        dueDate,
        daysOverdue: daysPast(dueDate, today),
        total: round(num(invoice.Total)),
        amountDue: round(num(invoice.AmountDue)),
        sent: invoice.SentToContact === true,
        cohoProperty: coho ? { propertyReference: coho.propertyReference, propertyName: coho.propertyName } : null,
      };
    }),
  );
  const bills = results.flatMap(({ company, bills: items }) =>
    items.map((bill) => {
      const dueDate = xeroDay(bill.DueDate);
      return {
        tenantId: company.tenantId,
        company: company.name,
        billId: String(bill.InvoiceID),
        number: str(bill.InvoiceNumber),
        contactName: str(asRecord(bill.Contact).Name) ?? "Unknown supplier",
        description: describe(bill),
        property: trackingOption(bill),
        dueDate,
        daysOverdue: daysPast(dueDate, today),
        total: round(num(bill.Total)),
        amountDue: round(num(bill.AmountDue)),
        status: str(bill.Status) ?? "AUTHORISED",
      };
    }),
  );
  const companies = results.map(({ company, error }) => {
    const owed = invoices.filter((invoice) => invoice.tenantId === company.tenantId);
    const overdue = owed.filter((invoice) => invoice.daysOverdue > 0);
    const late = bills.filter((bill) => bill.tenantId === company.tenantId && bill.daysOverdue > 0);
    return {
      tenantId: company.tenantId,
      name: company.name,
      holdsPropertyMoney: company.holdsPropertyMoney,
      receivableOpen: round(owed.reduce((sum, invoice) => sum + invoice.amountDue, 0)),
      receivableOverdue: round(overdue.reduce((sum, invoice) => sum + invoice.amountDue, 0)),
      overdueCount: overdue.length,
      billsOverdue: round(late.reduce((sum, bill) => sum + bill.amountDue, 0)),
      billsOverdueCount: late.length,
      error,
    };
  });
  return {
    at: Date.now(),
    complete: results.every((result) => !result.error),
    asOf: today,
    companies,
    invoices: invoices.sort((a, b) => b.daysOverdue - a.daysOverdue || b.amountDue - a.amountDue),
    bills: bills.sort((a, b) => b.daysOverdue - a.daysOverdue || b.amountDue - a.amountDue),
  };
}

const CACHE_MS = 10 * 60_000;
let cache: Snapshot | null = null;

// --- Follow-ups ------------------------------------------------------------------

type FollowUpView = ReturnType<typeof followUpView>;
function followUpView(row: XeroInvoiceFollowUp, notes: { outcome: string; note: string | null; authorEmail: string | null; createdAt: Date }[]) {
  return {
    outcome: row.outcome,
    nextChaseDate: row.nextChaseDate,
    promisedDate: row.promisedDate,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
    notes: notes.slice(0, 10).map((note) => ({ ...note, createdAt: note.createdAt.toISOString() })),
  };
}

async function loadFollowUps(invoiceIds: string[]): Promise<Map<string, FollowUpView> | null> {
  if (!isDatabaseConfigured()) return null;
  if (!invoiceIds.length) return new Map();
  const db = getDb();
  const rows = await db.select().from(xeroInvoiceFollowUpsTable).where(inArray(xeroInvoiceFollowUpsTable.xeroInvoiceId, invoiceIds));
  const notes = rows.length
    ? await db
        .select({
          followUpId: xeroInvoiceFollowUpNotesTable.followUpId,
          outcome: xeroInvoiceFollowUpNotesTable.outcome,
          note: xeroInvoiceFollowUpNotesTable.note,
          authorEmail: xeroInvoiceFollowUpNotesTable.authorEmail,
          createdAt: xeroInvoiceFollowUpNotesTable.createdAt,
        })
        .from(xeroInvoiceFollowUpNotesTable)
        .where(inArray(xeroInvoiceFollowUpNotesTable.followUpId, rows.map((row) => row.id)))
        .orderBy(desc(xeroInvoiceFollowUpNotesTable.createdAt))
    : [];
  return new Map(rows.map((row) => [`${row.xeroTenantId}|${row.xeroInvoiceId}`, followUpView(row, notes.filter((note) => note.followUpId === row.id))]));
}

const receivablesRouter: IRouter = Router();

receivablesRouter.get("/receivables", async (req, res): Promise<void> => {
  if (readXeroGatewayEnv().status !== "configured") {
    res.status(503).json({ error: "The n8n Xero gateway is not configured." });
    return;
  }
  let snapshot: Snapshot;
  if (cache && Date.now() - cache.at < CACHE_MS && req.query.refresh !== "1") {
    snapshot = cache;
  } else {
    snapshot = await loadXero();
    // Only complete reads are cached, so a Xero blip is retried on the next load.
    cache = snapshot.complete ? snapshot : null;
    if (!snapshot.complete) {
      req.log.warn({ errors: snapshot.companies.filter((company) => company.error) }, "Some Xero companies could not be read for receivables");
    }
  }

  let followUps: Map<string, FollowUpView> | null = null;
  try {
    followUps = await loadFollowUps(snapshot.invoices.map((invoice) => invoice.invoiceId));
  } catch (error) {
    // Usually the tables haven't been created yet (pnpm --filter @workspace/db run push).
    req.log.error({ err: error }, "Invoice follow-ups could not be read");
  }

  res.json(
    GetReceivablesResponse.parse({
      asOf: snapshot.asOf,
      error: snapshot.companies.every((company) => company.error) ? "Xero could not be reached." : null,
      companies: snapshot.companies,
      invoices: snapshot.invoices.map((invoice) => ({ ...invoice, followUp: followUps?.get(`${invoice.tenantId}|${invoice.invoiceId}`) ?? null })),
      bills: snapshot.bills,
      followUpsAvailable: followUps !== null,
    }),
  );
});

const knownTenant = (tenantId: string) => COMPANIES.some((company) => company.tenantId === tenantId.toLowerCase());

receivablesRouter.get("/receivables/:tenantId/:invoiceId/payment-link", async (req, res): Promise<void> => {
  const params = GetInvoicePaymentLinkParams.safeParse(req.params);
  if (!params.success || !knownTenant(params.data.tenantId)) {
    res.status(400).json({ error: "Unknown company or invoice." });
    return;
  }
  try {
    const response = await xeroGatewayRequest({ tenantId: params.data.tenantId, resource: "onlineInvoice", id: params.data.invoiceId });
    if (response.status === 400 && /Unknown resource/i.test(response.error ?? "")) {
      res.status(503).json({ error: "Import the updated n8n Xero gateway to get payment links." });
      return;
    }
    const url = str(asRecord(list(asRecord(response.data).OnlineInvoices)[0]).OnlineInvoiceUrl);
    if (!response.ok || !url) {
      res.status(response.status === 404 ? 404 : 502).json({ error: "Xero has no online invoice for this invoice." });
      return;
    }
    res.json({ url });
  } catch (error) {
    req.log.warn({ err: error }, "Xero online invoice link unavailable");
    res.status(502).json({ error: "Xero could not be reached." });
  }
});

const DAY = /^\d{4}-\d{2}-\d{2}$/;

receivablesRouter.put("/receivables/:tenantId/:invoiceId/follow-up", async (req: Request, res: Response): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  const params = UpdateInvoiceFollowUpParams.safeParse(req.params);
  const body = UpdateInvoiceFollowUpBody.safeParse(req.body);
  if (!params.success || !knownTenant(params.data.tenantId) || !body.success) {
    res.status(400).json({ error: "Check the follow-up: choose an outcome, and dates must be valid." });
    return;
  }
  const data = body.data;
  for (const value of [data.nextChaseDate, data.promisedDate]) {
    if (value && (!DAY.test(value) || Number.isNaN(Date.parse(value)))) {
      res.status(400).json({ error: "Dates must be valid (YYYY-MM-DD)." });
      return;
    }
  }
  const staff = res.locals.staff as { userId?: string; email?: string } | undefined;
  const tenantId = params.data.tenantId.toLowerCase();
  const invoiceId = params.data.invoiceId.toLowerCase();
  const note = data.note?.trim() || null;
  const db = getDb();
  const t = xeroInvoiceFollowUpsTable;

  const [before] = await db.select().from(t).where(and(eq(t.xeroTenantId, tenantId), eq(t.xeroInvoiceId, invoiceId))).limit(1);
  const [saved] = await db
    .insert(t)
    .values({
      xeroTenantId: tenantId,
      xeroInvoiceId: invoiceId,
      invoiceNumber: data.invoiceNumber ?? null,
      contactName: data.contactName ?? null,
      outcome: data.outcome,
      nextChaseDate: data.nextChaseDate ?? null,
      promisedDate: data.promisedDate ?? null,
      updatedBy: staff?.email ?? null,
    })
    .onConflictDoUpdate({
      target: [t.xeroTenantId, t.xeroInvoiceId],
      set: {
        outcome: data.outcome,
        nextChaseDate: data.nextChaseDate ?? null,
        promisedDate: data.promisedDate ?? null,
        updatedBy: staff?.email ?? null,
        invoiceNumber: sql`coalesce(excluded.invoice_number, ${t.invoiceNumber})`,
        contactName: sql`coalesce(excluded.contact_name, ${t.contactName})`,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  if (note || before?.outcome !== data.outcome) {
    await db.insert(xeroInvoiceFollowUpNotesTable).values({ followUpId: saved.id, outcome: data.outcome, note, authorEmail: staff?.email ?? null });
  }
  await db
    .insert(auditLogTable)
    .values({
      actorEmail: staff?.email ?? null,
      actorUserId: staff?.userId ?? null,
      action: "invoice_follow_up.update",
      tableName: "xero_invoice_follow_ups",
      recordId: saved.id,
      before: before ?? null,
      after: { ...saved, note },
      requestId: req.id !== undefined && req.id !== null ? String(req.id) : null,
      ipAddress: req.ip ?? null,
    })
    .catch((error: unknown) => req.log.error({ err: error }, "Could not write the audit log entry"));

  const view = (await loadFollowUps([invoiceId]))?.get(`${tenantId}|${invoiceId}`);
  res.json(UpdateInvoiceFollowUpResponse.parse(view));
});

export default receivablesRouter;
