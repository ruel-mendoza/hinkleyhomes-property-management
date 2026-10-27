import { Router, type IRouter, type Response } from "express";
import { isDatabaseConfigured } from "@workspace/db";
import {
  GetStaysResponse,
  LinkStayApartmentBody,
  LinkStayApartmentParams,
  LinkStayApartmentResponse,
  ListStayApartmentsResponse,
  SyncStaysResponse,
} from "@workspace/api-zod";
import { smoobuMode } from "../lib/integrations-env";
import { StaysError, linkApartment, listApartments, staysOverview, syncStays } from "../lib/stays";

// Stays page (Hinkley Homes Stays, read-only from Smoobu) and the Smoobu
// apartments tab on the Properties page. See lib/stays.ts.
const router: IRouter = Router();

function notConnected(res: Response): boolean {
  if (isDatabaseConfigured() && smoobuMode()) return false;
  res.status(503).json({ error: "Smoobu isn't connected yet: add N8N_SMOOBU_GATEWAY_URL (or SMOOBU_API_KEY)." });
  return true;
}

router.get("/stays", async (req, res): Promise<void> => {
  if (notConnected(res)) return;
  try {
    res.json(GetStaysResponse.parse(await staysOverview()));
  } catch (error) {
    req.log.error({ err: error }, "Stays could not be read");
    res.status(503).json({ error: "Stays aren't set up yet: run the database push." });
  }
});

router.post("/stays/sync", async (_req, res): Promise<void> => {
  if (notConnected(res)) return;
  const result = await syncStays("manual");
  res.status(result.status === "failed" ? 502 : 200).json(SyncStaysResponse.parse(result));
});

router.get("/stays/apartments", async (req, res): Promise<void> => {
  if (notConnected(res)) return;
  try {
    res.json(ListStayApartmentsResponse.parse(await listApartments()));
  } catch (error) {
    req.log.error({ err: error }, "Smoobu apartments could not be read");
    res.status(503).json({ error: "Smoobu apartments aren't set up yet: run the database push." });
  }
});

router.put("/stays/apartments/:apartmentId/link", async (req, res): Promise<void> => {
  if (notConnected(res)) return;
  const params = LinkStayApartmentParams.safeParse(req.params);
  const body = LinkStayApartmentBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Choose a property to link the apartment to." });
    return;
  }
  const staff = res.locals.staff as { userId?: string; email?: string } | undefined;
  try {
    const item = await linkApartment(params.data.apartmentId, body.data, {
      email: staff?.email ?? null,
      userId: staff?.userId ?? null,
      requestId: req.id !== undefined && req.id !== null ? String(req.id) : null,
      ipAddress: req.ip ?? null,
    });
    res.json(LinkStayApartmentResponse.parse(item));
  } catch (error) {
    if (error instanceof StaysError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

export default router;
