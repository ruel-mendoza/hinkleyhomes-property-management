import { timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type RequestHandler } from "express";
import { isDatabaseConfigured } from "@workspace/db";
import { cohoApiKey, pmsSyncKey } from "../lib/integrations-env";
import { syncCohoActions } from "../lib/coho-actions-sync";
import { recordUnitSnapshot, ukToday } from "../lib/performance";
import { performanceData } from "./performance";

// Machine-to-machine endpoints (n8n schedules). Mounted before the staff
// sign-in check, so each request must carry the shared PMS_SYNC_KEY instead.
const router: IRouter = Router();

const requireSyncKey: RequestHandler = (req, res, next) => {
  const expected = pmsSyncKey();
  const provided = req.get("X-Hinkley-Sync-Key") ?? "";
  if (!expected) {
    res.status(503).json({ error: "PMS_SYNC_KEY is not configured." });
    return;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
};

router.post("/integrations/coho/actions/sync", requireSyncKey, async (_req, res): Promise<void> => {
  if (!isDatabaseConfigured() || !cohoApiKey()) {
    res.status(503).json({ error: "COHO or the database is not configured." });
    return;
  }
  const result = await syncCohoActions("schedule");
  res.status(result.status === "failed" ? 502 : 200).json(result);
});

// Daily unit snapshot for occupancy history (see lib/performance.ts). The
// Performance page also records one when opened; this keeps days covered
// when nobody opens it.
router.post("/integrations/coho/unit-snapshot", requireSyncKey, async (req, res): Promise<void> => {
  if (!isDatabaseConfigured() || !cohoApiKey()) {
    res.status(503).json({ error: "COHO or the database is not configured." });
    return;
  }
  try {
    const day = ukToday();
    const units = await recordUnitSnapshot(await performanceData(true), day);
    res.json({ day, units });
  } catch (error) {
    req.log.error({ err: error }, "Scheduled unit snapshot failed");
    res.status(502).json({ error: "The unit snapshot could not be recorded." });
  }
});

export default router;
