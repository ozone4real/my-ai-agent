import { Router } from "express"
import conversationsRouter from "./conversations"
import settingsRouter from "./settings"
import tasksRouter from "./tasks"
import bullBoard from "./admin/bull_board"

const router = Router()

router.use("/conversations", conversationsRouter)
router.use("/tasks", tasksRouter)
router.use("/settings", settingsRouter)
router.use("/admin/queues", bullBoard)

export default router