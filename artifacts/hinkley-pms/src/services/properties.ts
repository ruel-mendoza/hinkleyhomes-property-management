import type { PropertySummary } from "@workspace/api-client-react";

// Properties page data helpers. The data itself comes from the PMS API
// (GET /api/properties), which combines live COHO properties, open action
// counts from the Supabase actions copy, and register-only properties.

export type ViewMode = "grid" | "list";
export type PropertyFilters = {
  search: string;
  tags: string[];
  actionsOnly: boolean;
  inactive: boolean;
  showAll: boolean;
  view: ViewMode;
};
export const DEFAULT_FILTERS: PropertyFilters = { search: "", tags: [], actionsOnly: false, inactive: false, showAll: false, view: "grid" };

// Filters live in the URL so a filtered view can be bookmarked or shared.
export function filtersFromSearch(search: string): PropertyFilters {
  const params = new URLSearchParams(search);
  return {
    search: params.get("q") ?? "",
    tags: params.getAll("tag").filter(Boolean),
    actionsOnly: params.get("actions") === "1",
    inactive: params.get("inactive") === "1",
    showAll: params.get("all") === "1",
    view: params.get("view") === "list" ? "list" : "grid",
  };
}
export function filtersToSearch(filters: PropertyFilters): string {
  const params = new URLSearchParams();
  if (filters.search) params.set("q", filters.search);
  for (const tag of filters.tags) params.append("tag", tag);
  if (filters.actionsOnly) params.set("actions", "1");
  if (filters.inactive && !filters.showAll) params.set("inactive", "1");
  if (filters.showAll) params.set("all", "1");
  if (filters.view === "list") params.set("view", "list");
  return params.toString();
}
export const hasActiveFilters = (filters: PropertyFilters) =>
  Boolean(filters.search || filters.tags.length || filters.actionsOnly || filters.inactive || filters.showAll);

const leadingNumber = (value: string | null | undefined) => {
  const match = /\d+/.exec(value ?? "");
  return match ? Number(match[0]) : Number.POSITIVE_INFINITY;
};
// Alphabetical by street, then by house number (2 before 10).
export function compareByStreet(a: PropertySummary, b: PropertySummary): number {
  const street = (a.streetName ?? a.name).localeCompare(b.streetName ?? b.name, "en-GB", { sensitivity: "base" });
  if (street !== 0) return street;
  return leadingNumber(a.houseNumber ?? a.name) - leadingNumber(b.houseNumber ?? b.name) || a.name.localeCompare(b.name);
}

export function filterProperties(items: PropertySummary[], filters: PropertyFilters): PropertySummary[] {
  const term = filters.search.trim().toLowerCase();
  return items
    .filter((property) => {
      if (filters.showAll) return true;
      return filters.inactive ? property.deactivated : !property.deactivated;
    })
    .filter((property) => !filters.actionsOnly || property.openActionsCount > 0)
    .filter((property) => filters.tags.every((tag) => property.tags.includes(tag)))
    .filter((property) =>
      !term ||
      [property.name, property.streetName, property.postcode, property.postcode?.replace(/\s+/g, ""), property.town]
        .some((value) => value?.toLowerCase().includes(term)),
    )
    .sort(compareByStreet);
}

export const allTags = (items: PropertySummary[]) =>
  [...new Set(items.flatMap((property) => property.tags))].sort((a, b) => a.localeCompare(b));

// 0–1, or null when occupancy isn't known (register-only properties).
export const occupancy = (property: Pick<PropertySummary, "roomsOccupied" | "totalRooms">) =>
  property.roomsOccupied === null || property.totalRooms <= 0 ? null : property.roomsOccupied / property.totalRooms;

export const statusLabel = (property: PropertySummary) =>
  property.deactivated ? "Inactive" : property.source === "register" ? "Not in COHO yet" : "Active";

export const locationLine = (property: PropertySummary) => [property.town, property.postcode].filter(Boolean).join(", ");

// --- Export and report -------------------------------------------------------

const csvCell = (value: string | number | null) => {
  const text = value === null ? "" : String(value);
  // Quote everything that could break a row, and neutralise spreadsheet formulas.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) || safe !== text ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function propertiesCsv(items: PropertySummary[]): string {
  const header = ["reference", "name", "town", "postcode", "totalRooms", "roomsOccupied", "occupancy %", "openActions", "tags", "status"];
  const rows = items.map((property) => {
    const share = occupancy(property);
    return [
      property.cohoReference ?? property.id,
      property.name,
      property.town,
      property.postcode,
      property.totalRooms,
      property.roomsOccupied,
      share === null ? null : Math.round(share * 100),
      property.openActionsCount,
      property.tags.join("; "),
      statusLabel(property),
    ].map(csvCell).join(",");
  });
  return [header.join(","), ...rows].join("\r\n");
}

export function downloadText(filename: string, text: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob(["﻿", text], { type }));
  const link = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function buildReport(items: PropertySummary[]) {
  const known = items.filter((property) => property.roomsOccupied !== null);
  const totalRooms = items.reduce((sum, property) => sum + property.totalRooms, 0);
  const knownRooms = known.reduce((sum, property) => sum + property.totalRooms, 0);
  const occupiedRooms = known.reduce((sum, property) => sum + (property.roomsOccupied ?? 0), 0);
  return {
    totalProperties: items.length,
    totalRooms,
    occupiedRooms,
    // Only properties whose occupancy COHO reports count towards the percentage.
    occupancyPercent: knownRooms ? Math.round((occupiedRooms / knownRooms) * 100) : null,
    unknownOccupancy: items.length - known.length,
    withOpenActions: items.filter((property) => property.openActionsCount > 0).length,
    openActions: items.reduce((sum, property) => sum + property.openActionsCount, 0),
    lowestOccupancy: [...known]
      .sort((a, b) => (occupancy(a) ?? 0) - (occupancy(b) ?? 0) || compareByStreet(a, b))
      .slice(0, 8),
  };
}

// --- Validation ----------------------------------------------------------------

export function normaliseUkPostcode(value: string): string | null {
  const compact = value.toUpperCase().replace(/\s+/g, "");
  if (compact === "GIR0AA") return "GIR 0AA";
  const match = /^([A-Z]{1,2}\d[A-Z\d]?)(\d[ABD-HJLNP-UW-Z]{2})$/.exec(compact);
  return match ? `${match[1]} ${match[2]}` : null;
}

// --- COHO API v1.1 (server side only) --------------------------------------------
// The browser never calls COHO directly: the COHO API key is a server secret
// (COHO_API_KEY in Replit Secrets) and must not be shipped to the page. These
// COHO routes are already called by the PMS API server:
//   GET /v1.1/public/properties?page=&pageSize=&tag=&sortColumn=&sortOrder= → PropertiesPagedList
//       artifacts/api-server/src/routes/properties.ts (fetchCohoProperties)
//   GET /v1.1/public/properties/{propertyReference}/actions/overview → open actions
//       replaced by counting the Supabase copy of every COHO action (coho_actions),
//       which avoids one COHO call per property.
//   GET /v1.1/public/tags → tag picker
//       returns no tags for this COHO account today, so tags are read from the
//       properties themselves.
