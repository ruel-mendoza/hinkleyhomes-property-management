import { CohoApiError, cohoGet } from "./coho-api";

// Property compliance from the COHO Public API v1.1.
//
// GET /compliancy/overview?groupByProperty=true counts compliance items per
// property in one call; daysToExpiry picks which bucket is counted:
//   -3 every tracked item, -2 not enabled for the property (e.g. no HMO
//   licence needed), -1 not started (no record), 0 expired, N expiring in N days.
// The score is the share of enabled items that are in date. It is our own
// measure: COHO's property setup percentage is not exposed by the API.

type RecordValue = Record<string, unknown>;
const asRecord = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
const list = (value: unknown): RecordValue[] => (Array.isArray(value) ? value.map(asRecord) : []);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

const EXPIRING_DAYS = 30;
const BUCKETS = { all: -3, notEnabled: -2, missing: -1, expired: 0, expiring: EXPIRING_DAYS } as const;
type Bucket = keyof typeof BUCKETS;

export type ComplianceIssue = { name: string; state: "missing" | "expired" | "expiring_soon" };
export type PropertyCompliance = {
  score: number;
  required: number;
  inDate: number;
  missing: number;
  expired: number;
  expiringSoon: number;
  issues: ComplianceIssue[];
};

// Leaf item counts for one property: reference -> { name, total, category }.
// The category is the top-level type (e.g. "Fire Safety" for "Fire Alarm Test").
export type ComplianceLeaf = { name: string; total: number; categoryKey: string; categoryName: string };
type Leaves = Map<string, ComplianceLeaf>;
const leavesOf = (summaries: unknown): Leaves => {
  const leaves: Leaves = new Map();
  for (const top of list(summaries)) {
    const categoryKey = str(top.reference) ?? str(top.name) ?? "";
    const categoryName = str(top.name) ?? "Compliance";
    const children = list(top.childCompliancyTypeSummaries);
    for (const item of children.length ? children : [top]) {
      leaves.set(str(item.reference) ?? str(item.name) ?? "", { name: str(item.name) ?? "Compliance item", total: num(item.total) ?? 0, categoryKey, categoryName });
    }
  }
  return leaves;
};

// Per-property leaf counts for any daysToExpiry bucket (see the header comment),
// plus the property names COHO reports with them.
export async function fetchComplianceOverview(daysToExpiry: number, propertyReference?: string) {
  const query = new URLSearchParams({ groupByProperty: "true", daysToExpiry: String(daysToExpiry) });
  if (propertyReference) query.set("propertyReferences", propertyReference);
  const payload = asRecord(await cohoGet(`/compliancy/overview?${query}`));
  const properties = list(payload.propertySummaries);
  return {
    leaves: new Map(properties.map((property) => [str(property.propertyReference) ?? "", leavesOf(property.compliancyTypeSummaries)])),
    names: new Map(properties.map((property) => [str(property.propertyReference) ?? "", str(property.propertyName) ?? ""])),
  };
}
const fetchBucket = async (bucket: Bucket, propertyReference?: string) => (await fetchComplianceOverview(BUCKETS[bucket], propertyReference)).leaves;

export type ComplianceBuckets = Record<Bucket, Map<string, Leaves>>;

export async function fetchComplianceBuckets(propertyReference?: string): Promise<ComplianceBuckets> {
  const keys = Object.keys(BUCKETS) as Bucket[];
  const results = await Promise.all(keys.map((key) => fetchBucket(key, propertyReference)));
  return Object.fromEntries(keys.map((key, index) => [key, results[index]])) as ComplianceBuckets;
}

// Item references COHO tracks for the property, minus those not enabled for it.
export function requiredItems(buckets: ComplianceBuckets, reference: string): Set<string> {
  const notEnabled = buckets.notEnabled.get(reference);
  return new Set(
    [...(buckets.all.get(reference) ?? new Map()).entries()]
      .filter(([key, leaf]) => leaf.total - (notEnabled?.get(key)?.total ?? 0) > 0)
      .map(([key]) => key),
  );
}

export function complianceFor(buckets: ComplianceBuckets, reference: string): PropertyCompliance | null {
  const all = buckets.all.get(reference);
  if (!all) return null;
  const count = (bucket: Bucket, key: string) => buckets[bucket].get(reference)?.get(key)?.total ?? 0;
  const result: PropertyCompliance = { score: 100, required: 0, inDate: 0, missing: 0, expired: 0, expiringSoon: 0, issues: [] };
  for (const [key, leaf] of all) {
    const required = Math.max(leaf.total - count("notEnabled", key), 0);
    if (!required) continue;
    const missing = Math.min(count("missing", key), required);
    const expired = Math.min(count("expired", key), required - missing);
    const expiring = Math.min(count("expiring", key), required - missing - expired);
    result.required += required;
    result.missing += missing;
    result.expired += expired;
    result.expiringSoon += expiring;
    result.inDate += required - missing - expired;
    if (expired) result.issues.push({ name: leaf.name, state: "expired" });
    if (missing) result.issues.push({ name: leaf.name, state: "missing" });
    if (expiring) result.issues.push({ name: leaf.name, state: "expiring_soon" });
  }
  if (result.required) result.score = Math.round((result.inDate / result.required) * 100);
  const order = { expired: 0, missing: 1, expiring_soon: 2 } as const;
  result.issues.sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));
  return result;
}

// --- One property's records ------------------------------------------------------

export type ComplianceRecordStatus = "valid" | "expiring_soon" | "expired" | "missing" | "not_required";
export type ComplianceRecord = {
  key: string;
  name: string;
  group: "certificates" | "fire_safety" | "health_and_safety" | "inspections";
  required: boolean;
  status: ComplianceRecordStatus;
  validFrom: string | null;
  validTo: string | null;
  detail: string | null;
};

// COHO stores UK dates as UK midnight in UTC (3 Aug BST = 2026-08-02T23:00Z),
// so dates are read in UK time; the UTC date would be a day early in summer.
const ukDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" });
export const ukToday = () => ukDate.format(new Date());
const isoDate = (value: unknown): string | null => {
  const text = str(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : ukDate.format(date);
};
const addDays = (date: string, days: number) => new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
const addMonths = (date: string, months: number) => {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next.toISOString().slice(0, 10);
};

function statusOf(hasRecord: boolean, required: boolean, validTo: string | null, today: string): ComplianceRecordStatus {
  if (!hasRecord) return required ? "missing" : "not_required";
  if (!validTo) return "valid";
  if (validTo < today) return "expired";
  return validTo <= addDays(today, EXPIRING_DAYS) ? "expiring_soon" : "valid";
}

// COHO answers these property paths with 404 when there is no query string, and
// with 404 when the property has no record of that type. Both mean "no record".
async function cohoOptional(path: string): Promise<RecordValue | null> {
  try {
    return asRecord(await cohoGet(`${path}${path.includes("?") ? "&" : "?"}includeRooms=false`));
  } catch (error) {
    if (error instanceof CohoApiError && error.status === 404) return null;
    throw error;
  }
}

const CERTIFICATES = [
  { key: "gas-safety-certificate", name: "Gas Safety Certificate", path: "gas-safety-certificates/overview", field: "latestValidGasSafetyCertificate" },
  { key: "electrical-installation-condition-report", name: "EICR", path: "electrical-installation-condition-report/overview", field: "latestValidElectricalInstallationConditionReport" },
  { key: "energy-performance-certificate", name: "EPC", path: "energy-performance-certificate/overview", field: "latestValidEnergyPerformanceCertificate" },
  { key: "hmo-licence", name: "HMO Licence", path: "hmo-licences/overview", field: "latestValidHmoLicence" },
  { key: "portable-appliance-test", name: "PAT", path: "portable-appliance-tests/overview", field: "latestPortableApplianceTest" },
  { key: "boiler-service", name: "Boiler Service", path: "boiler-service/overview", field: "latestValidBoilerService" },
] as const;

export type PropertyRecords = {
  records: ComplianceRecord[];
  lastInspection: string | null;
  nextInspectionDue: string | null;
  unavailable: string[];
};

export async function fetchPropertyRecords(reference: string, required: Set<string>): Promise<PropertyRecords> {
  const base = `/properties/${encodeURIComponent(reference)}`;
  const today = ukToday();
  const unavailable: string[] = [];
  const load = (path: string, label: string) =>
    cohoOptional(`${base}/${path}`).catch(() => {
      unavailable.push(label);
      return null;
    });

  const [certificates, fire, health, inspections] = await Promise.all([
    Promise.all(CERTIFICATES.map((certificate) => load(certificate.path, certificate.name))),
    load("fire-safety/overview", "Fire safety"),
    load("health-and-safety/overview", "Health & safety"),
    load("inspections/overview", "Inspections"),
  ]);

  const records: ComplianceRecord[] = [];
  CERTIFICATES.forEach((certificate, index) => {
    const payload = certificates[index];
    const record = payload ? asRecord(payload[certificate.field]) : {};
    const hasRecord = Object.keys(record).length > 0;
    const validFrom = isoDate(record.validFrom) ?? isoDate(record.dateCompleted);
    let validTo = isoDate(record.validTo);
    const patMonths = num(payload?.monthsValidFor);
    if (!validTo && validFrom && certificate.key === "portable-appliance-test" && patMonths) validTo = addMonths(validFrom, patMonths);
    if (!validTo && validFrom && certificate.key === "boiler-service") validTo = addMonths(validFrom, 12);
    let detail: string | null = null;
    if (certificate.key === "energy-performance-certificate" && str(record.rating)) {
      const current = num(record.currentScore);
      const potential = num(record.potentialScore);
      detail = `Rating ${str(record.rating)}${current !== null ? ` (${current}${potential !== null ? `, potential ${potential}` : ""})` : ""}`;
    }
    if (certificate.key === "hmo-licence" && str(record.hmoLicenceNumber)) detail = `Licence no. ${str(record.hmoLicenceNumber)}`;
    if (certificate.key === "portable-appliance-test" && num(record.devicesTested)) detail = `${num(record.devicesTested)} devices tested`;
    const isRequired = required.has(certificate.key);
    if (!hasRecord && !isRequired && certificate.key === "boiler-service") return;
    records.push({
      key: certificate.key,
      name: certificate.name,
      group: "certificates",
      required: isRequired,
      status: statusOf(hasRecord, isRequired, validTo, today),
      validFrom,
      validTo,
      detail,
    });
  });

  // Fire safety and health & safety list every record type COHO knows; only
  // the ones that are required or have a record are worth showing.
  const recordTypes = (payload: RecordValue | null, group: "fire_safety" | "health_and_safety", period: "weeksValid" | "monthsValid") => {
    for (const item of list(payload?.items)) {
      const type = asRecord(item.recordType);
      const key = str(type.reference) ?? "";
      const record = item.record ? asRecord(item.record) : null;
      const isRequired = item.required === true || required.has(key);
      if (!record && !isRequired) continue;
      const validFrom = isoDate(record?.validFrom) ?? isoDate(record?.dateCompleted);
      const length = num(item[period]) ?? num(type[period]);
      let validTo = isoDate(record?.validTo);
      if (!validTo && validFrom && length) validTo = period === "weeksValid" ? addDays(validFrom, length * 7) : addMonths(validFrom, length);
      records.push({
        key,
        name: str(type.name) ?? key,
        group,
        required: isRequired,
        status: statusOf(Boolean(record), isRequired, validTo, today),
        validFrom,
        validTo,
        detail: length ? `Every ${length} ${period === "weeksValid" ? (length === 1 ? "week" : "weeks") : length === 1 ? "month" : "months"}` : null,
      });
    }
  };
  recordTypes(fire, "fire_safety", "weeksValid");
  recordTypes(health, "health_and_safety", "monthsValid");

  const summary = asRecord(inspections?.summary);
  const completed = list(inspections?.inspections)
    .map((inspection) => isoDate(inspection.dateCompleted))
    .filter((date): date is string => Boolean(date))
    .sort();
  const lastInspection = completed.at(-1) ?? null;
  const nextInspectionDue = isoDate(summary.nextDueDate);
  if (inspections && (summary.itemRequired === true || lastInspection)) {
    const isRequired = summary.itemRequired === true;
    records.push({
      key: "inspection",
      name: "Property Inspection",
      group: "inspections",
      required: isRequired,
      status: !lastInspection ? (isRequired ? "missing" : "not_required") : summary.overdue === true ? "expired" : summary.itemDue === true ? "expiring_soon" : "valid",
      validFrom: lastInspection,
      validTo: nextInspectionDue,
      detail: null,
    });
  }

  return { records, lastInspection, nextInspectionDue, unavailable };
}
