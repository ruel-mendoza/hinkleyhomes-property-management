import { inflateRawSync } from "node:zlib";

// The accounts-inbox intake check, ported from the n8n workflow
// "Hinkley Intake check: accounts inbox, bounce unclear invoices v3.1" so the
// app's backup check (lib/intake-fallback.ts) decides exactly as n8n does.
// Rules decide; the AI only reads the invoice. Keep both in step: a change to
// the n8n Config or "Check invoice" step belongs here too.

export const INTAKE_CONFIG = {
  reviewerEmail: "ruel@hinkleyhomes.co.uk",
  accountsMailbox: "accounts@hinkleyhomes.co.uk",
  companyNames: ["Hinkley Homes Management", "Hinkley Homes Stays Ltd", "Hinkley Homes Lettings Ltd", "Hinkley Homes Ltd", "Hinkley Homes Holdings"],
  companyCostWords: "subscription,licence,license,software,xero,quickbooks,sage,accountancy,accounts fee,bookkeeping,payroll,year end,year-end,tax return,corporation tax,vat return,companies house,confirmation statement,insurance,bank charge,hosting,domain",
  internalDomain: "hinkleyhomes.co.uk",
  blockedSenderPatterns: "noreply,no-reply,donotreply,do-not-reply,mailer-daemon,postmaster",
  legibilityMin: 0.8,
  maxBouncesPerInvoice: 2,
  maxBouncesPerSenderPerDay: 5,
  bounceCc: "",
  senderName: "Hinkley Homes Accounts",
  noreplyAddress: "no-reply@hinkleyhomes.co.uk",
  invoiceFilesDriveId: "b!ScePe1_mFEmyTGy6pKrtSTSDsNZL6F9HijMzDGBOvBNZCqggk73FTas7eYOOqd2m",
  invoiceFilesFolder: "Hinkley Data Tables/Invoices",
  categories: {
    pass: "n8n: invoice OK",
    notInvoice: "n8n: not an invoice",
    review: "n8n: needs review",
    bounced: "n8n: bounced - awaiting corrected invoice",
    drafted: "n8n: bounce drafted",
    shadow: "n8n: would bounce (shadow)",
  },
} as const;

// Company aliases are stored by Xero organisation; the n8n step names them like this.
export const XERO_ORGANISATION_NAMES: Record<string, string> = {
  "0a290129-b001-4bfb-903d-d27a8ac55738": "Hinkley Homes Management",
  "47f65b32-d0d7-4417-bb5c-89ff2d93651e": "Hinkley Homes Lettings",
  "4c807578-e0a7-49ad-9644-8e705aec0c2a": "Hinkley Homes Stays Ltd",
  "9d1fee42-4203-47d8-87aa-6fa8e8ac0fef": "Hinkley Homes Ltd",
  "3ae8a283-c7e0-4287-9bcd-4c2561295890": "Hinkley Homes Holdings",
};

export type Mode = "shadow" | "draft" | "live";

/* eslint-disable @typescript-eslint/no-explicit-any -- the AI reading is loose JSON, handled as the n8n step does */
export type Extraction = Record<string, any>;

// ---- the email ------------------------------------------------------------

export type GraphMessage = {
  id: string;
  subject?: string | null;
  from?: { emailAddress?: { name?: string; address?: string } } | null;
  receivedDateTime?: string;
  internetMessageId?: string;
  hasAttachments?: boolean;
  body?: { contentType?: string; content?: string } | null;
  categories?: string[];
  webLink?: string;
};

export type GraphAttachment = { "@odata.type"?: string; name?: string; contentType?: string; size?: number; isInline?: boolean; contentBytes?: string };

export function bodyToText(body: GraphMessage["body"] | string | undefined | null): string {
  if (!body) return "";
  const raw = typeof body === "string" ? body : body.content || "";
  const isHtml = typeof body === "object" ? String(body.contentType || "").toLowerCase() === "html" : /<[a-z][^>]*>/i.test(raw);
  if (!isHtml) return raw.trim();
  return raw
    .replace(/<(script|style|head)[^>]*>[^]*?<\/\1>/gi, " ")
    .replace(/<br[^>]*>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&pound;/gi, "£").replace(/&euro;/gi, "€").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n[ \n]*/g, "\n")
    .trim();
}

// n8n's "Ignore emails sent from accounts inbox": our own emails are skipped unless they are forwards.
export function isFromAccountsAndNotForward(message: GraphMessage): boolean {
  const from = String(message.from?.emailAddress?.address || "").trim().toLowerCase();
  return from === INTAKE_CONFIG.accountsMailbox && !/^\s*(fw|fwd)\s*:/i.test(String(message.subject || ""));
}

export type Source = {
  from: string;
  from_email: string;
  forwarded_by?: string;
  subject: string;
  received_at: string;
  message_id: string;
  outlook_message_id: string;
};

// One document per usable attachment (PDF, image, Word/ODT as text); the email
// body when there is no PDF and it is long enough; signature and logo images skipped.
export type IntakeDocument = Source & {
  source_type: "attachment" | "document_text" | "email_body";
  filename: string;
  mime_type: string;
  body_text?: string;
  data?: Buffer;
  original?: Buffer;
};

const OK = ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"];
const ODT = "application/vnd.oasis.opendocument.text";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const OFFICE = [ODT, DOCX];
const EXT: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", odt: ODT, docx: DOCX };
const MIN_BODY_CHARS = 150;

export function emailSource(message: GraphMessage): Source {
  const ea = message.from?.emailAddress;
  const fromStr = ea ? (ea.name ? `${ea.name} <${ea.address || ""}>` : ea.address || "") : "";
  const m = fromStr.match(/[\w.+-]+@[\w.-]+\.\w+/);
  const source: Source = {
    from: fromStr,
    from_email: m ? m[0] : "",
    subject: message.subject ?? "",
    received_at: message.receivedDateTime ?? "",
    message_id: message.internetMessageId ?? "",
    outlook_message_id: message.id ?? "",
  };
  // Forwarded by the accounts inbox: use the original sender from the forwarded header.
  const accounts = INTAKE_CONFIG.accountsMailbox;
  if (source.from_email.toLowerCase() === accounts) {
    const fwdText = bodyToText(message.body);
    const re = /From:\s*([^\n<]*?)\s*<([\w.+-]+@[\w.-]+\.\w+)>/gi;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(fwdText)) !== null) {
      if (mm[2].toLowerCase() !== accounts) {
        source.forwarded_by = source.from;
        source.from = `${mm[1] ? `${mm[1].trim()} ` : ""}<${mm[2]}>`;
        source.from_email = mm[2];
        break;
      }
    }
  }
  return source;
}

export function splitDocuments(message: GraphMessage, attachments: GraphAttachment[]): IntakeDocument[] {
  const source = emailSource(message);
  const out: IntakeDocument[] = [];
  let hasPdf = false;
  for (const att of attachments) {
    if (att["@odata.type"] && att["@odata.type"] !== "#microsoft.graph.fileAttachment") continue;
    if (!att.contentBytes) continue;
    const name = String(att.name || "attachment");
    const ext = name.split(".").pop()!.toLowerCase();
    let mime = String(att.contentType || "").toLowerCase();
    if (!OK.includes(mime) && !OFFICE.includes(mime) && EXT[ext]) mime = EXT[ext];
    if (!OK.includes(mime) && !OFFICE.includes(mime)) continue;
    const data = Buffer.from(att.contentBytes, "base64");
    if (mime.startsWith("image/")) {
      const kb = data.length / 1024;
      if (kb < 15 || /^(image\d{3}|outlook-|logo|signature|banner|icon|facebook|linkedin|twitter|instagram)/i.test(name)) continue;
    }
    if (OFFICE.includes(mime)) {
      hasPdf = true;
      out.push({ ...source, source_type: "document_text", filename: name, mime_type: mime, body_text: officeText(data), original: data });
    } else {
      if (mime === "application/pdf") hasPdf = true;
      out.push({ ...source, source_type: "attachment", filename: name, mime_type: mime, data });
    }
  }
  const bodyText = bodyToText(message.body).slice(0, 60000);
  if (!hasPdf && bodyText.length >= MIN_BODY_CHARS) {
    out.push({ ...source, source_type: "email_body", filename: "email-body.txt", mime_type: "text/plain", body_text: bodyText });
  }
  return out;
}

// The readable text of a .docx (word/document.xml) or .odt (content.xml), read
// straight from the zip without a library.
export function officeText(zip: Buffer): string {
  const xml = zipEntry(zip, (name) => name === "word/document.xml" || name === "content.xml");
  if (!xml) return "";
  const NL = "\n";
  return xml.toString("utf8")
    .replace(/<(text:tab|w:tab)[^>]*>/g, " ")
    .replace(/<(text:line-break|w:br)[^>]*>/g, NL)
    .replace(/<\/(text:p|text:h|w:p)>/g, NL)
    .replace(/<\/(table:table-cell|w:tc)>/g, " | ")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .trim()
    .slice(0, 60000);
}

function zipEntry(zip: Buffer, wanted: (name: string) => boolean): Buffer | null {
  try {
    // End of central directory: last 22+ bytes, signature 0x06054b50.
    let eocd = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i -= 1) {
      if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const count = zip.readUInt16LE(eocd + 10);
    let p = zip.readUInt32LE(eocd + 16);
    for (let n = 0; n < count && zip.readUInt32LE(p) === 0x02014b50; n += 1) {
      const method = zip.readUInt16LE(p + 10);
      const size = zip.readUInt32LE(p + 20);
      const nameLen = zip.readUInt16LE(p + 28);
      const extraLen = zip.readUInt16LE(p + 30);
      const commentLen = zip.readUInt16LE(p + 32);
      const local = zip.readUInt32LE(p + 42);
      const name = zip.toString("utf8", p + 46, p + 46 + nameLen);
      if (wanted(name)) {
        const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        const data = zip.subarray(start, start + size);
        return method === 0 ? data : method === 8 ? inflateRawSync(data) : null;
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
  } catch {
    return null;
  }
  return null;
}

// ---- the AI request (same prompt and fingerprint as n8n, so readings are shared) ----

export const EXTRACTION_SYSTEM = "You extract data from supplier invoices for a UK property management business. Return ONLY one JSON object. No markdown fences, no commentary.\n\nRules:\n- Copy values exactly as printed. Never guess or infer a missing value; use null instead.\n- Do NOT decide whether an invoice should be paid or approved.\n- Do NOT work out which property a line belongs to. Copy any property reference (address, house name, flat or unit) exactly as written next to the line, or at invoice level if it is given only once.\n- Dates as YYYY-MM-DD. Amounts as plain numbers (no currency symbols). Currency as a 3-letter code.\n- suggested_category must be one of: Cleaning, Maintenance and repairs, Compliance and safety, Pest control, Waste removal, Furniture and setup, Utilities and broadband, Build and refurbishment, Professional fees, Software and subscriptions, Other.\n- suggested_job_type must be one of: Changeover, Midstay, Deep clean, Call-out, Other, or null if unclear.\n- Invoice decision (be explicit): set is_invoice to true ONLY for a supplier invoice or a supplier credit note. Set document_type to \"invoice\" for an invoice (including a VAT invoice or pro-forma that requests payment) and \"credit_note\" for a credit note (a document titled credit note, credit memo or credit, or one that reduces or refunds an earlier invoice).\n- For a credit note: put the credit note number in invoice_number and its date in invoice_date, copy amounts as positive numbers exactly as printed (do not add minus signs), and put the number of the invoice it credits in credited_invoice_reference (null if not shown).\n- Everything else (a logo, signature image, quote, estimate, statement of account, payment receipt or remittance, order confirmation, reminder letter, or other) is NOT an invoice: set is_invoice to false, set document_type to quote, statement, receipt or other, and fill only document_type and legibility_confidence.\n- If you cannot tell whether the document is an invoice or credit note, set is_invoice to false and explain why in extraction_notes.\n\nSchema:\n{\n  \"is_invoice\": true,\n  \"document_type\": \"invoice | credit_note | quote | statement | receipt | other\",\n  \"credited_invoice_reference\": null,\n  \"legibility_confidence\": 0.0,\n  \"supplier\": {\n    \"name\": null, \"address\": null, \"email\": null, \"phone\": null,\n    \"vat_number\": null, \"company_number\": null,\n    \"bank\": {\"account_name\": null, \"sort_code\": null, \"account_number\": null, \"iban\": null}\n  },\n  \"invoice_number\": null,\n  \"invoice_date\": null,\n  \"due_date\": null,\n  \"quote_or_po_reference\": null,\n  \"addressed_to\": {\"name\": null, \"address\": null},\n  \"currency\": \"GBP\",\n  \"lines\": [\n    {\n      \"description\": null,\n      \"property_reference_as_written\": null,\n      \"service_date\": null,\n      \"quantity\": null,\n      \"net\": null, \"vat\": null, \"gross\": null,\n      \"suggested_category\": null,\n      \"suggested_job_type\": null\n    }\n  ],\n  \"totals\": {\"net\": null, \"vat\": null, \"gross\": null},\n  \"payment_terms\": null,\n  \"extraction_notes\": []\n}\nlegibility_confidence is your own 0 to 1 estimate of how clearly the whole document could be read. Put anything unclear, cut off, handwritten or ambiguous into extraction_notes.";

export const EXTRACTION_ASK = "Extract the invoice fields as specified. Return JSON only.";

function hash53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// What the AI is given for a document: the file (PDF/image) or the text with the
// email details. docHash matches the n8n workflow, so a document read by either is never read again.
export type AiInput = { kind: "pdf" | "image"; base64: string; mime: string; filename: string } | { kind: "text"; text: string };
export function aiRequest(doc: IntakeDocument): { input: AiInput; docHash: string; base64: string } {
  if (typeof doc.body_text === "string") {
    const text = `From: ${doc.from}\nSubject: ${doc.subject}\nReceived: ${doc.received_at}\n\n${doc.body_text}`;
    const base64 = Buffer.from(text, "utf8").toString("base64");
    const intro = doc.source_type === "document_text"
      ? `The invoice (if any) is in the attached document ${doc.filename}, converted to plain text below together with the email details:`
      : "The invoice (if any) is in the body of this email, not an attachment. Email content:";
    return { input: { kind: "text", text: `${intro}\n\n${text}` }, docHash: `${hash53(base64)}-${base64.length}`, base64 };
  }
  const base64 = doc.data!.toString("base64");
  return {
    input: doc.mime_type === "application/pdf" ? { kind: "pdf", base64, mime: doc.mime_type, filename: doc.filename } : { kind: "image", base64, mime: doc.mime_type, filename: doc.filename },
    docHash: `${hash53(base64)}-${base64.length}`,
    base64,
  };
}

// n8n "Parse extraction": normalise the document type.
export function normaliseExtraction(extraction: Extraction | null): { extraction: Extraction | null; documentType: string } {
  if (extraction && typeof extraction === "object") {
    const dt = String(extraction.document_type || "").toLowerCase().replace(/[^a-z]/g, "");
    if (extraction.is_invoice === true) extraction.document_type = dt === "creditnote" || dt === "credit" || dt === "creditmemo" ? "credit_note" : "invoice";
  }
  const documentType = extraction && extraction.is_invoice === true ? extraction.document_type : (extraction && extraction.document_type) || "unknown";
  return { extraction, documentType };
}

// ---- the check (n8n "Check invoice") -------------------------------------

export type ReadDocument = { source: IntakeDocument; extraction: Extraction | null; extractionError: string | null; docHash: string; base64: string; bodyText?: string };
export type IntakeHistoryRow = { processedAt: Date; senderEmail: string | null; bounceKey: string | null; action: string | null };
export type Issue = { code: string; message: string; lines?: { text: string; amount: number | null; reference?: string }[] };
export type DocIssues = { filename: string; invoice_number: string; supplier: string; currency: string; issues: Issue[] };

export type CheckResult = {
  verdict: "pass" | "bounce" | "review" | "not_invoice";
  action: "bounce_sent" | "draft_created" | "shadow_proposed" | "none";
  source: Source;
  senderEmail: string;
  senderName: string;
  supplierName: string;
  invoiceNumber: string;
  invoiceDate: string;
  totalGross: number | null;
  billTo: string;
  billToCompany: string;
  issues: DocIssues[];
  reviewReasons: Issue[];
  issueCodes: string;
  bounceKey: string;
  linkOnly: boolean;
  categories: { categories: string[]; isRead?: boolean };
  bounce: { to: string; subject: string; html: string } | null;
  currency: string;
};

const esc = (v: unknown) => String(v === null || v === undefined ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));
const r2 = (v: number) => Math.round(v * 100) / 100;
const money = (n: number, c: string) => (c && c !== "GBP" ? `${c} ` : "£") + Number(n).toFixed(2);
const normName = (s: unknown) => String(s || "").toLowerCase().replace(/hinckley/g, "hinkley").replace(/\blimited\b/g, "ltd").replace(/[^a-z0-9]+/g, " ").trim();

const STREET = new Set(["road", "rd", "street", "st", "avenue", "ave", "lane", "ln", "drive", "dr", "close", "place", "court", "ct", "flat", "house", "property", "unit", "es", "e", "s"]);
const refStatus = (ref: unknown) => {
  const t = String(ref || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  if (!t.length) return "missing";
  const words = t.filter((x) => /[a-z]/.test(x) && !/^\d+[a-z]?$/.test(x) && !STREET.has(x));
  return words.length ? "ok" : "incomplete";
};

const LINK_PLATFORMS = "invoicesimple,getinvoicesimple,xero,quickbooks,intuit,sumup,zoho,freeagent,sage,stripe,squareup,paypal,invoice2go,waveapps,freshbooks,tide,kashflow,clearbooks,pandle,crunch,invoiceninja,zervant,bill.com".split(",");
const OWN_NAMES = ["hinkley homes"];
const NOT_A_BILL = /remittance|receipt|payment (received|confirmation|confirmed)|has been paid|statement|quot(e|ation)|estimate|credit note/i;

function linkInvoice(source: Source, docs: ReadDocument[]): { invoice_number: string; total: string | number; platform: string } | null {
  const subject = String(source.subject || "");
  let body = "";
  for (const d of docs) if (d.source.source_type === "email_body" && d.base64) body += `\n${Buffer.from(d.base64, "base64").toString("utf8")}`;
  if (NOT_A_BILL.test(subject)) return null;
  const issuerM = subject.match(/\bfrom\s+(.+?)(?:\s+is\s+(?:due|overdue)|\s+for\s|\s*$)/i);
  const issuer = (issuerM ? issuerM[1] : "").toLowerCase();
  const senderName = String(source.from || "").replace(/<[^>]*>/, "").trim().toLowerCase();
  if (OWN_NAMES.some((o) => issuer.includes(o) || senderName.includes(o))) return null;
  const invoiceWord = /\binvoice\b|\binv[-\s#]?\d/i;
  if (!invoiceWord.test(subject) && !invoiceWord.test(body)) return null;
  const linkPhrase = /(view|download|open|see|access|pay)\s+(your\s+|the\s+|this\s+)?(pdf\s+)?invoice|click (below|here|the (button|link))[^\n]{0,60}invoice|invoice[^\n]{0,40}\b(link|online|portal)\b/i;
  const dom = String(source.from_email || "").toLowerCase().split("@")[1] || "";
  const platform = LINK_PLATFORMS.find((pl) => dom.includes(pl) || body.toLowerCase().includes(`${pl}.`));
  if (!linkPhrase.test(body) && !linkPhrase.test(subject) && !platform) return null;
  const x = docs.find((d) => d.extraction)?.extraction ?? {};
  const numM = `${subject}\n${body}`.match(/\binv(?:oice)?\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-/]{2,})/i);
  const totM = body.match(/total[^£$€\d\n]{0,20}([£$€]\s?[\d,]+(?:\.\d{2})?)/i) || body.match(/([£$€]\s?[\d,]+\.\d{2})/);
  return { invoice_number: x.invoice_number || (numM ? numM[1] : ""), total: x.total_gross != null ? x.total_gross : totM ? totM[1].replace(/\s/g, "") : "", platform: platform || "" };
}

// Who an "addressed to" name means: one of the five companies, or a name kept in
// Property aliases > Company names. Longest (most specific) match wins. Same
// rule as the n8n "Check invoice" step.
export function intakeCompanyMatcher(aliases: { alias: string; organisation: string }[] | null) {
  const nameEntries: { pat: string; org: string }[] = [];
  for (const c of INTAKE_CONFIG.companyNames) { const n = normName(c); if (n) nameEntries.push({ pat: n, org: c }); }
  for (const { alias, organisation } of aliases ?? []) {
    const n = normName(alias); if (!n || !organisation) continue;
    nameEntries.push({ pat: n, org: organisation });
    const short = n.replace(/ ltd$/, "");
    if (short !== n && short.split(" ").length >= 2) nameEntries.push({ pat: short, org: organisation });
  }
  nameEntries.sort((a, b) => b.pat.length - a.pat.length);
  const match = (raw: unknown) => { const bt = ` ${normName(raw)} `; const e = nameEntries.find((x) => bt.includes(` ${x.pat} `)); return e ? e.org : ""; };
  return { match, patterns: nameEntries.map((e) => e.pat) };
}

export function checkEmail(input: {
  source: Source;
  categories: string[];
  docs: ReadDocument[];
  mode: Mode;
  aliases: { alias: string; organisation: string }[] | null;
  history: IntakeHistoryRow[];
  now?: number;
}): CheckResult {
  const cfg = INTAKE_CONFIG;
  const { source: s, docs, mode } = input;
  const now = input.now ?? Date.now();
  const companies: string[] = [...cfg.companyNames];
  const aliasFileOk = input.aliases !== null;
  const { match: matchCompany, patterns: companyNorm } = intakeCompanyMatcher(input.aliases);
  const blocked = cfg.blockedSenderPatterns.toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
  const companyCostWords = cfg.companyCostWords.toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
  const isCompanyCost = (l: Extraction) => {
    if (String(l?.suggested_category || "") === "Software and subscriptions") return true;
    const t = ` ${String(l?.description || "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
    return companyCostWords.some((wd) => t.includes(` ${wd.replace(/[^a-z0-9]+/g, " ").trim()} `));
  };
  const sentActions = ["bounce_sent", "draft_created", "shadow_proposed"];

  const invoices = docs.filter((d) => d.extraction && d.extraction.is_invoice === true);
  const senderEmail = String(s.from_email || "").toLowerCase();
  const senderName = String(s.from || "").replace(/<[^>]*>/, "").trim();
  let verdict: CheckResult["verdict"];
  let issues: DocIssues[] = [];
  const reviewReasons: Issue[] = [];
  let sup = "", invNo = "", invDate = "", billTo = "", billToCompany = "";
  let total: number | null = null;
  let bounceKey = "";
  let linkOnly = false;
  let currency = "GBP";

  if (!invoices.length) {
    const li = linkInvoice(s, docs);
    if (li) {
      verdict = "review"; linkOnly = true;
      invNo = String(li.invoice_number || ""); sup = senderName;
      reviewReasons.push({ code: "invoice_link_only", message: `The invoice${invNo ? ` ${invNo}` : ""}${li.total !== "" ? ` (total ${li.total})` : ""} is a download link in the email, not an attachment${li.platform ? ` (sent via ${li.platform})` : ""}. Open the link in the email and download the PDF.` });
    } else {
      verdict = "not_invoice";
    }
  } else {
    const docIssues: DocIssues[] = [];
    for (const p of invoices) {
      const x = p.extraction!;
      const supplier = x.supplier || {};
      const cur = String(x.currency || "GBP").toUpperCase();
      const name = supplier.name || "";
      const di: Issue[] = [];
      if (!sup) { sup = name; invNo = x.invoice_number || ""; invDate = x.invoice_date || ""; total = num((x.totals || {}).gross); billTo = (x.addressed_to || {}).name || ""; billToCompany = matchCompany(billTo); currency = cur; }
      if (p.extractionError) reviewReasons.push({ code: "extraction_failed", message: "The invoice could not be read by the AI." });
      if (num(x.legibility_confidence) !== null && num(x.legibility_confidence)! < cfg.legibilityMin) reviewReasons.push({ code: "low_legibility", message: `Hard to read (confidence ${x.legibility_confidence}).` });
      if (!name) di.push({ code: "no_supplier", message: "The supplier name is not shown on the invoice." });
      if (!x.invoice_number) di.push({ code: "no_invoice_number", message: "There is no invoice number." });
      if (!x.invoice_date) di.push({ code: "no_invoice_date", message: "There is no invoice date." });
      const totalGross = num((x.totals || {}).gross);
      if (totalGross === null) di.push({ code: "no_total", message: "The invoice total is not shown." });
      const lines: Extraction[] = Array.isArray(x.lines) ? x.lines : [];
      if (!lines.length) di.push({ code: "no_lines", message: "The invoice has no itemised lines." });
      if (!companyNorm.length) reviewReasons.push({ code: "no_company_list", message: "No company names configured, so the bill-to was not checked." });
      else {
        const bt = normName((x.addressed_to || {}).name);
        if (!bt) di.push({ code: "bill_to_missing", message: "The invoice is not addressed to a company." });
        else if (!matchCompany(bt) && !aliasFileOk) reviewReasons.push({ code: "alias_file_unreadable", message: `Addressed to "${(x.addressed_to || {}).name}", which is not on the company list, and the company aliases could not be read, so it was not bounced.` });
        else if (!matchCompany(bt)) di.push({ code: "bill_to_wrong", message: `The invoice is addressed to "${(x.addressed_to || {}).name}", which is not one of our companies.` });
      }
      if (x.document_type !== "credit_note" && lines.length) {
        const amounts = lines.map((l) => {
          const gross = num(l.gross); if (gross !== null) return gross;
          const n = num(l.net), v = num(l.vat); return n !== null ? r2(n + (v || 0)) : null;
        });
        if (lines.length === 1 && amounts[0] === null && totalGross !== null) amounts[0] = totalGross;
        const noAmt = lines.filter((_l, i) => amounts[i] === null);
        if (noAmt.length) di.push({ code: "no_line_amounts", message: `The cost is not shown for each line (${noAmt.length} of ${lines.length} lines have no amount).`, lines: noAmt.map((l) => ({ text: l.description || "(no description)", amount: null })) });
        const missing: NonNullable<Issue["lines"]> = [], incomplete: NonNullable<Issue["lines"]> = [];
        lines.forEach((l, i) => {
          if (isCompanyCost(l)) return;
          const st = refStatus(l.property_reference_as_written);
          const item = { text: l.description || "(no description)", amount: amounts[i], reference: l.property_reference_as_written || "" };
          if (st === "missing") missing.push(item); else if (st === "incomplete") incomplete.push(item);
        });
        if (missing.length) di.push({ code: "property_missing", message: "These lines do not say which property they are for.", lines: missing });
        if (incomplete.length) di.push({ code: "property_incomplete", message: "These lines give only part of a property address (for example a number with no street or name).", lines: incomplete });
        const sum = r2(amounts.reduce<number>((a, b) => a + (b || 0), 0));
        if (totalGross !== null && !amounts.some((a) => a === null) && Math.abs(sum - totalGross) > 0.02) reviewReasons.push({ code: "totals_mismatch", message: `Lines add up to ${money(sum, cur)} but the total is ${money(totalGross, cur)}.` });
      }
      if (di.length) docIssues.push({ filename: p.source.filename || "", invoice_number: x.invoice_number || "", supplier: name, currency: cur, issues: di });
    }
    issues = docIssues;
    const flat = docIssues.flatMap((d) => d.issues);
    if (!flat.length && !reviewReasons.length) verdict = "pass";
    else if (!flat.length) verdict = "review";
    else if (reviewReasons.length) verdict = "review";
    else verdict = "bounce";
    bounceKey = `${senderEmail}|${String(invNo || invoices[0].source.filename || "").toLowerCase().replace(/[^a-z0-9]/g, "")}`;
    if (verdict === "bounce") {
      const dom = senderEmail.split("@")[1] || "";
      if (!senderEmail) { verdict = "review"; reviewReasons.push({ code: "no_sender", message: "No sender address to reply to." }); }
      else if (dom === cfg.internalDomain) { verdict = "review"; reviewReasons.push({ code: "internal_sender", message: "Sent from inside the company, so it was not bounced." }); }
      else if (blocked.some((b) => senderEmail.includes(b))) { verdict = "review"; reviewReasons.push({ code: "automated_sender", message: "Sent from an automated address that cannot be replied to." }); }
      else {
        const sentBefore = input.history.filter((h) => h.bounceKey === bounceKey && sentActions.includes(h.action ?? "")).length;
        const sentToday = input.history.filter((h) => String(h.senderEmail || "").toLowerCase() === senderEmail && sentActions.includes(h.action ?? "") && now - h.processedAt.getTime() < 86400000).length;
        if (sentBefore >= cfg.maxBouncesPerInvoice) { verdict = "review"; reviewReasons.push({ code: "already_asked", message: `This sender has already been asked ${sentBefore} time(s) about this invoice.` }); }
        else if (sentToday >= cfg.maxBouncesPerSenderPerDay) { verdict = "review"; reviewReasons.push({ code: "daily_limit", message: "Daily bounce limit reached for this sender." }); }
      }
    }
  }

  let bounce: CheckResult["bounce"] = null;
  if (verdict === "bounce") {
    const F = "font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#101828;";
    const TH = "text-align:left;background:#f2f4f7;padding:6px 10px;border:1px solid #d0d5dd;";
    const TD = "padding:6px 10px;border:1px solid #d0d5dd;vertical-align:top;";
    let h = `<div style="${F}"><p>Hello,</p>`;
    h += `<p>Thank you for your invoice${invNo ? ` <b>${esc(invNo)}</b>` : ""}. We have not been able to process it because the details below are missing or unclear. Please send a corrected invoice by replying to this email.</p>`;
    for (const d of issues) {
      if (issues.length > 1) h += `<p><b>${esc(d.filename || d.invoice_number || "Invoice")}</b></p>`;
      h += "<ul>";
      for (const i of d.issues) {
        h += `<li>${esc(i.message)}`;
        if (i.lines && i.lines.length) {
          h += `<table style="border-collapse:collapse;margin:6px 0;${F}font-size:13px;"><tr><th style="${TH}">Line on your invoice</th><th style="${TH}text-align:right;">Amount</th></tr>` +
            i.lines.slice(0, 40).map((l) => `<tr><td style="${TD}">${esc(l.text)}</td><td style="${TD}text-align:right;">${l.amount === null || l.amount === undefined ? "-" : esc(money(l.amount, d.currency))}</td></tr>`).join("") + "</table>";
        }
        h += "</li>";
      }
      h += "</ul>";
    }
    h += "<p><b>What we need on the corrected invoice</b></p><ul>" +
      `<li>It is addressed to the company the work was done for. Our companies are: ${esc(companies.join(", "))}.</li>` +
      "<li>Every line for work at a property shows the <b>property</b> (full address or property name) and its own <b>amount</b>, so each cost can be recorded against the correct property.</li>" +
      "<li>Invoice number, invoice date and total are shown.</li></ul>";
    h += "<p>If you believe this message is wrong, just reply and tell us. This request was produced by our automated invoice check, and a member of the accounts team reads the replies.</p>";
    h += `<p>Kind regards,<br>${esc(cfg.senderName)}</p></div>`;
    bounce = { to: senderEmail, subject: `Action needed: please reissue invoice ${invNo || ""}${sup ? ` from ${sup}` : ""}`, html: h };
  }

  const cat = cfg.categories;
  const catMap: Record<string, string> = { pass: cat.pass, not_invoice: cat.notInvoice, review: cat.review, bounce: mode === "live" ? cat.bounced : mode === "draft" ? cat.drafted : cat.shadow };
  const newCat = catMap[verdict] || "";
  const cats = (input.categories || []).filter((c) => !String(c).startsWith("n8n:")).concat(newCat ? [newCat] : []);
  const action: CheckResult["action"] = verdict === "bounce" ? (mode === "live" ? "bounce_sent" : mode === "draft" ? "draft_created" : "shadow_proposed") : "none";
  const allIssues = issues.flatMap((d) => d.issues).concat(reviewReasons);
  return {
    verdict, action, source: s, senderEmail, senderName, supplierName: sup, invoiceNumber: invNo, invoiceDate: invDate, totalGross: total, billTo, billToCompany,
    issues, reviewReasons, issueCodes: allIssues.map((i) => i.code).join(", "), bounceKey, linkOnly, currency,
    categories: verdict === "bounce" || linkOnly ? { categories: cats, isRead: false } : verdict === "not_invoice" ? { categories: cats, isRead: true } : { categories: cats },
    bounce,
  };
}

// The [SHADOW] preview sent to the reviewer instead of the supplier.
export function shadowMail(result: CheckResult): Record<string, unknown> | null {
  if (!result.bounce) return null;
  const codes = result.issues.flatMap((d) => d.issues).concat(result.reviewReasons).map((i) => i.code).join(", ");
  return {
    message: {
      ...(INTAKE_CONFIG.noreplyAddress ? { from: { emailAddress: { address: INTAKE_CONFIG.noreplyAddress } } } : {}),
      subject: `[SHADOW] Would ask ${result.senderEmail} to reissue: ${result.supplierName || "invoice"} ${result.invoiceNumber}`,
      body: { contentType: "HTML", content: `<p style="font-family:Arial,sans-serif;font-size:13px;color:#b54708"><b>Shadow mode: nothing was sent to the supplier.</b> Issues found: ${esc(codes)}. This is the message that would be sent to ${esc(result.senderEmail)}:</p><hr>${result.bounce.html}` },
      toRecipients: [{ emailAddress: { address: INTAKE_CONFIG.reviewerEmail } }],
    },
    saveToSentItems: false,
  };
}

export function replyBody(result: CheckResult): Record<string, unknown> | null {
  if (!result.bounce) return null;
  const ccs = INTAKE_CONFIG.bounceCc.split(",").map((a) => a.trim()).filter(Boolean).map((address) => ({ emailAddress: { address } }));
  return { message: { body: { contentType: "HTML", content: result.bounce.html }, ...(ccs.length ? { ccRecipients: ccs } : {}) } };
}

// ---- files and links -------------------------------------------------------

const FILE_EXT: Record<string, string> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", [DOCX]: "docx", [ODT]: "odt" };
const clean = (v: unknown) => String(v || "").replace(/[\\/:*?"<>|#%&{}~\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);

// SharePoint path (folder/year-month/"date supplier number.ext") for each invoice document kept.
export function invoiceFiles(docs: ReadDocument[], processedAt: Date): { path: string; name: string; mime: string; data: Buffer }[] {
  const month = processedAt.toISOString().slice(0, 7);
  const seen = new Set<string>();
  const out: { path: string; name: string; mime: string; data: Buffer }[] = [];
  for (const d of docs) {
    const file = d.source.original ?? d.source.data;
    const x = d.extraction;
    if (!file || (x && x.is_invoice !== true) || seen.has(d.docHash)) continue;
    seen.add(d.docHash);
    const mime = d.source.mime_type || "application/octet-stream";
    const orig = d.source.filename || "";
    const ext = (orig.match(/\.([a-z0-9]{2,5})$/i) || [])[1] || FILE_EXT[mime] || "bin";
    const label = [x?.invoice_date, x?.supplier?.name, x?.invoice_number].map(clean).filter(Boolean).join(" ");
    const name = `${label || clean(orig.replace(/\.[a-z0-9]{2,5}$/i, "")) || "invoice"}.${ext.toLowerCase()}`;
    const path = INTAKE_CONFIG.invoiceFilesFolder.split("/").filter(Boolean).concat([month, name]).map(encodeURIComponent).join("/");
    out.push({ path, name, mime, data: file });
  }
  return out;
}

const PLATFORMS = /(^|\.)(xero\.com|intuit\.com|quickbooks\.com|invoicesimple\.com|getinvoicesimple\.com|squareup\.com|square\.link|sumup\.com|zoho\.com|zoho\.eu|freeagent\.com|stripe\.com|paypal\.com|invoice2go\.com|waveapps\.com|freshbooks\.com|invoicehome\.com|kashflow\.com|clearbooks\.co\.uk|sage\.com|pandle\.com|invoiceninja\.com|zervant\.com|bill\.com)$/i;
const SKIP = /unsubscribe|preferences|privacy|terms|cookie|facebook|twitter|linkedin|instagram|youtube|apps\.apple|play\.google|mailto:/i;

// The invoice link in the email (Xero, QuickBooks, Invoice Simple...), if any.
export function invoiceLink(html: string): string | null {
  let top: { url: string; score: number } | null = null;
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const url = m[1].trim().replace(/&amp;/g, "&");
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    let u: URL;
    try { u = new URL(url); } catch { continue; }
    if (u.protocol !== "https:" || SKIP.test(url) || SKIP.test(text)) continue;
    let score = 0;
    if (PLATFORMS.test(u.hostname)) score += 2;
    if (/\b(view|download|open|see|pay|access)\b.{0,25}\b(invoice|bill)\b|\binvoice\b/i.test(text)) score += 2;
    if (/invoice/i.test(u.pathname + u.search)) score += 1;
    if (score >= 2 && (!top || score > top.score)) top = { url, score };
  }
  if (!top) {
    for (const url of html.replace(/<[^>]+>/g, " ").match(/https:\/\/[^\s"'<>)]+/g) || []) {
      let u: URL;
      try { u = new URL(url); } catch { continue; }
      if (!SKIP.test(url) && PLATFORMS.test(u.hostname) && /inv|bill|pay/i.test(u.pathname + u.search)) return url.length <= 2000 ? url : null;
    }
  }
  return top && top.url.length <= 2000 ? top.url : null;
}

export const validDate = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v ? v : null);
export const amount = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.replace(/[£$€,\s]/g, "")) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};
