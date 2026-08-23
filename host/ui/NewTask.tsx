import { useEffect, useState } from "react";
import { createTask, getSettings, type Task } from "./api";

/**
 * Form for creating a task by hand.
 *
 * The agent makes tasks with its `schedule-task` tool, but that requires
 * talking it through one. This is the direct route, and what it creates is
 * recorded as the user's — which is what stops the agent editing it later.
 */
export function NewTask({
  onCreated,
  onCancel,
}: {
  onCreated: (task: Task) => void;
  onCancel: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [schedule, setSchedule] = useState("");
  // Kept as a string so the field can be emptied — "" means unlimited.
  const [limit, setLimit] = useState("");
  /** "" means fall back to the app default. */
  const [model, setModel] = useState("");
  const [availableModels, setAvailableModels] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Settings owns the list, so a new model appears here without a change.
  useEffect(() => {
    getSettings()
      .then((settings) => setAvailableModels(settings.availableModels))
      .catch(() => setAvailableModels([]));
  }, []);

  const parsedLimit = limit.trim() === "" ? null : Number(limit);
  const limitValid =
    parsedLimit === null || (Number.isInteger(parsedLimit) && parsedLimit > 0);
  const ready = prompt.trim() !== "" && schedule.trim() !== "" && limitValid;

  // The cron is validated server-side against the same parser BullMQ uses, so
  // a malformed one comes back as a 400 rather than a task that never fires.
  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      onCreated(
        await createTask({
          prompt: prompt.trim(),
          schedule: schedule.trim(),
          limit: parsedLimit,
          model: model || null,
        })
      );
    } catch (err) {
      setError((err as Error)?.message ?? "Could not create the task");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="task-detail">
      <div className="task-detail-head">
        <div>
          <h2 className="task-title open">New task</h2>
          <div className="task-facts">
            <span>Runs on a schedule, with no conversation behind it</span>
          </div>
        </div>
      </div>

      <form
        className="task-edit"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !saving) void submit();
        }}
      >
        <div className="field">
          <label className="field-label" htmlFor="new-task-prompt">Prompt</label>
          <span className="field-hint">
            A scheduled run has no conversation behind it, so this has to stand alone.
          </span>
          <textarea
            id="new-task-prompt"
            rows={8}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Check my inbox for replies from recruiters and summarise them."
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="new-task-schedule">Schedule</label>
          <span className="field-hint">
            Cron, in the server's timezone — <code>35 2 * * *</code> is 02:35 daily.
            For a one-off, give the moment it should run and set the limit to 1.
          </span>
          <input
            id="new-task-schedule"
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
            placeholder="0 9 * * 1"
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="new-task-limit">Run limit</label>
          <span className="field-hint">Leave empty to run forever.</span>
          <input
            id="new-task-limit"
            type="number"
            min={1}
            step={1}
            value={limit}
            placeholder="unlimited"
            onChange={(e) => setLimit(e.target.value)}
          />
          {!limitValid && (
            <span className="field-error">Must be a whole number above zero.</span>
          )}
        </div>

        <div className="field">
          <label className="field-label" htmlFor="new-task-model">Model</label>
          <span className="field-hint">
            Runs of this task use it. Leave on the default to follow Settings —
            a cheaper model is often enough for work that mostly reads and clicks.
          </span>
          <select
            id="new-task-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="">App default</option>
            {availableModels.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>

        {error && <div className="error">{error}</div>}

        <div className="task-edit-actions">
          <button className="btn new" type="submit" disabled={!ready || saving}>
            {saving ? "Creating…" : "Create task"}
          </button>
          <button className="btn" type="button" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
