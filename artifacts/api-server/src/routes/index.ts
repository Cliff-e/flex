import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import vpsBotsRouter from "./vpsBots";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/vps-bots", vpsBotsRouter);

export default router;
