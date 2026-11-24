import { Router, type IRouter } from "express";
import { isDatabaseConfigured } from "@workspace/db";
import { ListLatestNoticesQueryParams, ListLatestNoticesResponse } from "@workspace/api-zod";
import { latestNotices } from "../lib/notices";

// Popup notices for background updates; see lib/notices.ts. The first read,
// with no since, only returns the current time, so opening the app doesn't
// replay old updates.

const router: IRouter = Router();

router.get("/notices/latest", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  const query = ListLatestNoticesQueryParams.safeParse(req.query);
  const since = query.success && query.data.since ? new Date(query.data.since) : null;
  const now = new Date();
  try {
    const items = since && !Number.isNaN(since.getTime()) ? await latestNotices(since) : [];
    res.json(ListLatestNoticesResponse.parse({ now: now.toISOString(), items }));
  } catch (error) {
    req.log.error({ err: error }, "Notices could not be read");
    res.status(503).json({ error: "Notices could not be read." });
  }
});

export default router;
