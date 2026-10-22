import { Router, type IRouter, type Response } from "express";
import { desc, gte, sql } from "drizzle-orm";
import { getDb, isDatabaseConfigured, staffPresenceTable, type StaffPresence } from "@workspace/db";
import { GetPresenceResponse, SendPresenceHeartbeatBody } from "@workspace/api-zod";

// Who is using the app. The browser sends a heartbeat about once a minute while
// the app is open; a person is "online" if seen in the last 2.5 minutes with the
// tab in front, "away" if the tab is in the background or they were seen in the
// last 10 minutes, otherwise "offline" with a last-seen time.

const ONLINE_MS = 150_000;
const AWAY_MS = 10 * 60_000;
const SESSION_GAP_MS = 10 * 60_000;
const LIST_DAYS = 30;

// Page names only: search terms and filters in the address bar are never stored.
const PAGES: [RegExp, string][] = [
  [/^\/dashboard\/?$/, "Overview"],
  [/^\/properties\/?$/, "Properties"],
  [/^\/properties\/.+/, "Property details"],
  [/^\/calendar\/?$/, "Calendar"],
  [/^\/occupancy\/?$/, "Occupancy"],
  [/^\/performance\/?$/, "Performance"],
  [/^\/compliance\/?$/, "Compliance"],
  [/^\/actions\/?$/, "Actions"],
  [/^\/maintenance\/?$/, "Maintenance"],
  [/^\/finance\/?$/, "Rent & fees"],
  [/^\/bank-feed\/?$/, "Rent bank feed"],
  [/^\/invoices\/?$/, "Invoices"],
];
const pageName = (path: string) => PAGES.find(([pattern]) => pattern.test(path.split(/[?#]/)[0]))?.[1] ?? "Other page";

function view(row: StaffPresence, now: number, youId: string | undefined) {
  const age = now - row.lastSeenAt.getTime();
  const status = age <= ONLINE_MS && row.tabVisible ? "online" : age <= AWAY_MS ? "away" : "offline";
  return {
    userId: row.userId,
    name: row.displayName || row.email?.split("@")[0] || "Staff member",
    email: row.email,
    status,
    currentPage: status === "offline" ? null : row.currentPage,
    lastSeenAt: row.lastSeenAt.toISOString(),
    sessionStartedAt: row.sessionStartedAt.toISOString(),
    isYou: row.userId === youId,
  } as const;
}

async function presenceList(res: Response) {
  const staff = res.locals.staff as { userId?: string } | undefined;
  const now = Date.now();
  const rows = await getDb()
    .select()
    .from(staffPresenceTable)
    .where(gte(staffPresenceTable.lastSeenAt, new Date(now - LIST_DAYS * 86_400_000)))
    .orderBy(desc(staffPresenceTable.lastSeenAt));
  const order = { online: 0, away: 1, offline: 2 };
  const users = rows.map((row) => view(row, now, staff?.userId)).sort((a, b) => order[a.status] - order[b.status] || b.lastSeenAt.localeCompare(a.lastSeenAt));
  return GetPresenceResponse.parse({ asOf: new Date(now).toISOString(), onlineCount: users.filter((user) => user.status === "online").length, users });
}

const presenceRouter: IRouter = Router();

presenceRouter.get("/presence", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  try {
    res.json(await presenceList(res));
  } catch (error) {
    req.log.error({ err: error }, "Staff presence could not be read");
    res.status(503).json({ error: "Staff presence isn't set up yet: run the database push." });
  }
});

presenceRouter.post("/presence/heartbeat", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) {
    res.status(503).json({ error: "The database is not configured." });
    return;
  }
  const body = SendPresenceHeartbeatBody.safeParse(req.body);
  const staff = res.locals.staff as { userId?: string; email?: string } | undefined;
  if (!body.success || !staff?.userId) {
    res.status(400).json({ error: "Invalid heartbeat." });
    return;
  }
  const t = staffPresenceTable;
  const values = {
    email: staff.email ?? null,
    displayName: body.data.displayName?.trim().slice(0, 120) || null,
    currentPage: pageName(body.data.path),
    tabVisible: body.data.visible,
  };
  try {
    await getDb()
      .insert(t)
      .values({ userId: staff.userId, ...values })
      .onConflictDoUpdate({
        target: t.userId,
        set: {
          ...values,
          displayName: sql`coalesce(excluded.display_name, ${t.displayName})`,
          // A gap of more than 10 minutes starts a new session.
          sessionStartedAt: sql`case when ${t.lastSeenAt} < now() - interval '${sql.raw(String(SESSION_GAP_MS / 60_000))} minutes' then now() else ${t.sessionStartedAt} end`,
          lastSeenAt: sql`now()`,
        },
      });
    res.json(await presenceList(res));
  } catch (error) {
    req.log.error({ err: error }, "Staff presence heartbeat failed");
    res.status(503).json({ error: "Staff presence isn't set up yet: run the database push." });
  }
});

export default presenceRouter;
