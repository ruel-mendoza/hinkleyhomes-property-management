import { Router, type IRouter } from "express";
import { auditLogTable, getDb, isDatabaseConfigured } from "@workspace/db";
import { CreateTellerooFileBody, CreateTellerooFileResponse, GetPayRunsResponse } from "@workspace/api-zod";
import { readXeroGatewayEnv } from "../lib/integrations-env";
import { buildTellerooFile, TellerooFileError } from "../lib/telleroo-file";
import { payRuns } from "../lib/telleroo-pay-runs";

// Supplier payments: Telleroo pay runs (read-only, from Supabase; see
// lib/telleroo-pay-runs.ts) and the Telleroo upload file built from Xero bills
// (lib/telleroo-file.ts).
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

router.post("/payments/telleroo-file", async (req, res): Promise<void> => {
  if (!isDatabaseConfigured() || readXeroGatewayEnv().status !== "configured") {
    res.status(503).json({ error: "The database or the Xero connection isn't set up, so the file can't be made." });
    return;
  }
  const body = CreateTellerooFileBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Choose between 1 and 200 bills." });
    return;
  }
  const staff = res.locals.staff as { userId?: string; email?: string } | undefined;
  try {
    const file = await buildTellerooFile({ ...body.data, staffEmail: staff?.email ?? null });
    // Logged without bank details: which bills went into which file, and the total.
    await getDb()
      .insert(auditLogTable)
      .values({
        actorEmail: staff?.email ?? null,
        actorUserId: staff?.userId ?? null,
        action: "telleroo_file.download",
        tableName: "telleroo_file_bills",
        recordId: file.fileName,
        before: null,
        after: {
          total: file.total,
          included: file.included.map(({ company, supplier, number, amount }) => ({ company, supplier, number, amount })),
          skipped: file.skipped.map(({ company, supplier, number, reason }) => ({ company, supplier, number, reason })),
          includeRepeats: body.data.includeRepeats === true,
        },
        requestId: req.id !== undefined && req.id !== null ? String(req.id) : null,
        ipAddress: req.ip ?? null,
      })
      .catch((error: unknown) => req.log.error({ err: error }, "Could not write the audit log entry"));
    res.json(CreateTellerooFileResponse.parse(file));
  } catch (error) {
    req.log.warn({ err: error }, "Telleroo file could not be made");
    res.status(error instanceof TellerooFileError ? 400 : 502).json({ error: error instanceof TellerooFileError ? error.message : "Xero couldn't be read to check the bills. Try again in a minute." });
  }
});

export default router;
