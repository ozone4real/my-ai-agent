import { Router } from "express"
import conversationsRouter from "./conversations"
import settingsRouter from "./settings"
import tasksRouter from "./tasks"

const router = Router()

router.use("/conversations", conversationsRouter)
router.use("/tasks", tasksRouter)
router.use("/settings", settingsRouter)

export default router