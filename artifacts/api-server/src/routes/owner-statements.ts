import { Router, type IRouter } from "express";
import { GetOwnerStatementsQueryParams, GetOwnerStatementsResponse } from "@workspace/api-zod";
import { lastMonth, ownerStatements } from "../lib/owner-statements";
import { RentalNinjaError, rentalNinjaConfigured } from "../lib/rental-ninja";

// Owner statements page (read-only from Rental Ninja). See lib/owner-statements.ts.
const router: IRouter = Router();

router.get("/owner-statements", async (req, res): Promise<void> => {
  if (!rentalNinjaConfigured()) {
    res.status(503).json({ error: "Rental Ninja isn't connected yet: add RENTAL_NINJA_API_KEY and RENTAL_NINJA_SECRET to the secrets." });
    return;
  }
  const query = GetOwnerStatementsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Month must look like 2026-10." });
    return;
  }
  try {
    const body = await ownerStatements(query.data.month ?? lastMonth(), req.query.refresh === "1");
    res.json(GetOwnerStatementsResponse.parse(body));
  } catch (error) {
    req.log.warn({ err: error }, "Owner statements could not be read from Rental Ninja");
    res.status(502).json({ error: error instanceof RentalNinjaError ? error.message : "Rental Ninja could not be read. Try again in a few minutes." });
  }
});

export default router;
