import { Router, type IRouter } from "express";
import { GetComplianceQueryParams, GetComplianceResponse } from "@workspace/api-zod";
import { cohoApiKey } from "../lib/integrations-env";
import {
  fetchComplianceOverview,
  fetchPropertyRecords,
  ukToday,
  type ComplianceLeaf,
  type ComplianceRecord,
} from "../lib/coho-compliance";

// Compliance page, as on COHO's Compliance screen. Counts come from one
// /compliancy/overview call per bucket (every property at once); the Carried
// Out and Expiry dates come from each listed property's record overviews.

type Filter = "expired" | "due_30" | "due_60" | "due_90" | "not_started" | "not_required" | "all";
type ItemStatus = "expired" | "due_soon" | "not_started" | "not_required" | "in_date";

// COHO daysToExpiry values: -3 all, -2 not enabled, -1 not started, 0 expired, N expiring within N days.
const DAYS: Record<Filter, number> = { expired: 0, due_30: 30, due_60: 60, due_90: 90, not_started: -1, not_required: -2, all: -3 };
const FIXED_STATUS: Partial<Record<Filter, ItemStatus>> = { expired: "expired", due_30: "due_soon", due_60: "due_soon", due_90: "due_soon", not_started: "not_started", not_required: "not_required" };

const LIST_CACHE_MS = 10 * 60_000;
const RECORDS_CACHE_MS = 30 * 60_000;
const listCache = new Map<Filter, { at: number; body: unknown }>();
const recordsCache = new Map<string, { at: number; records: ComplianceRecord[] }>();

type Leaves = Map<string, ComplianceLeaf>;
const total = (map: Map<string, Leaves>, property: string, key: string) => map.get(property)?.get(key)?.total ?? 0;

async function recordsFor(propertyReference: string): Promise<ComplianceRecord[]> {
  const hit = recordsCache.get(propertyReference);
  if (hit && Date.now() - hit.at < RECORDS_CACHE_MS) return hit.records;
  // Every type counts as required here: the row list already decides what is shown.
  const { records, unavailable } = await fetchPropertyRecords(propertyReference, new Set());
  if (!unavailable.length) recordsCache.set(propertyReference, { at: Date.now(), records });
  return records;
}

async function inBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += size) results.push(...(await Promise.all(items.slice(index, index + size).map(run))));
  return results;
}

async function buildList(filter: Filter) {
  const needsStatusBuckets = filter === "all";
  const [selected, expired, expiring, missing, notEnabled] = await Promise.all([
    fetchComplianceOverview(DAYS[filter]),
    needsStatusBuckets ? fetchComplianceOverview(0) : null,
    needsStatusBuckets ? fetchComplianceOverview(30) : null,
    needsStatusBuckets ? fetchComplianceOverview(-1) : null,
    needsStatusBuckets ? fetchComplianceOverview(-2) : null,
  ]);

  const rows: {
    propertyReference: string; propertyName: string; categoryKey: string; categoryName: string;
    typeKey: string; typeName: string; status: ItemStatus; carriedOut: string | null; expiry: string | null;
  }[] = [];
  const categories = new Map<string, { key: string; name: string; count: number; types: Map<string, { key: string; name: string; count: number }> }>();

  for (const [propertyReference, leaves] of selected.leaves) {
    for (const [typeKey, leaf] of leaves) {
      const category = categories.get(leaf.categoryKey) ?? { key: leaf.categoryKey, name: leaf.categoryName, count: 0, types: new Map() };
      const type = category.types.get(typeKey) ?? { key: typeKey, name: leaf.name, count: 0 };
      category.types.set(typeKey, type);
      categories.set(leaf.categoryKey, category);
      if (!leaf.total) continue;
      category.count += leaf.total;
      type.count += leaf.total;
      const status =
        FIXED_STATUS[filter] ??
        (total(notEnabled!.leaves, propertyReference, typeKey) ? "not_required"
          : total(missing!.leaves, propertyReference, typeKey) ? "not_started"
            : total(expired!.leaves, propertyReference, typeKey) ? "expired"
              : total(expiring!.leaves, propertyReference, typeKey) ? "due_soon"
                : "in_date");
      rows.push({
        propertyReference,
        propertyName: selected.names.get(propertyReference) || propertyReference,
        categoryKey: leaf.categoryKey,
        categoryName: leaf.categoryName,
        typeKey,
        typeName: leaf.name,
        status,
        carriedOut: null,
        expiry: null,
      });
    }
  }

  // Dates only exist where there is a record, so "not started" and "not required" rows skip the lookups.
  const datedProperties = [...new Set(rows.filter((row) => row.status !== "not_started" && row.status !== "not_required").map((row) => row.propertyReference))];
  const datesUnavailable: string[] = [];
  const recordsByProperty = new Map(
    await inBatches(datedProperties, 4, async (reference) => {
      try {
        return [reference, await recordsFor(reference)] as const;
      } catch {
        datesUnavailable.push(selected.names.get(reference) || reference);
        return [reference, [] as ComplianceRecord[]] as const;
      }
    }),
  );
  for (const row of rows) {
    const record = recordsByProperty.get(row.propertyReference)?.find((item) => item.key === row.typeKey);
    if (record && record.status !== "missing" && record.status !== "not_required") {
      row.carriedOut = record.validFrom;
      row.expiry = record.validTo;
    }
  }

  const order: Record<ItemStatus, number> = { expired: 0, due_soon: 1, not_started: 2, in_date: 3, not_required: 4 };
  rows.sort(
    (a, b) =>
      order[a.status] - order[b.status] ||
      (a.expiry ?? "9999").localeCompare(b.expiry ?? "9999") ||
      a.propertyName.localeCompare(b.propertyName, "en-GB", { numeric: true }) ||
      a.typeName.localeCompare(b.typeName),
  );
  return GetComplianceResponse.parse({
    status: filter,
    asOf: ukToday(),
    categories: [...categories.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((category) => ({ ...category, types: [...category.types.values()].sort((a, b) => a.name.localeCompare(b.name)) })),
    rows,
    datesUnavailable,
  });
}

const complianceRouter: IRouter = Router();

complianceRouter.get("/compliance", async (req, res): Promise<void> => {
  if (!cohoApiKey()) {
    res.status(503).json({ error: "COHO_API_KEY is not configured." });
    return;
  }
  const params = GetComplianceQueryParams.safeParse(req.query);
  const filter: Filter = params.success && params.data.status ? params.data.status : "expired";
  const hit = listCache.get(filter);
  if (hit && Date.now() - hit.at < LIST_CACHE_MS && req.query.refresh !== "1") {
    res.json(hit.body);
    return;
  }
  try {
    const body = await buildList(filter);
    if (!body.datesUnavailable.length) listCache.set(filter, { at: Date.now(), body });
    res.json(body);
  } catch (error) {
    req.log.warn({ err: error, filter }, "COHO compliance list unavailable");
    res.status(502).json({ error: "COHO could not be reached. Try again." });
  }
});

export default complianceRouter;
