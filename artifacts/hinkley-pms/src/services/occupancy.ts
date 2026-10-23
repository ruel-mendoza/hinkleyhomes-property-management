import type { OccupancyRow, OccupancyStatus } from "@workspace/api-client-react";
import { formatDate } from "@/services/properties";

// Occupancy page helpers. Rows come from GET /api/occupancy (COHO tenancies,
// rent review and units joined on the server).

export type StatusFilter = OccupancyStatus | "occupied" | "all";

export const STATUS_TILES: { key: StatusFilter; label: string; tone: string }[] = [
  { key: "occupied", label: "All tenancies", tone: "neutral" },
  { key: "fixed_term", label: "Fixed term", tone: "neutral" },
  { key: "becoming_periodic", label: "Becoming periodic", tone: "neutral" },
  { key: "periodic", label: "Periodic", tone: "good" },
  { key: "ending", label: "Ending", tone: "bad" },
  { key: "future", label: "Moving in", tone: "info" },
  { key: "vacant", label: "Vacant", tone: "warn" },
];

export const matchesStatus = (row: OccupancyRow, filter: StatusFilter) =>
  filter === "all" || (filter === "occupied" ? row.status !== "vacant" && row.status !== "future" : row.status === filter);

export function statusText(row: OccupancyRow): string {
  switch (row.status) {
    case "fixed_term": return "Fixed term";
    case "becoming_periodic": return `Becomes periodic ${formatDate(row.fixedTermEnd)}`;
    case "periodic": return row.fixedTermEnd ? "Became periodic" : "Started periodic";
    case "ending": return `Ending ${formatDate(row.endDate)}`;
    case "future": return `Moves in ${formatDate(row.startDate)}`;
    case "vacant": return "Vacant";
  }
}

export const STATUS_TONE: Record<OccupancyStatus, string> = {
  fixed_term: "occupied",
  becoming_periodic: "pending",
  periodic: "completed",
  ending: "overdue",
  future: "upcoming",
  vacant: "na",
};

const FREQUENCY: Record<string, string> = {
  monthly: "pm", weekly: "pw", fortnightly: "per fortnight", "four weekly": "per 4 weeks", quarterly: "per quarter", annually: "pa", term: "per term",
};
const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 2 });
export const rentText = (row: OccupancyRow) =>
  row.rent === null ? "—" : `${money.format(row.rent)}${row.paymentFrequency ? ` ${FREQUENCY[row.paymentFrequency] ?? row.paymentFrequency}` : ""}`;

// For whole-property lets COHO's single unit is called "Tenancy" or "Property";
// the property name says more.
export const unitLabel = (row: OccupancyRow) => (row.unitsInProperty > 1 ? row.unitName : row.propertyName);

const byName = (a: string, b: string) => a.localeCompare(b, "en-GB", { numeric: true, sensitivity: "base" });

export function groupByProperty(rows: OccupancyRow[]): { reference: string; name: string; rows: OccupancyRow[] }[] {
  const groups = new Map<string, { reference: string; name: string; rows: OccupancyRow[] }>();
  for (const row of rows) {
    const group = groups.get(row.propertyReference) ?? { reference: row.propertyReference, name: row.propertyName, rows: [] };
    group.rows.push(row);
    groups.set(row.propertyReference, group);
  }
  return [...groups.values()]
    .sort((a, b) => byName(a.name, b.name))
    .map((group) => ({ ...group, rows: group.rows.sort((a, b) => byName(a.unitName, b.unitName) || String(b.startDate).localeCompare(String(a.startDate))) }));
}

const csvCell = (value: string | number | null) => {
  const text = value === null ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) || safe !== text ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function occupancyCsv(rows: OccupancyRow[]): string {
  const header = ["property", "unit", "tenancy", "tenants", "occupants", "rent", "frequency", "start", "fixedTermEnd", "endDate", "availableFrom", "nextRentReview", "status"];
  const lines = rows.map((row) =>
    [
      row.propertyName,
      row.unitName,
      row.tenancyNumber,
      row.tenants.map((tenant) => tenant.name).join("; "),
      row.tenants.length,
      row.rent,
      row.paymentFrequency,
      row.startDate,
      row.fixedTermEnd,
      row.endDate,
      row.availableFrom,
      row.nextRentReview,
      statusText(row),
    ].map(csvCell).join(","),
  );
  return [header.join(","), ...lines].join("\r\n");
}
