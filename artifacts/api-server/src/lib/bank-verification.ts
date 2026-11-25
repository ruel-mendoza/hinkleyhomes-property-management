import { and, eq, ne } from "drizzle-orm";
import { auditLogTable, exceptionQueueTable, getDb, supplierBankDetailsTable, suppliersTable } from "@workspace/db";
import { maskAccount } from "./bill-checks";

// Supplier bills > Alerts: a person marks new or changed supplier bank details
// as verified after phoning the supplier on a number already held. Only
// verified details are used in a Telleroo file (lib/telleroo-file.ts) and stop
// the bill checks flagging the account. Two people are needed: whoever
// submitted the details can't verify them (details read from a bill are
// submitted by the system, so any staff member can verify those).

export const VERIFIABLE_CODES = ["bank_details_new", "bank_details_changed"];

export class BankVerificationError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409) {
    super(message);
  }
}

export async function verifyBankDetails(input: { alertId: string; phoneNumber: string; note: string; staffEmail: string | null; staffUserId: string | null; requestId: string | null; ip: string | null }) {
  if (!input.staffEmail) throw new BankVerificationError("Your email couldn't be read, so the verification can't be recorded.", 403);
  const db = getDb();
  const q = exceptionQueueTable;
  const [alert] = await db.select().from(q).where(eq(q.id, input.alertId)).limit(1);
  const code = (alert?.details as Record<string, unknown> | null)?.code;
  if (!alert || alert.sourceTable !== "supplier_bank_details" || !VERIFIABLE_CODES.includes(String(code))) throw new BankVerificationError("This alert isn't about bank details that can be verified.", 404);

  const b = supplierBankDetailsTable;
  const [bank] = await db.select().from(b).where(eq(b.id, alert.sourceId)).limit(1);
  if (!bank) throw new BankVerificationError("The bank details for this alert are no longer on file.", 404);
  if (bank.verifiedAt) throw new BankVerificationError(`These bank details were already verified by ${bank.verifiedBy ?? "someone"}.`, 409);
  if (bank.submittedBy.toLowerCase() === input.staffEmail.toLowerCase()) throw new BankVerificationError("You entered these bank details, so someone else needs to verify them.", 403);

  const [supplier] = await db.select({ name: suppliersTable.name }).from(suppliersTable).where(eq(suppliersTable.id, bank.supplierId)).limit(1);
  const account = maskAccount({ sortCode: bank.sortCode, accountNumber: bank.accountNumber });
  const phone = input.phoneNumber.trim();
  const note = input.note.trim();
  const resolution = `Bank details ${account} verified: phoned ${phone}. ${note}`.slice(0, 1000);
  const now = new Date();

  return db.transaction(async (tx) => {
    // The supplier's other accounts stop being current; only one can be active.
    const retired = await tx.update(b).set({ isActive: false }).where(and(eq(b.supplierId, bank.supplierId), ne(b.id, bank.id), eq(b.isActive, true))).returning({ id: b.id, sortCode: b.sortCode, accountNumber: b.accountNumber });
    await tx.update(b).set({ isActive: true, verifiedBy: input.staffEmail, verifiedAt: now }).where(eq(b.id, bank.id));
    // Every open alert about this account is answered by the one call.
    const resolved = await tx
      .update(q)
      .set({ status: "resolved", resolvedBy: input.staffEmail, resolvedAt: now, resolution })
      .where(and(eq(q.sourceTable, "supplier_bank_details"), eq(q.sourceId, bank.id), eq(q.status, "open")))
      .returning();
    await tx.insert(auditLogTable).values({
      actorEmail: input.staffEmail,
      actorUserId: input.staffUserId,
      action: "supplier_bank_details.verify",
      tableName: "supplier_bank_details",
      recordId: bank.id,
      before: { isActive: bank.isActive, verifiedBy: null, retired: retired.map((row) => ({ id: row.id, account: maskAccount(row) })) },
      after: { supplier: supplier?.name ?? null, account, isActive: true, verifiedBy: input.staffEmail, phoneNumber: phone, note, alertsResolved: resolved.map((row) => row.id) },
      requestId: input.requestId,
      ipAddress: input.ip,
    });
    return resolved.find((row) => row.id === alert.id) ?? { ...alert, status: "resolved" as const, resolvedBy: input.staffEmail, resolvedAt: now, resolution };
  });
}
