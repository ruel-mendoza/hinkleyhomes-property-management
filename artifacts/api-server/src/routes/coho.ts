import { Router, type IRouter, type Request, type Response } from "express";
import {
  CompleteCohoMaintenanceBody,
  CompleteCohoMaintenanceParams,
  CompleteCohoMaintenanceResponse,
  CreateCohoMaintenanceBody,
  CreateCohoMaintenanceResponse,
  GetCohoStatusResponse,
  ListCohoMaintenanceCategoriesResponse,
  ListCohoMaintenanceQueryParams,
  ListCohoMaintenanceResponse,
  ListCohoPropertiesQueryParams,
  ListCohoPropertiesResponse,
  UpdateCohoMaintenanceBody,
  UpdateCohoMaintenanceParams,
  UpdateCohoMaintenanceResponse,
} from "@workspace/api-zod";

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
  const apiKey = process.env.COHO_API_KEY?.trim();
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
      configured: Boolean(process.env.COHO_API_KEY?.trim()),
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
      const rooms = Array.isArray(property.rooms) ? property.rooms : [];
      return {
        reference: stringOrNull(property.reference),
        name: stringOrNull(property.name),
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

router.get("/coho/maintenance", async (req, res): Promise<void> => {
  const params = ListCohoMaintenanceQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: "Invalid maintenance list query." });
    return;
  }

  const query = new URLSearchParams({
    page: String(params.data.page ?? 1),
    pageSize: String(params.data.pageSize ?? 50),
    sortColumn: "created",
    sortOrder: "desc",
  });
  if (params.data.propertyReference) {
    query.set("propertyReference", params.data.propertyReference);
  }
  const payload = await requestCoho(req, res, `/maintenance?${query}`);
  if (payload === undefined) return;

  const source = asRecord(payload);
  const normalized = {
    ...source,
    items: Array.isArray(source.items) ? source.items : [],
    page: positiveInteger(source.page, params.data.page ?? 1),
    pageSize: positiveInteger(source.pageSize, params.data.pageSize ?? 50),
    totalCount: Number.isInteger(source.totalCount) ? source.totalCount : 0,
    hasNextPage: source.hasNextPage === true,
    hasPreviousPage: source.hasPreviousPage === true,
  };
  sendParsed(req, res, ListCohoMaintenanceResponse, normalized);
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

export default router;