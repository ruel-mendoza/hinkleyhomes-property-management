import { and, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { getDb, supplierBankDetailsTable, suppliersTable, tellerooFileBillsTable } from "@workspace/db";
import { COMPANIES } from "../routes/money";
import { supplierKey } from "./bill-checks";
import { payeeChecks } from "./telleroo-payees";
import { xeroGatewayRequest } from "./xero-gateway";

// Telleroo pay run upload file for Supplier bills > To pay. Staff tick bills,
// the app re-reads each one in Xero and builds Telleroo's CSV
// (amount_pounds,recipient_name,account_no,sort_code,reference), one payment
// per bill with the supplier's invoice number as the reference. Staff upload
// it in Telleroo (New pay run), where it is approved as usual.
//
// The file is the one place the app hands full bank details to the browser
// (agreed with the user, 25 Nov 2026), so only bank details a person has
// verified are used, the file is never stored, and each download is recorded
// in telleroo_file_bills and audit_log without the bank numbers.

const REPEAT_DAYS = 30;
// Telleroo (25 Nov 2026): up to 18 characters of letters, numbers, spaces and
// hyphens; other characters become a hyphen, and a longer reference rejects the row.
// The same replacement is done here so the reference recorded matches what is sent.
const REFERENCE_MAX = 18;
// Telleroo takes 1p to £250,000 per payment.
const PAYMENT_MAX = 250_000;
const reference = (number: string | null) =>
  (number ?? "").replace(/[^A-Za-z0-9 -]+/g, "-").replace(/\s+/g, " ").replace(/-{2,}/g, "-").replace(/^[\s-]+|[\s-]+$/g, "").slice(0, REFERENCE_MAX).replace(/[\s-]+$/g, "") || "HINKLEY HOMES";

// Telleroo's payee name rules (partner docs, "Payee Validations"): a business
// with a common one-word name ("Andrew", "Charlie") can be rejected unless the
// business type follows it ("Andrew Ltd"); a person needs a first and last name
// of at least 2 letters each, in letters, hyphens, underscores, brackets,
// apostrophes, asterisks, commas and dots only. The payee type is picked per
// file at upload, so these are warnings rather than reasons to leave a bill out.
const NAME_MAX = 255;
const BUSINESS_WORDS = /\b(ltd|limited|llp|plc|cic|inc|co|company|group|services?|trading|t\/a|solutions|uk|partners(hip)?|associates|contractors?|builders?|electrical|plumbing|heating|cleaning|maintenance|properties|lettings|estates?)\b|&/i;
export function payeeNameWarning(name: string): string | null {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (BUSINESS_WORDS.test(name)) return null;
  if (words.length === 1) return `Telleroo may reject the one-word payee name "${name}" as too common. If it does, add the business type in Telleroo (e.g. "${name} Ltd").`;
  if (words.some((word) => /^\p{L}\.?$/u.test(word))) return `If uploaded as Supplier - Person, Telleroo may reject "${name}": each name needs at least 2 letters, so initials aren't enough.`;
  if (/[^\p{L}\s\-_()'*,.]/u.test(name)) return `If uploaded as Supplier - Person, Telleroo may reject "${name}": a person's name can only have letters and - _ ( ) ' * , .`;
  return null;
}

type RecordValue = Record<string, unknown>;
const asRecord = (value: unknown): RecordValue => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {});
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const round = (value: number) => Math.round(value * 100) / 100;
// Quote a CSV cell when needed; a leading = + - @ is neutralised so spreadsheets don't run it.
const cell = (value: string) => (/[",\r\n]/.test(value) || /^[=+\-@]/.test(value) ? `"${value.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : value);
const when = (date: Date) => date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });

export type FileBill = { tenantId: string; billId: string; company: string; supplier: string; number: string | null; amount: number | null; reason: string | null; repeat: boolean; warning: string | null };

export class TellerooFileError extends Error {}

// Re-reads the chosen bills, one gateway call per company (Xero takes up to 100 ids).
async function readBills(tenantId: string, billIds: string[]): Promise<Map<string, RecordValue>> {
  const found = new Map<string, RecordValue>();
  for (let i = 0; i < billIds.length; i += 100) {
    const response = await xeroGatewayRequest({ tenantId, resource: "invoices", query: { IDs: billIds.slice(i, i + 100).join(","), pageSize: 100 } });
    if (!response.ok) throw new TellerooFileError(response.status === 429 ? "Xero is rate limiting; try again in a minute." : `Xero returned HTTP ${response.status}.`);
    for (const bill of Array.isArray(asRecord(response.data).Invoices) ? (asRecord(response.data).Invoices as unknown[]) : []) {
      const record = asRecord(bill);
      if (typeof record.InvoiceID === "string") found.set(record.InvoiceID.toLowerCase(), record);
    }
  }
  return found;
}

export async function buildTellerooFile(input: { bills: { tenantId: string; billId: string }[]; includeRepeats?: boolean; staffEmail: string | null }) {
  const db = getDb();
  const chosen = [...new Map(input.bills.map((bill) => [`${bill.tenantId}|${bill.billId.toLowerCase()}`, bill])).values()];
  const unknownCompany = chosen.find((bill) => !COMPANIES.some((company) => company.tenantId === bill.tenantId));
  if (unknownCompany) throw new TellerooFileError("One of the bills belongs to a company the app doesn't know.");

  // 1. The bills as Xero has them now.
  const xero = new Map<string, RecordValue>();
  for (const company of COMPANIES) {
    const ids = chosen.filter((bill) => bill.tenantId === company.tenantId).map((bill) => bill.billId);
    if (!ids.length) continue;
    for (const [id, bill] of await readBills(company.tenantId, ids)) xero.set(`${company.tenantId}|${id}`, bill);
  }

  // 2. Verified bank details for each supplier, matched like the bill checks do (Xero contact, then name).
  const suppliers = await db.select({ id: suppliersTable.id, name: suppliersTable.name, xeroContactId: suppliersTable.xeroContactId }).from(suppliersTable);
  const byContact = new Map(suppliers.filter((s) => s.xeroContactId).map((s) => [s.xeroContactId!.toLowerCase(), s.id]));
  const byKey = new Map(suppliers.map((s) => [supplierKey(s.name), s.id]));
  const b = supplierBankDetailsTable;
  const bankRows = await db.select().from(b).where(and(eq(b.isActive, true), isNotNull(b.verifiedAt)));
  const verified = new Map(bankRows.map((row) => [row.supplierId, row]));
  const anyBank = new Set((await db.select({ supplierId: b.supplierId }).from(b)).map((row) => row.supplierId));

  // Where Telleroo last paid each supplier, so a change of account is pointed out before approval.
  const lastPaid = new Map((await payeeChecks()).filter((payee) => payee.supplierId).map((payee) => [payee.supplierId!, payee]));

  // 3. Bills already put in a file recently.
  const f = tellerooFileBillsTable;
  const since = new Date(Date.now() - REPEAT_DAYS * 86_400_000);
  const earlier = chosen.length
    ? await db.select().from(f).where(and(inArray(f.xeroBillId, chosen.map((bill) => bill.billId.toLowerCase())), gte(f.createdAt, since))).orderBy(desc(f.createdAt))
    : [];

  const included: (FileBill & { row: string; reference: string; amount: number })[] = [];
  const skipped: FileBill[] = [];
  for (const choice of chosen) {
    const company = COMPANIES.find((item) => item.tenantId === choice.tenantId)!;
    const bill = xero.get(`${choice.tenantId}|${choice.billId.toLowerCase()}`);
    const contact = asRecord(bill?.Contact);
    const base = { tenantId: choice.tenantId, billId: choice.billId, company: company.name, supplier: str(contact.Name) ?? "Unknown supplier", number: str(bill?.InvoiceNumber), amount: bill ? round(Number(bill.AmountDue) || 0) : null, repeat: false, warning: null as string | null };
    const skip = (reason: string, repeat = false) => skipped.push({ ...base, reason, repeat });
    if (!bill) { skip("Not found in Xero."); continue; }
    if (bill.Type !== "ACCPAY") { skip("Not a supplier bill."); continue; }
    if (bill.Status !== "AUTHORISED") { skip(bill.Status === "PAID" ? "Already paid in Xero." : "Not approved in Xero yet."); continue; }
    if (!base.amount || base.amount <= 0) { skip("Nothing left to pay in Xero."); continue; }
    if (str(bill.CurrencyCode) && bill.CurrencyCode !== "GBP") { skip(`Bill is in ${String(bill.CurrencyCode)}, not pounds.`); continue; }
    if (base.amount > PAYMENT_MAX) { skip("Over Telleroo's £250,000 limit for one payment."); continue; }

    const supplierId = (str(contact.ContactID) ? byContact.get(String(contact.ContactID).toLowerCase()) : undefined) ?? byKey.get(supplierKey(base.supplier));
    const bank = supplierId ? verified.get(supplierId) : undefined;
    if (!bank) { skip(supplierId && anyBank.has(supplierId) ? "Bank details not verified yet (see Alerts)." : "No bank details on file for this supplier."); continue; }
    const sortCode = bank.sortCode.replace(/\D/g, "");
    const accountNo = bank.accountNumber.replace(/\D/g, "");
    if (sortCode.length !== 6 || accountNo.length !== 8) { skip("Bank details on file aren't a UK sort code and 8-digit account number."); continue; }

    const before = earlier.find((row) => row.xeroTenantId === choice.tenantId && row.xeroBillId === choice.billId.toLowerCase());
    if (before && !input.includeRepeats) { skip(`Already in a Telleroo file on ${when(before.createdAt)}${before.downloadedBy ? ` by ${before.downloadedBy}` : ""}.`, true); continue; }

    const recipient = bank.accountName.trim() || base.supplier;
    if (recipient.length > NAME_MAX) { skip("The bank account name is longer than Telleroo allows (255 characters)."); continue; }
    const paid = lastPaid.get(bank.supplierId);
    const warnings = [
      paid && paid.status !== "match" ? `Telleroo last paid this supplier to account ${paid.tellerooAccount}${paid.sortCodeDiffers ? " (different sort code)" : ""}, not ${paid.fileAccount ?? `…${accountNo.slice(-4)}`} on file. Check before approving.` : null,
      payeeNameWarning(recipient),
    ].filter(Boolean);
    base.warning = warnings.length ? warnings.join(" ") : null;
    const ref = reference(base.number);
    included.push({ ...base, amount: base.amount, reason: null, reference: ref, row: [base.amount.toFixed(2), recipient, accountNo, sortCode, ref].map(cell).join(",") });
  }

  const stamp = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date()).replace(/[^\d]/g, "").slice(0, 12);
  const fileName = `telleroo-pay-run-${stamp}.csv`;
  const total = round(included.reduce((sum, bill) => sum + bill.amount, 0));
  if (included.length) {
    await db.insert(f).values(included.map((bill) => ({
      xeroTenantId: bill.tenantId, xeroBillId: bill.billId.toLowerCase(), billNumber: bill.number, supplierName: bill.supplier,
      amount: bill.amount.toFixed(2), reference: bill.reference, fileName, downloadedBy: input.staffEmail,
    })));
  }
  return {
    fileName,
    csv: included.length ? ["amount_pounds,recipient_name,account_no,sort_code,reference", ...included.map((bill) => bill.row)].join("\r\n") + "\r\n" : null,
    total,
    included: included.map(({ row: _row, reference: _reference, ...bill }) => bill),
    skipped,
  };
}
