import { Router, type IRouter, type Request, type Response } from "express";
import {
  CompleteCohoMaintenanceBody,
  CompleteCohoMaintenanceParams,
  CompleteCohoMaintenanceResponse,
  CohoCalendarEntry,
  CreateCohoMaintenanceBody,
  CreateCohoMaintenanceResponse,
  CreateCohoViewingBody,
  CreateCohoViewingResponse,
  GetCohoStatusResponse,
  ListCohoCalendarQueryParams,
  ListCohoCalendarResponse,
  ListCohoMaintenanceCategoriesResponse,
  ListCohoMaintenanceQueryParams,
  ListCohoMaintenanceResponse,
  ListCohoPropertiesQueryParams,
  ListCohoPropertiesResponse,
  MergeCohoMaintenanceBody,
  MergeCohoMaintenanceParams,
  MergeCohoMaintenanceResponse,
  UpdateCohoMaintenanceBody,
  UpdateCohoMaintenanceParams,
  UpdateCohoMaintenanceResponse,
} from "@workspace/api-zod";
import { cohoApiKey } from "../lib/integrations-env";
import { mergeMaintenance } from "../lib/maintenance-merge";

const router: IRouter = Router();
const COHO_PUBLIC_API = "https://api.coho.life/v1.1/public";

type RecordValue = Record<string, unknown>;
type ResponseSchema = {
  safeParse(value: unknown):
    | { success: true; data: unknown }
    | { success: false; error: { issues: readonly unknown[] } };
};

function asRecord(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function dateOrNull(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function requestCoho(
  req: Request,
  res: Response,
  path: string,
  init: RequestInit = {},
): Promise<unknown | undefined> {
  const apiKey = cohoApiKey();
  if (!apiKey) {
    res.status(503).json({ error: "COHO_API_KEY is not configured." });
    return undefined;
  }

  try {
    const response = await fetch(`${COHO_PUBLIC_API}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const text = await response.text();
    const payload: unknown = text ? JSON.parse(text) : {};

    if (!response.ok) {
      const status = response.status >= 500 ? 502 : response.status;
      const details = asRecord(payload);
      const error =
        typeof details.detail === "string"
          ? details.detail
          : typeof details.title === "string"
            ? details.title
            : `COHO returned HTTP ${response.status}.`;
      req.log.warn(
        { upstreamStatus: response.status },
        "COHO API request was rejected",
      );
      res.status(status).json({ error });
      return undefined;
    }
    return payload;
  } catch (error) {
    req.log.warn({ err: error }, "COHO API request failed");
    res.status(502).json({ error: "Could not reach the COHO API." });
    return undefined;
  }
}

function sendParsed(
  req: Request,
  res: Response,
  schema: ResponseSchema,
  value: unknown,
): void {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    req.log.warn(
      { issueCount: parsed.error.issues.length },
      "COHO returned an unexpected response format",
    );
    res.status(502).json({ error: "COHO returned an unexpected response." });
    return;
  }
  res.json(parsed.data);
}

router.get("/coho/status", (_req, res): void => {
  res.json(
    GetCohoStatusResponse.parse({
      configured: Boolean(cohoApiKey()),
      apiVersion: "1.1",
    }),
  );
});

router.get("/coho/properties", async (req, res): Promise<void> => {
  const params = ListCohoPropertiesQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: "Invalid property list query." });
    return;
  }

  const page = params.data.page ?? 1;
  const pageSize = params.data.pageSize ?? 100;
  const query = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    includeRooms: "true",
  });
  const payload = await requestCoho(req, res, `/properties?${query}`);
  if (payload === undefined) return;

  const source = asRecord(payload);
  const sourceItems = Array.isArray(source.items) ? source.items : [];
  const normalized = {
    items: sourceItems.map((item) => {
      const property = asRecord(item);
      const address = asRecord(property.address);
      const rooms = Array.isArray(property.rooms) ? property.rooms : [];
      return {
        reference: stringOrNull(property.reference),
        name: stringOrNull(property.name),
        location: firstNonEmptyString(
          address.city,
          address.district,
          address.neighbourhood,
          address.adminAreaName,
          address.provinceName,
        ),
        rooms: rooms.map((room) => {
          const roomRecord = asRecord(room);
          return {
            reference: stringOrNull(roomRecord.reference),
            name: stringOrNull(roomRecord.name),
          };
        }),
      };
    }),
    page: positiveInteger(source.page, page),
    pageSize: positiveInteger(source.pageSize, pageSize),
    totalCount: Number.isInteger(source.totalCount) ? source.totalCount : 0,
    hasNextPage: source.hasNextPage === true,
    hasPreviousPage: source.hasPreviousPage === true,
  };
  sendParsed(req, res, ListCohoPropertiesResponse, normalized);
});

router.get("/coho/calendar", async (req, res): Promise<void> => {
  const params = ListCohoCalendarQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: "Invalid calendar query." });
    return;
  }

  const fromDate = params.data.fromDate;
  if (fromDate && !dateOrNull(fromDate)) {
    res.status(400).json({ error: "fromDate must be an ISO-8601 date-time." });
    return;
  }
  const query = fromDate
    ? `?${new URLSearchParams({ fromDate })}`
    : "";
  const sources = [
    { source: "calendarItem", path: "/calendar/items" },
    { source: "action", path: "/calendar/actions" },
    { source: "maintenanceIssue", path: "/calendar/maintenance-issues" },
    { source: "propertyViewing", path: "/calendar/property-viewings" },
    { source: "tenancy", path: "/calendar/tenancies" },
  ] as const;
  const items: CohoCalendarEntry[] = [];

  for (const calendarSource of sources) {
    const payload = await requestCoho(req, res, `${calendarSource.path}${query}`);
    if (payload === undefined) return;

    const sourceItems = asRecord(payload).items;
    if (!Array.isArray(sourceItems)) {
      req.log.warn(
        { source: calendarSource.source },
        "COHO returned an unexpected calendar response",
      );
      res.status(502).json({ error: "COHO returned an unexpected calendar response." });
      return;
    }

    for (const [index, item] of sourceItems.entries()) {
      const entry = asRecord(item);
      const entryDate = stringOrNull(entry.entryDate);
      const parsedEntryDate = dateOrNull(entryDate);
      if (!entryDate || !parsedEntryDate) {
        req.log.warn(
          { source: calendarSource.source },
          "COHO calendar entry is missing a valid date",
        );
        res.status(502).json({ error: "COHO returned an invalid calendar entry." });
        return;
      }
      const title = stringOrNull(entry.title);
      const stableId = firstNonEmptyString(
        entry.calendarItemGuid,
        entry.actionReference,
        entry.maintenanceGuid,
        entry.viewingGuid,
        entry.tenancyGuid,
      );
      items.push({
        id: stableId ?? `${calendarSource.source}:${entryDate}:${title ?? index}`,
        source: calendarSource.source,
        entryType: stringOrNull(entry.entryType) ?? calendarSource.source,
        entryDate: parsedEntryDate.toISOString(),
        endDate: dateOrNull(entry.endDate)?.toISOString() ?? null,
        isAllDay: entry.isAllDay === true,
        title,
        propertyReference: stringOrNull(entry.propertyReference),
        propertyName: stringOrNull(entry.propertyName),
        roomReference: stringOrNull(entry.roomReference),
        roomName: stringOrNull(entry.roomName),
        personName: stringOrNull(entry.conversationRespondentName),
      });
    }
  }

  items.sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  sendParsed(req, res, ListCohoCalendarResponse, { items });
});

router.get("/coho/maintenance", async (req, res): Promise<void> => {
  const params = ListCohoMaintenanceQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: "Invalid maintenance list query." });
    return;
  }

  // COHO's list can't search or leave out closed issues: an issue COHO closes
  // (e.g. its automatic Fire Safety Review jobs) gets a dateClosed but can still
  // say "reported". So every page is read (newest first) and filtered and paged
  // here; COHO's own screen hides closed issues, and so does this by default.
  const query = new URLSearchParams({ pageSize: "100", sortColumn: "created", sortOrder: "desc" });
  if (params.data.propertyReference) {
    query.set("propertyReference", params.data.propertyReference);
  }
  const all: unknown[] = [];
  for (let page = 1; page <= 20; page++) {
    query.set("page", String(page));
    const payload = await requestCoho(req, res, `/maintenance?${query}`);
    if (payload === undefined) return;
    const source = asRecord(payload);
    if (Array.isArray(source.items)) all.push(...source.items);
    if (source.hasNextPage !== true) break;
  }

  // Read raw: the generated schema coerces the string "false" to true.
  const includeClosed = req.query.includeClosed === "true";
  const isClosed = (item: unknown) => Boolean(asRecord(item).dateClosed);
  const closedCount = all.filter(isClosed).length;
  const search = params.data.search?.trim().toLowerCase();
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const matches = all.filter((item) => {
    if (!includeClosed && isClosed(item)) return false;
    if (!search) return true;
    const issue = asRecord(item);
    return [issue.jobNumber, issue.title, issue.requestMessage, issue.propertyName, issue.roomName, issue.tenantName, issue.publicStatus]
      .map(text)
      .join(" ")
      .toLowerCase()
      .includes(search);
  });
  const page = params.data.page ?? 1;
  const pageSize = params.data.pageSize ?? 50;
  sendParsed(req, res, ListCohoMaintenanceResponse, {
    items: matches.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
    totalCount: matches.length,
    hasNextPage: page * pageSize < matches.length,
    hasPreviousPage: page > 1,
    closedCount: includeClosed ? 0 : closedCount,
  });
});

router.get("/coho/maintenance/categories", async (req, res): Promise<void> => {
  const payload = await requestCoho(req, res, "/maintenance/categories");
  if (payload === undefined) return;

  const flattened: RecordValue[] = [];
  const visit = (items: unknown[], ancestors: string): void => {
    for (const value of items) {
      const category = asRecord(value);
      const name = stringOrNull(category.name);
      const hierarchy = stringOrNull(category.hierarchy) ?? ancestors;
      if (typeof category.guid === "string") {
        flattened.push({
          guid: category.guid,
          name,
          hierarchy,
          defaultSeverity: stringOrNull(category.defaultSeverity),
        });
      }
      const children = Array.isArray(category.children) ? category.children : [];
      const nextAncestors = [hierarchy, name].filter(Boolean).join(" / ");
      visit(children, nextAncestors);
    }
  };
  const source = asRecord(payload);
  visit(Array.isArray(source.items) ? source.items : [], "");
  sendParsed(req, res, ListCohoMaintenanceCategoriesResponse, {
    items: flattened,
  });
});

router.post("/coho/maintenance", async (req, res): Promise<void> => {
  const body = CreateCohoMaintenanceBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid maintenance issue details." });
    return;
  }

  const payload = await requestCoho(req, res, "/maintenance", {
    method: "POST",
    body: JSON.stringify(body.data),
  });
  if (payload === undefined) return;
  sendParsed(req, res, CreateCohoMaintenanceResponse, payload);
});

// Books a viewing for a prospective tenant. COHO notifies the property
// manager and may text the applicant, so this is a real-world action.
router.post("/coho/viewings", async (req, res): Promise<void> => {
  const body = CreateCohoViewingBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Check the viewing details and try again." });
    return;
  }
  const { proposedDate, proposedDuration } = body.data;
  if (proposedDate && proposedDate.getTime() < Date.now() - 5 * 60_000) {
    res.status(400).json({ error: "The proposed viewing time is in the past." });
    return;
  }

  const trimmedOrNull = (value: string | null | undefined) => value?.trim() || null;
  const payload = await requestCoho(req, res, "/viewings", {
    method: "POST",
    body: JSON.stringify({
      propertyReference: body.data.propertyReference.trim(),
      roomReference: trimmedOrNull(body.data.roomReference),
      forename: body.data.forename.trim(),
      surname: body.data.surname.trim(),
      emailAddress: body.data.emailAddress.trim(),
      mobileNumber: trimmedOrNull(body.data.mobileNumber),
      proposedDate: proposedDate ? proposedDate.toISOString() : null,
      proposedDuration: proposedDate ? (proposedDuration ?? null) : null,
      requestMessage: body.data.requestMessage.trim(),
    }),
  });
  if (payload === undefined) return;
  req.log.info(
    { propertyReference: body.data.propertyReference, viewingGuid: asRecord(payload).guid },
    "COHO viewing booked",
  );
  sendParsed(req, res, CreateCohoViewingResponse, payload);
});

router.patch("/coho/maintenance/:guid", async (req, res): Promise<void> => {
  const params = UpdateCohoMaintenanceParams.safeParse(req.params);
  const body = UpdateCohoMaintenanceBody.safeParse(req.body);
  if (!params.success || !body.success || Object.keys(body.data).length === 0) {
    res.status(400).json({ error: "Provide a valid severity or manager note." });
    return;
  }

  const payload = await requestCoho(
    req,
    res,
    `/maintenance/${params.data.guid}`,
    { method: "PATCH", body: JSON.stringify(body.data) },
  );
  if (payload === undefined) return;
  sendParsed(req, res, UpdateCohoMaintenanceResponse, { success: true });
});

router.patch(
  "/coho/maintenance/:guid/complete",
  async (req, res): Promise<void> => {
    const params = CompleteCohoMaintenanceParams.safeParse(req.params);
    const body = CompleteCohoMaintenanceBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Provide valid maintenance completion details." });
      return;
    }

    const payload = await requestCoho(
      req,
      res,
      `/maintenance/${params.data.guid}/complete`,
      { method: "PATCH", body: JSON.stringify(body.data) },
    );
    if (payload === undefined) return;
    sendParsed(req, res, CompleteCohoMaintenanceResponse, { success: true });
  },
);

// Duplicates are completed in COHO with a "Duplicate of" note; see lib/maintenance-merge.ts.
router.post("/coho/maintenance/:guid/merge", async (req, res): Promise<void> => {
  const params = MergeCohoMaintenanceParams.safeParse(req.params);
  const body = MergeCohoMaintenanceBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Choose the issue to keep and at least one duplicate." });
    return;
  }
  if (!cohoApiKey()) {
    res.status(503).json({ error: "COHO_API_KEY is not configured." });
    return;
  }
  const staff = res.locals.staff as { userId?: string; email?: string } | undefined;
  const result = await mergeMaintenance(params.data.guid, body.data.keepJobNumber, body.data.duplicates, {
    email: staff?.email ?? null,
    userId: staff?.userId ?? null,
    requestId: req.id !== undefined && req.id !== null ? String(req.id) : null,
    ipAddress: req.ip ?? null,
  });
  res.json(MergeCohoMaintenanceResponse.parse(result));
});

export default router;