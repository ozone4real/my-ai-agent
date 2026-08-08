import { Router } from "express"
import type { Request, Response } from "express"
import { loadSettings, resetSettings } from "../models/settings"
import {
  applySettingsUpdate,
  serializeSettings,
  settingsUpdateShape,
} from "../serializers/settings"

const router = Router()

// One document, so there's nothing to create or list. GET creates defaults.
router.get("/", async (_req: Request, res: Response) => {
  res.json(serializeSettings(await loadSettings()))
})

router.patch("/", async (req: Request, res: Response) => {
  // safeParse: Express 5 turns a thrown ZodError into a 500.
  const parsed = settingsUpdateShape.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") })
    return
  }

  const settings = await loadSettings()
  applySettingsUpdate(settings, parsed.data)

  try {
    await settings.save()
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    return
  }

  res.json(serializeSettings(settings))
})

/** Reset rather than remove — the app always needs a settings document. */
router.delete("/", async (_req: Request, res: Response) => {
  res.json(serializeSettings(await resetSettings()))
})

export default router
