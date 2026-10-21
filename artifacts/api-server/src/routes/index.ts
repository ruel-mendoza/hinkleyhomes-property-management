import { Router, type IRouter } from "express";
import authRouter from "./auth";
import cohoRouter from "./coho";
import cohoActionsRouter from "./coho-actions";
import healthRouter from "./health";
import integrationsRouter from "./integrations";
import { requireStaffAccess } from "../middlewares/requireStaffAccess";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
// Key-authenticated machine endpoints; must stay above requireStaffAccess.
router.use(integrationsRouter);
router.use(requireStaffAccess);
router.use(cohoRouter);
router.use(cohoActionsRouter);

export default router;
