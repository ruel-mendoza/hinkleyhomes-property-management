import { desc } from "drizzle-orm";
import { getDb, supplierBankDetailsTable, suppliersTable, tellerooFileBillsTable, tellerooPayRunsTable, type SupplierBankDetails } from "@workspace/db";
import { supplierKey } from "./bill-checks";

// Payee check: the bank details Telleroo last paid each payee, compared with the
// supplier's verified bank details on file. Telleroo's partner API has no payee
// list, so the details come from pay runs n8n has already saved in
// telleroo_pay_runs (sort code and the account number's last 4 digits only).
//
// A payment is tied to a supplier by its reference and amount (a Telleroo file
// from To pay records both in telleroo_file_bills), or else by payee name
// against supplier names and the names on their bank details.

export type PayeeStatus = "match" | "differs" | "old" | "unverified" | "missing" | "unknown";

export type PayeeCheck = {
  key: string;
  supplierId: string | null;
  supplier: string | null;
  payeeName: string;
  status: PayeeStatus;
  // What Telleroo paid, and what is on file (last 4 digits of the account only).
  tellerooAccount: string;
  fileAccount: string | null;
  sortCodeDiffers: boolean;
  paidAt: string | null;
  payRunName: string | null;
  tellerooUrl: string | null;
};

const digits = (value: string | null | undefined) => String(value ?? "").replace(/\D/g, "");
const last4 = (value: string) => digits(value).slice(-4);
const shown = (accountLast4: string | null) => (accountLast4 ? `…${accountLast4}` : "unknown");
const money = (value: string | null) => (value === null || value === "" || Number.isNaN(Number(value)) ? null : Number(value).toFixed(2));
const sameDetails = (bank: SupplierBankDetails, accountLast4: string | null, sortCode: string | null) =>
  !!accountLast4 && last4(bank.accountNumber) === accountLast4 && (!sortCode || digits(bank.sortCode) === sortCode);

export async function payeeChecks(): Promise<PayeeCheck[]> {
  const db = getDb();
  const [runs, suppliers, banks, fileBills] = await Promise.all([
    db.select().from(tellerooPayRunsTable).orderBy(desc(tellerooPayRunsTable.tellerooCreatedAt), desc(tellerooPayRunsTable.createdAt)),
    db.select({ id: suppliersTable.id, name: suppliersTable.name }).from(suppliersTable),
    db.select().from(supplierBankDetailsTable).orderBy(desc(supplierBankDetailsTable.createdAt)),
    db.select({ reference: tellerooFileBillsTable.reference, amount: tellerooFileBillsTable.amount, supplierName: tellerooFileBillsTable.supplierName }).from(tellerooFileBillsTable).orderBy(desc(tellerooFileBillsTable.createdAt)),
  ]);

  const nameOf = new Map(suppliers.map((s) => [s.id, s.name]));
  const byName = new Map<string, string>();
  for (const s of suppliers) byName.set(supplierKey(s.name), s.id);
  for (const bank of banks) if (!byName.has(supplierKey(bank.accountName))) byName.set(supplierKey(bank.accountName), bank.supplierId);
  const byFile = new Map<string, string>();
  for (const bill of fileBills) {
    const key = `${bill.reference.toLowerCase()}|${money(bill.amount)}`;
    if (!byFile.has(key)) byFile.set(key, bill.supplierName);
  }
  const findSupplier = (reference: string | null, amount: string | null, payeeName: string) => {
    const fromFile = reference ? byFile.get(`${reference.toLowerCase()}|${money(amount)}`) : undefined;
    return (fromFile ? byName.get(supplierKey(fromFile)) : undefined) ?? byName.get(supplierKey(payeeName)) ?? null;
  };

  // Newest payment to each payee; pay runs are already newest first.
  const checks = new Map<string, PayeeCheck>();
  for (const run of runs) {
    for (const payment of run.payments) {
      if (payment.state === "rejected" || !payment.payeeName) continue;
      const supplierId = findSupplier(payment.reference, payment.amount, payment.payeeName);
      const key = supplierId ?? payment.payeeId ?? `name:${supplierKey(payment.payeeName)}`;
      if (checks.has(key)) continue;
      const sortCode = digits(payment.sortCode) || null;
      const supplierBanks = supplierId ? banks.filter((bank) => bank.supplierId === supplierId) : [];
      const verified = supplierBanks.find((bank) => bank.isActive && bank.verifiedAt);
      let status: PayeeStatus;
      if (!supplierId) status = "unknown";
      else if (verified) status = sameDetails(verified, payment.accountLast4, sortCode) ? "match" : supplierBanks.some((bank) => bank !== verified && sameDetails(bank, payment.accountLast4, sortCode)) ? "old" : "differs";
      else status = supplierBanks.length ? "unverified" : "missing";
      checks.set(key, {
        key,
        supplierId,
        supplier: supplierId ? nameOf.get(supplierId) ?? null : null,
        payeeName: payment.payeeName,
        status,
        tellerooAccount: shown(payment.accountLast4),
        fileAccount: verified ? shown(last4(verified.accountNumber)) : null,
        sortCodeDiffers: !!verified && !!sortCode && digits(verified.sortCode) !== sortCode,
        paidAt: (run.tellerooCreatedAt ?? run.createdAt).toISOString(),
        payRunName: run.name,
        tellerooUrl: run.tellerooUrl,
      });
    }
  }
  return [...checks.values()];
}
