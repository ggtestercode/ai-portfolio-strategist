import { Router, type IRouter } from "express";
import healthRouter from "./health";
import userRouter from "./user";
import goalsRouter from "./goals";
import strategyRouter from "./strategy";
import portfolioRouter from "./portfolio";
import performanceRouter from "./performance";
import tradesRouter from "./trades";
import rebalancingRouter from "./rebalancing";
import transactionsRouter from "./transactions";
import alertsRouter from "./alerts";
import assistantRouter from "./assistant";
import dashboardRouter from "./dashboard";

const router: IRouter = Router();

router.use(healthRouter);
router.use(userRouter);
router.use(goalsRouter);
router.use(strategyRouter);
router.use(portfolioRouter);
router.use(performanceRouter);
router.use(tradesRouter);
router.use(rebalancingRouter);
router.use(transactionsRouter);
router.use(alertsRouter);
router.use(assistantRouter);
router.use(dashboardRouter);

export default router;
