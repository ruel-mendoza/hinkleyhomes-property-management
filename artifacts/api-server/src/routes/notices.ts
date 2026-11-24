import { Router, type IRouter } from "express";
import { isDatabaseConfigured } from "@workspace/db";
import {
  ClearNoticeHistoryResponse,
  GetNoticeHistoryResponse,
  MarkNoticesSeenResponse,
  GetNoticeSettingsResponse,
  ListLatestNoticesQueryParams,
  ListLatestNoticesResponse,
  UpdateNoticeSettingsBody,
  UpdateNoticeSettingsResponse,
} from "@workspace/api-zod";
import { latestNotices, markNoticesSeen, noticeHistory, readNoticeSettings, saveNoticeSettings } from "../lib/notices";

// Popup notices for background updates; see lib/notices.ts. The first read,
// with no since, only returns the current time, so opening the app doesn't
// replay old updates. Each staff member's on/off choices are applied here.

const router: IRouter = Router();
type Staff = { userId?: string; email?: string } | undefined;

router.get("/notices/latest", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  const query = ListLatestNoticesQueryParams.safeParse(req.query);
  const since = query.success && query.data.since ? new Date(query.data.since) : null;
  const now = new Date();
  try {
    const items = since && !Number.isNaN(since.getTime())
      // Settings unreadable (e.g. table not pushed yet): show everything rather than nothing.
      ? await latestNotices(since, await readNoticeSettings((res.locals.staff as Staff)?.email).catch((error: unknown) => {
        req.log.warn({ err: error }, "Notice settings could not be read; showing all notices");
        return undefined;
      }))
      : [];
    res.json(ListLatestNoticesResponse.parse({ now: now.toISOString(), items }));
  } catch (error) {
    req.log.error({ err: error }, "Notices could not be read");
    res.status(503).json({ error: "Notices could not be read." });
  }
});

// The bell's list. Before the table is pushed it simply comes back empty.
router.get("/notices/history", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  try {
    res.json(GetNoticeHistoryResponse.parse(await noticeHistory((res.locals.staff as Staff)?.email)));
  } catch (error) {
    req.log.error({ err: error }, "Notification list could not be read");
    res.status(503).json({ error: "The notification list isn't set up yet: run the database push." });
  }
});

for (const [path, clear] of [["/notices/history/seen", false], ["/notices/history/clear", true]] as const) {
  router.post(path, async (req, res): Promise<void> => {
    if (!isDatabaseConfigured()) {
      res.status(503).json({ error: "The database is not configured." });
      return;
    }
    const staff = res.locals.staff as Staff;
    if (!staff?.email) {
      res.status(400).json({ error: "No staff email on this sign-in." });
      return;
    }
    try {
      const history = await markNoticesSeen(staff.email, clear);
      res.json((clear ? ClearNoticeHistoryResponse : MarkNoticesSeenResponse).parse(history));
    } catch (error) {
      req.log.error({ err: error }, "Notification list could not be updated");
      res.status(503).json({ error: "The notification list isn't set up yet: run the database push." });
    }
  });
}

router.get("/notices/settings", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  try {
    res.json(GetNoticeSettingsResponse.parse(await readNoticeSettings((res.locals.staff as Staff)?.email)));
  } catch (error) {
    req.log.error({ err: error }, "Notice settings could not be read");
    res.status(503).json({ error: "Notice settings aren't set up yet: run the database push." });
  }
});

router.put("/notices/settings", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  const body = UpdateNoticeSettingsBody.safeParse(req.body);
  const staff = res.locals.staff as Staff;
  if (!body.success || !staff?.email) {
    res.status(400).json({ error: "Invalid notice settings." });
    return;
  }
  try {
    const saved = await saveNoticeSettings(body.data, { email: staff.email, userId: staff.userId ?? null }, {
      requestId: req.id !== undefined && req.id !== null ? String(req.id) : null,
      ipAddress: req.ip ?? null,
    });
    res.json(UpdateNoticeSettingsResponse.parse(saved));
  } catch (error) {
    req.log.error({ err: error }, "Notice settings could not be saved");
    res.status(503).json({ error: "Notice settings aren't set up yet: run the database push." });
  }
});

export default router;
