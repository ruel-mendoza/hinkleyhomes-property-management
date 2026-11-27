import { Router, type IRouter } from "express";
import { isDatabaseConfigured } from "@workspace/db";
import { GetMessagesResponse } from "@workspace/api-zod";
import { messages } from "../lib/messages";

// Messages page; see lib/messages.ts.

const router: IRouter = Router();

router.get("/messages", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured()) { res.status(503).json({ error: "The database is not configured." }); return; }
  try {
    res.json(GetMessagesResponse.parse(await messages()));
  } catch (error) {
    req.log.error({ err: error }, "Messages request failed");
    res.status(503).json({ error: "Messages aren't set up yet: run the database push." });
  }
});

export default router;
