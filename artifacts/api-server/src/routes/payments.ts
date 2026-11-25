import { Router, type IRouter } from "express";
import { isDatabaseConfigured } from "@workspace/db";
import { GetPayRunsResponse } from "@workspace/api-zod";
import { payRuns } from "../lib/telleroo-pay-runs";

// Telleroo pay runs (read-only, from Supabase). See lib/telleroo-pay-runs.ts.
const router: IRouter = Router();

router.get("/payments/pay-runs", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database isn't configured, so pay runs can't be shown." });
    return;
  }
  try {
    res.json(GetPayRunsResponse.parse(await payRuns()));
  } catch (error) {
    req.log.error({ err: error }, "Pay runs could not be read");
    res.status(500).json({ error: "Pay runs could not be loaded. Try again in a moment." });
  }
});

export default router;
