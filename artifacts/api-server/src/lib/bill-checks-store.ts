import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import {
  auditLogTable,
  exceptionQueueTable,
  getDb,
  supplierBankDetailsTable,
  suppliersTable,
  xeroBillHistoryTable,
} from "@workspace/db";
import {
  DEFAULT_OPTIONS,
  bankFlag,
  ibanOnlyFlag,
  isCheckedStatus,
  maskAccount,
  priceFlags,
  pricedLines,
  supplierKey,
  ukAccount,
  type CheckOptions,
  type Flag,
  type IncomingBill,
  type KnownAccount,
  type PastBill,
  type UkAccount,
} from "./bill-checks";

// Runs the bill checks against stored history and records the results:
// - every bill goes to xero_bill_history (later runs compare against it);
// - a bank account not seen before goes to supplier_bank_details as inactive
//   and unverified, with an audit_log entry;
// - each flag raises one exception_queue row (a re-sent bill or a repeat of the
//   same account doesn't raise another). Bank flags are still returned on every
//   run until the account is verified.

export type BillFlag = Flag & {
  tenantId: string;
  billId: string;
  company: string;
  supplier: string;
  number: string | null;
  isNew: boolean;
};

// Named in the audit log for changes made by the scheduled check.
const ACTOR = "n8n bill check";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

const sameAccount = (a: UkAccount) => (k: KnownAccount) => k.sortCode === a.sortCode && k.accountNumber === a.accountNumber;

export async function checkAndRecordBills(bills: IncomingBill[], opts: CheckOptions = DEFAULT_OPTIONS, requestId: string | null = null): Promise<BillFlag[]> {
  return getDb().transaction(async (tx) => {
    const audit = (action: string, tableName: string, recordId: string, after: unknown) =>
      tx.insert(auditLogTable).values({ actorEmail: ACTOR, action, tableName, recordId, before: null, after, requestId });
    const h = xeroBillHistoryTable;
    const q = exceptionQueueTable;
    const flagged: BillFlag[] = [];
    const describe = (bill: IncomingBill, flag: Flag) => ({
      check: flag.check,
      code: flag.code,
      severity: flag.severity,
      tenantId: bill.tenantId,
      billId: bill.billId,
      company: bill.company,
      supplier: bill.supplier,
      number: bill.number,
    });
    const summary = (bill: IncomingBill, flag: Flag) => `${bill.supplier} (${bill.company}) bill ${bill.number ?? bill.billId}: ${flag.message}`;

    // 1. Price history for these suppliers, then this run's bills saved into it.
    const keys = [...new Set(bills.map((bill) => supplierKey(bill.supplier)))];
    const earliest = bills.reduce((min, bill) => (bill.date && bill.date < min ? bill.date : min), new Date().toISOString().slice(0, 10));
    const since = new Date(Date.parse(`${earliest}T00:00:00Z`) - opts.lookbackDays * 86_400_000).toISOString().slice(0, 10);
    const history: PastBill[] = (await tx.select().from(h).where(and(inArray(h.supplierKey, keys), gte(h.billDate, since)))).map((row) => ({
      tenantId: row.xeroTenantId,
      billId: row.xeroBillId,
      supplierKey: row.supplierKey,
      billDate: row.billDate,
      total: row.total === null ? null : Number(row.total),
      currency: row.currency,
      status: row.status,
      lines: row.lines,
    }));
    const billFlags = bills.map((bill) => ({
      bill,
      flags: [...priceFlags(bill, history, opts), ...(isCheckedStatus(bill.status) ? [ibanOnlyFlag(bill.bank)] : [])].filter((flag): flag is Flag => flag !== null),
    }));

    const saved = await tx
      .insert(h)
      .values(
        bills.map((bill) => ({
          xeroTenantId: bill.tenantId,
          xeroBillId: bill.billId,
          company: bill.company,
          supplierName: bill.supplier,
          supplierKey: supplierKey(bill.supplier),
          billNumber: bill.number,
          billDate: bill.date,
          total: bill.total === null ? null : bill.total.toFixed(2),
          currency: bill.currency,
          status: bill.status,
          lines: pricedLines(bill),
        })),
      )
      .onConflictDoUpdate({
        target: [h.xeroTenantId, h.xeroBillId],
        set: {
          company: sql`excluded.company`,
          supplierName: sql`excluded.supplier_name`,
          supplierKey: sql`excluded.supplier_key`,
          billNumber: sql`excluded.bill_number`,
          billDate: sql`excluded.bill_date`,
          total: sql`excluded.total`,
          currency: sql`excluded.currency`,
          status: sql`excluded.status`,
          lines: sql`excluded.lines`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: h.id, tenantId: h.xeroTenantId, billId: h.xeroBillId });
    const rowId = new Map(saved.map((row) => [`${row.tenantId}|${row.billId}`, row.id]));

    // 2. Price and IBAN flags: one exception per bill and check.
    const raised = new Set(
      (await tx
        .select({ sourceId: q.sourceId, details: q.details })
        .from(q)
        .where(and(eq(q.sourceTable, "xero_bill_history"), inArray(q.sourceId, [...rowId.values()]))))
        .map((row) => `${row.sourceId}|${(row.details as { check?: string } | null)?.check}`),
    );
    const newExceptions: (typeof q.$inferInsert)[] = [];
    for (const { bill, flags } of billFlags) {
      const sourceId = rowId.get(`${bill.tenantId}|${bill.billId}`)!;
      for (const flag of flags) {
        const isNew = !raised.has(`${sourceId}|${flag.check}`);
        if (isNew) {
          raised.add(`${sourceId}|${flag.check}`);
          newExceptions.push({
            kind: flag.code === "bank_details_unchecked" ? "bank_detail_change" : "invoice_variance",
            sourceTable: "xero_bill_history",
            sourceId,
            summary: summary(bill, flag),
            details: describe(bill, flag),
          });
        }
        flagged.push({ ...flag, tenantId: bill.tenantId, billId: bill.billId, company: bill.company, supplier: bill.supplier, number: bill.number, isNew });
      }
    }
    if (newExceptions.length) await tx.insert(q).values(newExceptions);

    // 3. UK bank details, checked against what the app holds for the supplier.
    const banked = bills.filter((bill) => isCheckedStatus(bill.status) && ukAccount(bill.bank));
    if (!banked.length) return flagged;
    const suppliers = await tx.select({ id: suppliersTable.id, name: suppliersTable.name, xeroContactId: suppliersTable.xeroContactId }).from(suppliersTable);
    const byKey = new Map(suppliers.map((s) => [supplierKey(s.name), s.id]));
    const byContact = new Map(suppliers.filter((s) => s.xeroContactId).map((s) => [s.xeroContactId!.toLowerCase(), s.id]));
    const knownBySupplier = new Map<string, KnownAccount[]>();
    const raisedForAccount = new Set<string>();

    for (const bill of banked) {
      const account = ukAccount(bill.bank)!;
      const key = supplierKey(bill.supplier);
      let supplierId = (bill.contactId ? byContact.get(bill.contactId) : undefined) ?? byKey.get(key);
      if (!supplierId) {
        supplierId = await createSupplier(tx, bill, audit);
        byKey.set(key, supplierId);
      }

      let known = knownBySupplier.get(supplierId);
      if (!known) {
        const t = supplierBankDetailsTable;
        known = (await tx.select().from(t).where(eq(t.supplierId, supplierId)).orderBy(desc(t.createdAt))).map((row) => ({
          id: row.id,
          sortCode: row.sortCode.replace(/\D/g, ""),
          accountNumber: row.accountNumber.replace(/\D/g, ""),
          isActive: row.isActive,
          verified: row.verifiedBy !== null && row.verifiedAt !== null,
        }));
        knownBySupplier.set(supplierId, known);
      }

      const flag = bankFlag(account, known);
      let row = known.find(sameAccount(account));
      if (!row) {
        const [inserted] = await tx
          .insert(supplierBankDetailsTable)
          .values({
            supplierId,
            accountName: bill.bank?.accountName?.trim() || bill.supplier,
            sortCode: account.sortCode,
            accountNumber: account.accountNumber,
            isActive: false,
            submittedBy: ACTOR,
          })
          .returning({ id: supplierBankDetailsTable.id });
        row = { id: inserted.id, ...account, isActive: false, verified: false };
        known.unshift(row);
        await audit("supplier_bank_details.record_from_bill", "supplier_bank_details", row.id, {
          supplierId,
          account: maskAccount(account),
          accountName: bill.bank?.accountName ?? null,
          bill: { tenantId: bill.tenantId, billId: bill.billId, number: bill.number },
        });
      }
      if (!flag) continue;

      let isNew = false;
      if (!raisedForAccount.has(row.id)) {
        raisedForAccount.add(row.id);
        const [existing] = await tx
          .select({ id: q.id })
          .from(q)
          .where(and(eq(q.sourceTable, "supplier_bank_details"), eq(q.sourceId, row.id)))
          .limit(1);
        if (!existing) {
          isNew = true;
          await tx.insert(q).values({
            kind: "bank_detail_change",
            sourceTable: "supplier_bank_details",
            sourceId: row.id,
            summary: summary(bill, flag),
            details: { ...describe(bill, flag), account: maskAccount(account) },
          });
        }
      }
      flagged.push({ ...flag, tenantId: bill.tenantId, billId: bill.billId, company: bill.company, supplier: bill.supplier, number: bill.number, isNew });
    }
    return flagged;
  });
}

async function createSupplier(tx: Tx, bill: IncomingBill, audit: (action: string, tableName: string, recordId: string, after: unknown) => Promise<unknown>): Promise<string> {
  const values = { name: bill.supplier.trim(), kind: "other" as const, xeroContactId: bill.contactId };
  const [created] = await tx.insert(suppliersTable).values(values).onConflictDoNothing().returning({ id: suppliersTable.id });
  if (created) {
    await audit("supplier.create_from_bill", "suppliers", created.id, values);
    return created.id;
  }
  // Lost a race on the name, or the contact is already held under another name.
  const s = suppliersTable;
  const [existing] = await tx
    .select({ id: s.id })
    .from(s)
    .where(values.xeroContactId ? or(eq(s.name, values.name), eq(s.xeroContactId, values.xeroContactId)) : eq(s.name, values.name))
    .limit(1);
  if (!existing) throw new Error(`Supplier "${values.name}" could not be created.`);
  return existing.id;
}
