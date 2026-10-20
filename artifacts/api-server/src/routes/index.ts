import { Router, type IRouter } from "express";
import authRouter from "./auth";
import cohoRouter from "./coho";
import healthRouter from "./health";
import { requireStaffAccess } from "../middlewares/requireStaffAccess";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(requireStaffAccess);
router.use(cohoRouter);

export default router;
