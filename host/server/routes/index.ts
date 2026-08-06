import { Router } from "express"
import conversationsRouter from "./conversations"
import tasksRouter from "./tasks"

const router = Router()

router.use("/conversations", conversationsRouter)
router.use("/tasks", tasksRouter)

export default router