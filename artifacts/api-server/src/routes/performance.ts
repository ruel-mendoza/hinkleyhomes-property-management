import { Router, type IRouter } from "express";
import { isDatabaseConfigured } from "@workspace/db";
import { GetPerformanceResponse } from "@workspace/api-zod";
import { cohoApiKey } from "../lib/integrations-env";
import {
  computePerformance,
  loadCohoPerformanceData,
  readSnapshots,
  recordUnitSnapshot,
  ukToday,
  type CohoPerformanceData,
} from "../lib/performance";

// COHO data for the Performance page changes little within a day, and loading
// it takes ~25 COHO calls, so it is kept for an hour.
const CACHE_MS = 60 * 60_000;
let cached: CohoPerformanceData | null = null;
let loading: Promise<CohoPerformanceData> | null = null;
let snapshotDay: string | null = null;

export async function performanceData(refresh = false): Promise<CohoPerformanceData> {
  if (!refresh && cached && Date.now() - cached.loadedAt < CACHE_MS) return cached;
  loading ??= loadCohoPerformanceData().finally(() => {
    loading = null;
  });
  cached = await loading;
  return cached;
}

const performanceRouter: IRouter = Router();

performanceRouter.get("/performance", async (req, res): Promise<void> => {
  if (!cohoApiKey()) {
    res.status(503).json({ error: "COHO_API_KEY is not configured." });
    return;
  }
  let data: CohoPerformanceData;
  try {
    data = await performanceData(req.query.refresh === "1");
  } catch (error) {
    req.log.warn({ err: error }, "COHO performance data unavailable");
    res.status(502).json({ error: "COHO could not be reached. Try again." });
    return;
  }

  const today = ukToday();
  let snapshotError: string | null = null;
  if (!isDatabaseConfigured()) {
    snapshotError = "The database is not configured, so occupancy history is not being recorded.";
  } else if (snapshotDay !== today) {
    try {
      await recordUnitSnapshot(data, today);
      snapshotDay = today;
    } catch (error) {
      req.log.error({ err: error }, "Could not save today's unit snapshot");
      snapshotError = "Today's occupancy snapshot could not be saved.";
    }
  }
  const snapshots = await readSnapshots(`${Number(today.slice(0, 4)) - 1}${today.slice(4)}`).catch((error: unknown) => {
    req.log.error({ err: error }, "Could not read unit snapshots");
    snapshotError ??= "Occupancy history could not be read.";
    return [];
  });

  const reference = typeof req.query.propertyReference === "string" && req.query.propertyReference.trim() ? req.query.propertyReference.trim() : null;
  res.json(GetPerformanceResponse.parse({ ...computePerformance(data, snapshots, reference, today), snapshotError }));
});

export default performanceRouter;
