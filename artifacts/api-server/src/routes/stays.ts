import { Router, type IRouter } from "express";
import { isDatabaseConfigured } from "@workspace/db";
import { GetStaysResponse, SyncStaysResponse } from "@workspace/api-zod";
import { smoobuMode } from "../lib/integrations-env";
import { staysOverview, syncStays } from "../lib/stays";

// Stays page (Hinkley Homes Stays, read-only from Smoobu). See lib/stays.ts.
const router: IRouter = Router();

router.get("/stays", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured() || !smoobuMode()) {
    res.status(503).json({ error: "Smoobu isn't connected yet: add N8N_SMOOBU_GATEWAY_URL (or SMOOBU_API_KEY)." });
    return;
  }
  try {
    res.json(GetStaysResponse.parse(await staysOverview()));
  } catch (error) {
    req.log.error({ err: error }, "Stays could not be read");
    res.status(503).json({ error: "Stays aren't set up yet: run the database push." });
  }
});

router.post("/stays/sync", async (_req, res): Promise<void> => {
  if (!isDatabaseConfigured() || !smoobuMode()) {
    res.status(503).json({ error: "Smoobu isn't connected yet: add N8N_SMOOBU_GATEWAY_URL (or SMOOBU_API_KEY)." });
    return;
  }
  const result = await syncStays("manual");
  res.status(result.status === "failed" ? 502 : 200).json(SyncStaysResponse.parse(result));
});

export default router;
