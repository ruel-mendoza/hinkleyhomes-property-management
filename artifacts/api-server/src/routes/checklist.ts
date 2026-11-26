import { Router, type IRouter, type Request, type Response } from "express";
import { isDatabaseConfigured } from "@workspace/db";
import { GetChecklistQueryParams, GetChecklistResponse, TickChecklistStepBody, TickChecklistStepResponse, UpdateChecklistStepsBody, UpdateChecklistStepsResponse } from "@workspace/api-zod";
import { checklist, ChecklistError, saveSteps, tickStep } from "../lib/checklist";

// Staff daily checklist; see lib/checklist.ts.

const router: IRouter = Router();
type Staff = { userId?: string; email?: string } | undefined;

const notReady = (req: Request, res: Response, error: unknown) => {
  if (error instanceof ChecklistError) { res.status(error.status).json({ error: error.message }); return; }
  req.log.error({ err: error }, "Checklist request failed");
  res.status(503).json({ error: "The checklist isn't set up yet: run the database push." });
};
const requestInfo = (req: Request) => ({ requestId: req.id !== undefined && req.id !== null ? String(req.id) : null, ipAddress: req.ip ?? null });

router.get("/checklist", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) { res.status(503).json({ error: "The database is not configured." }); return; }
  const query = GetChecklistQueryParams.safeParse(req.query);
  const day = query.success && query.data.day ? String(query.data.day instanceof Date ? query.data.day.toISOString().slice(0, 10) : query.data.day) : undefined;
  try { res.json(GetChecklistResponse.parse(await checklist(day))); } catch (error) { notReady(req, res, error); }
});

router.put("/checklist/ticks", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) { res.status(503).json({ error: "The database is not configured." }); return; }
  const body = TickChecklistStepBody.safeParse(req.body);
  const staff = res.locals.staff as Staff;
  if (!body.success || !staff?.email) { res.status(400).json({ error: "Invalid tick." }); return; }
  const day = body.data.day instanceof Date ? body.data.day.toISOString().slice(0, 10) : String(body.data.day);
  try {
    res.json(TickChecklistStepResponse.parse(await tickStep({ ...body.data, day }, { email: staff.email, userId: staff.userId ?? null }, requestInfo(req))));
  } catch (error) { notReady(req, res, error); }
});

router.put("/checklist/steps", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) { res.status(503).json({ error: "The database is not configured." }); return; }
  const body = UpdateChecklistStepsBody.safeParse(req.body);
  const staff = res.locals.staff as Staff;
  if (!body.success || !staff?.email) { res.status(400).json({ error: "Each step needs a title (up to 200 characters)." }); return; }
  try {
    res.json(UpdateChecklistStepsResponse.parse(await saveSteps(body.data, { email: staff.email, userId: staff.userId ?? null }, requestInfo(req))));
  } catch (error) { notReady(req, res, error); }
});

export default router;
