import { Router, type IRouter } from "express";
import authRouter from "./auth";
import cohoRouter from "./coho";
import cohoActionsRouter from "./coho-actions";
import healthRouter from "./health";
import integrationsRouter from "./integrations";
import { propertiesRouter, publicListingsRouter } from "./properties";
import { requireStaffAccess } from "../middlewares/requireStaffAccess";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
// Key-authenticated machine endpoints; must stay above requireStaffAccess.
router.use(integrationsRouter);
// Public, no sign-in: the website widget's listings.
router.use(publicListingsRouter);
router.use(requireStaffAccess);
router.use(cohoRouter);
router.use(cohoActionsRouter);
router.use(propertiesRouter);

export default router;
