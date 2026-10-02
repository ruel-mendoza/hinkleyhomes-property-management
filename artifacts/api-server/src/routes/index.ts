import { Router, type IRouter } from "express";
import cohoRouter from "./coho";
import healthRouter from "./health";

const router: IRouter = Router();

router.use(healthRouter);
router.use(cohoRouter);

export default router;
