import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  auditLogTable,
  buildingPropertiesTable,
  buildingsTable,
  cohoActionsTable,
  entitiesTable,
  getDb,
  isDatabaseConfigured,
  propertiesTable,
} from "@workspace/db";
import {
  CreateBuildingBody,
  CreateBuildingResponse,
  CreatePropertyBody,
  CreatePropertyResponse,
  ListEntitiesResponse,
  ListPropertiesResponse,
  GetPropertyDetailsResponse,
  ListPublicListingsResponse,
} from "@workspace/api-zod";
import { cohoApiKey } from "../lib/integrations-env";
import { CohoApiError, cohoGet } from "../lib/coho-api";
import { fetchCohoProperties, type CohoPropertyRow } from "../lib/coho-properties";
import { complianceFor, fetchComplianceBuckets, fetchPropertyRecords, requiredItems, type ComplianceBuckets } from "../lib/coho-compliance";

type RecordValue = Record<string, unknown>;
const asRecord = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const int = (value: unknown): number => (Number.isInteger(value) ? (value as number) : 0);
const OPEN_STATUSES = ["not_set", "new", "in_progress", "on_hold"] as const;

// UK postcode, normalised to "TA6 4AX". Returns null when it isn't one.
export function normalisePostcode(value: string): string | null {
  const compact = value.toUpperCase().replace(/\s+/g, "");
  if (compact === "GIR0AA") return "GIR 0AA";
  const match = /^([A-Z]{1,2}\d[A-Z\d]?)(\d[ABD-HJLNP-UW-Z]{2})$/.exec(compact);
  return match ? `${match[1]} ${match[2]}` : null;
}
const addressKey = (line: string, postcode: string | null) =>
  `${line.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}|${(postcode ?? "").replace(/\s+/g, "").toUpperCase()}`;

async function audit(req: Request, res: Response, action: string, tableName: string, recordId: string, after: unknown) {
  const staff = res.locals.staff as { userId?: string; email?: string } | undefined;
  await getDb()
    .insert(auditLogTable)
    .values({
      actorEmail: staff?.email ?? null,
      actorUserId: staff?.userId ?? null,
      action,
      tableName,
      recordId,
      before: null,
      after,
      requestId: req.id !== undefined && req.id !== null ? String(req.id) : null,
      ipAddress: req.ip ?? null,
    })
    .catch((error: unknown) => req.log.error({ err: error, action, recordId }, "Could not write the audit log entry"));
}

// --- Staff routes (mounted after requireStaffAccess) -----------------------

export const propertiesRouter: IRouter = Router();

propertiesRouter.get("/properties", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  const db = getDb();
  let coho: CohoPropertyRow[] = [];
  let cohoError: string | null = null;
  let compliance: ComplianceBuckets | null = null;
  if (cohoApiKey()) {
    try {
      [coho, compliance] = await Promise.all([
        fetchCohoProperties(),
        // A compliance failure only hides the scores; the property list still loads.
        fetchComplianceBuckets().catch((error: unknown) => {
          req.log.warn({ err: error }, "COHO compliance overview unavailable for the Properties page");
          return null;
        }),
      ]);
    } catch (error) {
      cohoError = error instanceof Error ? error.message : "COHO could not be reached.";
      req.log.warn({ err: error }, "COHO properties unavailable for the Properties page");
    }
  } else {
    cohoError = "COHO_API_KEY is not configured.";
  }

  const t = cohoActionsTable;
  const [actionCounts, register, buildings, members] = await Promise.all([
    db
      .select({ reference: t.cohoPropertyReference, count: sql<number>`count(*)::int` })
      .from(t)
      .where(and(inArray(t.status, [...OPEN_STATUSES]), eq(t.archived, false), eq(t.snoozed, false), isNull(t.removedFromCohoAt)))
      .groupBy(t.cohoPropertyReference),
    db
      .select({ property: propertiesTable, entityName: entitiesTable.name })
      .from(propertiesTable)
      .leftJoin(entitiesTable, eq(entitiesTable.id, propertiesTable.entityId)),
    db.select().from(buildingsTable),
    db.select().from(buildingPropertiesTable),
  ]);

  const openActions = new Map(actionCounts.map((row) => [row.reference ?? "", row.count]));
  const buildingName = new Map(buildings.map((building) => [building.id, building.name]));
  const buildingsFor = new Map<string, string[]>();
  for (const member of members) {
    const key = member.cohoPropertyReference ?? member.propertyId ?? "";
    const name = buildingName.get(member.buildingId);
    if (name) buildingsFor.set(key, [...(buildingsFor.get(key) ?? []), name]);
  }
  const cohoReferences = new Set(coho.map((row) => row.reference));

  const items = [
    ...coho.map((row) => ({
      id: row.reference,
      source: "coho" as const,
      cohoReference: row.reference,
      name: row.name,
      houseNumber: row.houseNumber,
      streetName: row.streetName,
      postcode: row.postcode,
      town: row.town,
      imageUrl: row.imageUrl,
      tags: row.tags,
      totalRooms: row.totalRooms,
      roomsOccupied: Math.min(row.roomsOccupied, row.totalRooms),
      rentalType: row.rentalType,
      propertyType: row.propertyType,
      deactivated: false,
      openActionsCount: openActions.get(row.reference) ?? 0,
      buildings: buildingsFor.get(row.reference) ?? [],
      entityName: null,
      compliance: compliance ? complianceFor(compliance, row.reference) : null,
    })),
    // Register rows already linked to a listed COHO property are shown once, as the COHO one.
    ...register
      .filter(({ property }) => !property.cohoPropertyReference || !cohoReferences.has(property.cohoPropertyReference))
      .map(({ property, entityName }) => ({
        id: property.id,
        source: "register" as const,
        cohoReference: property.cohoPropertyReference,
        name: property.name,
        houseNumber: property.houseNumber,
        streetName: property.streetName,
        postcode: property.postcode,
        town: property.city,
        imageUrl: property.imageUrl,
        tags: property.tags,
        totalRooms: property.totalRooms,
        roomsOccupied: null,
        rentalType: property.propertyType === "single_let" ? ("whole_property" as const) : ("room" as const),
        propertyType: property.propertyType,
        deactivated: property.status === "archived",
        openActionsCount: 0,
        buildings: buildingsFor.get(property.id) ?? [],
        entityName,
        compliance: null,
      })),
  ];
  const propertyCount = new Map<string, number>();
  for (const member of members) propertyCount.set(member.buildingId, (propertyCount.get(member.buildingId) ?? 0) + 1);

  res.json(
    ListPropertiesResponse.parse({
      items,
      buildings: buildings.map((building) => ({
        id: building.id,
        name: building.name,
        addressLine1: building.addressLine1,
        postcode: building.postcode,
        propertyCount: propertyCount.get(building.id) ?? 0,
      })),
      cohoError,
    }),
  );
});

// Plain text from COHO's advert HTML.
const htmlToText = (html: string | null): string | null => {
  if (!html) return null;
  const text = html
    .replace(/<\s*(br|\/?p|\/li|\/h\d)\b[^>]*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
};
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const intOrNull = (value: unknown): number | null => (Number.isInteger(value) ? (value as number) : null);
const numOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const dateOnly = (value: unknown): string | null => str(value)?.slice(0, 10) ?? null;

propertiesRouter.get("/properties/:reference/details", async (req, res): Promise<void> => {
  if (!cohoApiKey()) {
    res.status(503).json({ error: "COHO_API_KEY is not configured." });
    return;
  }
  const reference = String(req.params.reference ?? "").trim();
  if (!reference || reference.length > 200) {
    res.status(400).json({ error: "Give a COHO property reference." });
    return;
  }
  const path = `/properties/${encodeURIComponent(reference)}`;
  let property: RecordValue;
  try {
    property = asRecord(await cohoGet(`${path}?includeRooms=true`));
  } catch (error) {
    if (error instanceof CohoApiError && error.status === 404) {
      res.status(404).json({ error: "This property is not in COHO." });
      return;
    }
    req.log.warn({ err: error, reference }, "COHO property details unavailable");
    res.status(502).json({ error: "COHO could not be reached. Try again." });
    return;
  }

  const unavailable: string[] = [];
  const [ownership, buckets] = await Promise.all([
    cohoGet(`${path}/ownership/overview?includeRooms=false`).then(asRecord).catch(() => {
      unavailable.push("Ownership");
      return null;
    }),
    fetchComplianceBuckets(reference).catch(() => {
      unavailable.push("Compliance overview");
      return null;
    }),
  ]);
  const records = await fetchPropertyRecords(reference, buckets ? requiredItems(buckets, reference) : new Set());
  const address = asRecord(property.address);

  res.json(
    GetPropertyDetailsResponse.parse({
      reference,
      publicReference: str(property.publicReference),
      description: htmlToText(str(property.description) ?? str(property.headlineDescription)),
      propertyType: str(property.propertyType),
      bedrooms: intOrNull(property.numberOfBedrooms),
      bathrooms: intOrNull(property.numberOfBathrooms),
      amenities: Array.isArray(property.amenities) ? property.amenities.filter((item): item is string => typeof item === "string") : [],
      minimumMonths: intOrNull(property.minimumMonthsRental) || null,
      petsAllowed: bool(property.petsAllowed),
      smokingAllowed: bool(property.smokingAllowed),
      allowedTenantType: str(property.allowedTenantType),
      county: str(address.provinceName) ?? str(address.adminAreaName),
      rooms: (Array.isArray(property.rooms) ? property.rooms.map(asRecord) : []).map((room) => ({
        reference: str(room.reference) ?? "",
        name: str(room.name) ?? "Room",
        rent: numOrNull(room.rent),
        paymentFrequency: str(room.paymentFrequency),
        availableFrom: dateOnly(room.availableFrom),
        depositType: str(room.depositType),
        depositAmount: numOrNull(room.depositAmountRequired),
        bills: str(room.billsInclusive) ?? str(property.billsInclusive),
      })),
      ownership: ownership && {
        type: str(ownership.propertyOwnershipType),
        agencyPercentage: numOrNull(ownership.agencyPercentage),
        guaranteedRentAmount: numOrNull(ownership.guaranteedRentAmount),
        agencyFeeDue: str(ownership.agencyFeeDueCondition),
        startDate: dateOnly(ownership.startDate),
        endDate: dateOnly(ownership.endDate),
        vatStatus: str(ownership.vatStatus),
      },
      records: records.records,
      lastInspection: records.lastInspection,
      nextInspectionDue: records.nextInspectionDue,
      unavailable: [...unavailable, ...records.unavailable],
    }),
  );
});

propertiesRouter.get("/entities", async (_req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  const rows = await getDb().select({ id: entitiesTable.id, name: entitiesTable.name }).from(entitiesTable).orderBy(entitiesTable.name);
  res.json(ListEntitiesResponse.parse({ items: rows }));
});

propertiesRouter.post("/properties", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  const body = CreatePropertyBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Check the property details: street, town, postcode, company and number of rooms are required." });
    return;
  }
  const data = body.data;
  const postcode = normalisePostcode(data.postcode);
  if (!postcode) {
    res.status(400).json({ error: "Enter a valid UK postcode, e.g. TA6 4AX." });
    return;
  }
  if (data.imageUrl && !/^https:\/\//i.test(data.imageUrl)) {
    res.status(400).json({ error: "The image URL must start with https://." });
    return;
  }
  const db = getDb();
  const [entity] = await db.select().from(entitiesTable).where(eq(entitiesTable.id, data.entityId)).limit(1);
  if (!entity) {
    res.status(400).json({ error: "Choose which Hinkley Homes company owns the property." });
    return;
  }
  const houseNumber = data.houseNumber?.trim() || null;
  const streetName = data.streetName.trim();
  const line1 = [houseNumber, streetName].filter(Boolean).join(" ");
  const key = addressKey(line1, postcode);

  const existing = await db.select({ line: propertiesTable.addressLine1, postcode: propertiesTable.postcode }).from(propertiesTable);
  let cohoMatches: CohoPropertyRow[] = [];
  try {
    cohoMatches = cohoApiKey() ? await fetchCohoProperties() : [];
  } catch {
    // Duplicate check against COHO is best effort; the register check still runs.
  }
  const duplicate =
    existing.some((row) => addressKey(row.line, row.postcode) === key) ||
    cohoMatches.some((row) => addressKey([row.houseNumber, row.streetName].filter(Boolean).join(" ") || row.name, row.postcode) === key);
  if (duplicate) {
    res.status(409).json({ error: `${line1}, ${postcode} is already on the property list.` });
    return;
  }

  const tags = [...new Set((data.tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
  const [saved] = await db
    .insert(propertiesTable)
    .values({
      entityId: entity.id,
      name: line1,
      addressLine1: line1,
      city: data.town.trim(),
      postcode,
      propertyType: data.rentalType === "whole_property" ? "single_let" : "hmo",
      houseNumber,
      streetName,
      totalRooms: data.totalRooms,
      imageUrl: data.imageUrl || null,
      tags,
    })
    .returning();
  await audit(req, res, "property.create", "properties", saved.id, { name: saved.name, postcode, entity: entity.name, tags });

  res.json(
    CreatePropertyResponse.parse({
      id: saved.id,
      source: "register",
      cohoReference: null,
      name: saved.name,
      houseNumber: saved.houseNumber,
      streetName: saved.streetName,
      postcode: saved.postcode,
      town: saved.city,
      imageUrl: saved.imageUrl,
      tags: saved.tags,
      totalRooms: saved.totalRooms,
      roomsOccupied: null,
      rentalType: data.rentalType,
      propertyType: saved.propertyType,
      deactivated: false,
      openActionsCount: 0,
      buildings: [],
      entityName: entity.name,
      compliance: null,
    }),
  );
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

propertiesRouter.post("/buildings", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  const body = CreateBuildingBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Give the building a name." });
    return;
  }
  const data = body.data;
  let postcode: string | null = null;
  if (data.postcode?.trim()) {
    postcode = normalisePostcode(data.postcode);
    if (!postcode) {
      res.status(400).json({ error: "Enter a valid UK postcode, e.g. TA6 4AX." });
      return;
    }
  }
  const ids = [...new Set(data.propertyIds)];
  const db = getDb();
  const registerIds = ids.filter((id) => UUID.test(id));
  const cohoIds = ids.filter((id) => !UUID.test(id));
  const knownRegister = registerIds.length
    ? new Set((await db.select({ id: propertiesTable.id }).from(propertiesTable).where(inArray(propertiesTable.id, registerIds))).map((row) => row.id))
    : new Set<string>();
  let knownCoho = new Set<string>();
  if (cohoIds.length) {
    try {
      knownCoho = new Set((await fetchCohoProperties()).map((row) => row.reference));
    } catch {
      res.status(502).json({ error: "COHO could not be reached to check the selected properties. Try again." });
      return;
    }
  }
  const unknown = [...registerIds.filter((id) => !knownRegister.has(id)), ...cohoIds.filter((id) => !knownCoho.has(id))];
  if (unknown.length) {
    res.status(400).json({ error: "Some selected properties no longer exist. Reload the page and try again." });
    return;
  }

  const building = await db.transaction(async (tx) => {
    const [saved] = await tx
      .insert(buildingsTable)
      .values({ name: data.name.trim(), addressLine1: data.addressLine1?.trim() || null, postcode })
      .returning();
    if (ids.length) {
      await tx.insert(buildingPropertiesTable).values([
        ...registerIds.map((propertyId) => ({ buildingId: saved.id, propertyId })),
        ...cohoIds.map((cohoPropertyReference) => ({ buildingId: saved.id, cohoPropertyReference })),
      ]);
    }
    return saved;
  });
  await audit(req, res, "building.create", "buildings", building.id, { name: building.name, propertyIds: ids });

  res.json(
    CreateBuildingResponse.parse({
      id: building.id,
      name: building.name,
      addressLine1: building.addressLine1,
      postcode: building.postcode,
      propertyCount: ids.length,
    }),
  );
});

// --- Public route for the website widget (mounted before requireStaffAccess) ---
// Shows only what an advert would: street, town, postcode area, photo and
// availability. Never house numbers, tenants or internal references.

export const publicListingsRouter: IRouter = Router();
const LISTINGS_TTL_MS = 5 * 60_000;
let listingsCache: { at: number; items: unknown[] } | null = null;

publicListingsRouter.get("/public/listings", async (req, res): Promise<void> => {
  if (!cohoApiKey()) {
    res.status(503).json({ error: "Listings are not available right now." });
    return;
  }
  if (!listingsCache || Date.now() - listingsCache.at > LISTINGS_TTL_MS) {
    try {
      const rows = await fetchCohoProperties();
      listingsCache = {
        at: Date.now(),
        items: rows
          .filter((row) => row.roomsOccupied < row.totalRooms)
          .map((row) => ({
            id: row.publicReference ?? row.reference,
            title: [row.streetName ?? row.name.replace(/^\s*[\w-]*\d[\w-]*\s+/, ""), row.town].filter(Boolean).join(", "),
            town: row.town,
            postcodeArea: row.postcode ? row.postcode.split(/\s+/)[0] : null,
            imageUrl: row.imageUrl,
            roomsAvailable: row.totalRooms - row.roomsOccupied,
            totalRooms: row.totalRooms,
            rentalType: row.rentalType,
          })),
      };
    } catch (error) {
      req.log.warn({ err: error }, "Public listings could not be loaded from COHO");
      res.status(502).json({ error: "Listings are not available right now." });
      return;
    }
  }
  res.set("Cache-Control", "public, max-age=300");
  res.json(ListPublicListingsResponse.parse({ items: listingsCache.items }));
});
