import { Router, type IRouter } from "express";
import authRouter from "./auth";
import cohoRouter from "./coho";
import cohoActionsRouter from "./coho-actions";
import healthRouter from "./health";
import integrationsRouter from "./integrations";
import moneyRouter from "./money";
import occupancyRouter from "./occupancy";
import performanceRouter from "./performance";
import complianceRouter from "./compliance";
import financeRouter from "./finance";
import receivablesRouter from "./receivables";
import presenceRouter from "./presence";
import checksRouter from "./checks";
import billCodingRouter from "./bill-coding";
import intakeReviewsRouter from "./intake-reviews";
import attentionRouter from "./attention";
import staysRouter from "./stays";
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
router.use(occupancyRouter);
router.use(moneyRouter);
router.use(performanceRouter);
router.use(complianceRouter);
router.use(financeRouter);
router.use(receivablesRouter);
router.use(presenceRouter);
router.use(checksRouter);
router.use(billCodingRouter);
router.use(intakeReviewsRouter);
router.use(attentionRouter);
router.use(staysRouter);

export default router;
