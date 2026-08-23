import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Transcript } from "./Transcript";
import type { TaskRun, TaskUpdate, TaskWithRuns } from "./api";
import { useArmedAction } from "./useArmedAction";
import { getSettings, runTaskNow } from "./api";

/** Full timestamp — a run's history is exactly where the date matters. */
function formatStamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

/**
 * How long a run took. `endedAt` is `updatedAt`, so it equals `startedAt` until
 * the run finishes — report nothing rather than a 0s duration.
 */
function formatDuration(run: TaskRun): string | null {
  if (run.status === "in_progress") return null;
  const ms = new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function Run({ run }: { run: TaskRun }) {
  const [open, setOpen] = useState(false);
  const duration = formatDuration(run);

  return (
    <li className="run">
      <div className="run-head">
        <span className={`pill ${run.status}`}>{run.status.replace("_", " ")}</span>
        <span className="run-when">{formatStamp(run.startedAt)}</span>
        {duration && <span className="run-duration">{duration}</span>}
        {run.transcript && (
          <button className="run-toggle" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide transcript" : "Transcript"}
          </button>
        )}
      </div>
      {open && run.transcript && <Transcript raw={run.transcript} />}
    </li>
  );
}

export function TaskDetail({
  task,
  onDelete,
  deleting,
  onSave,
  saving,
  saveError,
  onQueued,
}: {
  task: TaskWithRuns;
  onDelete: () => void;
  deleting: boolean;
  onSave: (update: TaskUpdate) => void;
  saving: boolean;
  saveError: string | null;
  /** Lets the parent refetch, so the queued run shows up in the list. */
  onQueued?: () => void;
}) {
  // Keyed on the task id so an armed button can't carry to another record.
  const { armed: confirming, trigger: arm } = useArmedAction(onDelete, task.id);
  // Prompts are instructions, not titles; clamp so the rest stays above the fold.
  const [promptOpen, setPromptOpen] = useState(false);

  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(task.prompt);
  const [schedule, setSchedule] = useState(task.schedule);
  // Kept as a string so the field can be emptied — "" means unlimited.
  const [limit, setLimit] = useState(task.limit === null ? "" : String(task.limit));
  /** "" means fall back to the app default. */
  const [model, setModel] = useState(task.model ?? "");
  const [availableModels, setAvailableModels] = useState<string[]>([]);

  // Re-seed when a different task is shown, or after a save changes the values.
  useEffect(() => {
    setPrompt(task.prompt);
    setSchedule(task.schedule);
    setLimit(task.limit === null ? "" : String(task.limit));
    setModel(task.model ?? "");
  }, [task.id, task.prompt, task.schedule, task.limit, task.model]);

  // Settings owns the list, so a new model appears here without a change.
  useEffect(() => {
    getSettings()
      .then((settings) => setAvailableModels(settings.availableModels))
      .catch(() => setAvailableModels([]));
  }, []);

  const parsedLimit = limit.trim() === "" ? null : Number(limit);
  const limitValid =
    parsedLimit === null || (Number.isInteger(parsedLimit) && parsedLimit > 0);

  // Send only what changed: the endpoint reads an absent field as "leave alone",
  // so this can't clobber a value edited elsewhere in the meantime.
  const changes: TaskUpdate = {};
  if (prompt !== task.prompt) changes.prompt = prompt;
  if (schedule !== task.schedule) changes.schedule = schedule;
  if (parsedLimit !== task.limit) changes.limit = parsedLimit;
  // "" clears the override; the endpoint reads null as "use the app default".
  if ((model || null) !== task.model) changes.model = model || null;
  const dirty = Object.keys(changes).length > 0;

  const cancel = () => {
    setPrompt(task.prompt);
    setSchedule(task.schedule);
    setLimit(task.limit === null ? "" : String(task.limit));
    setModel(task.model ?? "");
    setEditing(false);
  };

  const succeeded = task.runs.filter((r) => r.status === "success").length;
  const failed = task.runs.filter((r) => r.status === "failed").length;
  const runInProgress = task.runs.some((r) => r.status === "in_progress");

  const [running, setRunning] = useState(false);
  const [runNotice, setRunNotice] = useState<{ ok: boolean; text: string } | null>(null);

  // Queued, not finished: the worker picks it up out of band, so the new run
  // only appears once the list is refetched.
  const runNow = async () => {
    setRunning(true);
    setRunNotice(null);
    try {
      await runTaskNow(task.id);
      setRunNotice({ ok: true, text: "Run queued. It will appear below once it starts." });
      onQueued?.();
    } catch (err) {
      setRunNotice({ ok: false, text: (err as Error)?.message ?? "Could not queue the run" });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="task-detail">
      <div className="task-detail-head">
        <div>
          <h2 className={`task-title ${promptOpen ? "open" : ""}`}>{task.prompt}</h2>
          {task.prompt.length > 180 && (
            <button className="prompt-toggle" onClick={() => setPromptOpen((v) => !v)}>
              {promptOpen ? "Show less" : "Show full prompt"}
            </button>
          )}
          <div className="task-facts">
            <code>{task.schedule}</code>
            <span>·</span>
            <span>{task.limit === null ? "unlimited runs" : `max ${task.limit} runs`}</span>
            <span>·</span>
            <span>created by {task.creator}</span>
            {task.model && (
              <>
                <span>·</span>
                <code>{task.model}</code>
              </>
            )}
          </div>
        </div>
        <div className="task-actions">
          {!editing && (
            <button
              className="btn"
              onClick={runNow}
              disabled={deleting || running || runInProgress}
              title={
                runInProgress
                  ? "A run is already in progress"
                  : "Queue a run now, outside the schedule"
              }
            >
              {running ? "Queueing…" : "Run now"}
            </button>
          )}
          {!editing && (
            <button className="btn" onClick={() => setEditing(true)} disabled={deleting}>
              Edit
            </button>
          )}
          <button
            className={`btn danger ${confirming ? "confirming" : ""}`}
            onClick={arm}
            disabled={deleting}
          >
            {deleting ? "Deleting…" : confirming ? "Confirm delete" : "Delete"}
          </button>
        </div>
      </div>

      {editing && (
        <form
          className="task-edit"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty && limitValid) onSave(changes);
          }}
        >
          <div className="field">
            <label className="field-label" htmlFor="task-prompt">Prompt</label>
            <span className="field-hint">
              A scheduled run has no conversation behind it, so this has to stand alone.
            </span>
            <textarea
              id="task-prompt"
              rows={8}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="task-schedule">Schedule</label>
            <span className="field-hint">
              Cron, in the server's timezone — <code>35 2 * * *</code> is 02:35 daily.
            </span>
            <input
              id="task-schedule"
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="task-limit">Run limit</label>
            <span className="field-hint">Leave empty to run forever.</span>
            <input
              id="task-limit"
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
            <label className="field-label" htmlFor="task-model">Model</label>
            <span className="field-hint">
              Runs of this task use it. Leave on the default to follow Settings —
              a cheaper model is often enough for work that mostly reads and clicks.
            </span>
            <select id="task-model" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">App default</option>
              {availableModels.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </div>

          {saveError && <div className="error">{saveError}</div>}

          <div className="task-edit-actions">
            <button className="btn new" type="submit" disabled={!dirty || !limitValid || saving}>
              {saving ? "Saving…" : "Save changes"}
            </button>
            <button className="btn" type="button" onClick={cancel} disabled={saving}>
              Cancel
            </button>
            {/* The cron only takes effect once the save reaches Redis. */}
            {dirty && !saving && <span className="field-hint">Unsaved changes</span>}
          </div>
        </form>
      )}

      {confirming && !deleting && (
        <p className="task-warning">
          This deletes the task and all {task.runs.length} of its runs.
        </p>
      )}

      <div className="task-meta-grid">
        <div>
          <span className="label">Created</span>
          {formatStamp(task.createdAt)}
        </div>
        <div>
          <span className="label">Updated</span>
          {formatStamp(task.updatedAt)}
        </div>
        <div>
          <span className="label">From conversation</span>
          {task.sourceConversation ? (
            // A real link so it can be opened in a tab or copied.
            <Link className="convo-link" to={`/conversations/${task.sourceConversation}`}>
              <code>{task.sourceConversation.slice(-6)}</code>
              <span aria-hidden="true"> ↗</span>
            </Link>
          ) : (
            "—"
          )}
        </div>
      </div>

      {runNotice && (
        <div className={runNotice.ok ? "run-notice" : "error"}>{runNotice.text}</div>
      )}

      <div className="runs">
        <h3>
          Runs <span className="muted">({task.runs.length})</span>
          {task.runs.length > 0 && (
            <span className="muted">
              {" "}
              — {succeeded} succeeded, {failed} failed
            </span>
          )}
        </h3>

        {task.runs.length === 0 ? (
          <div className="empty small">
            This task hasn't run yet. Runs appear here once the job executes it.
          </div>
        ) : (
          <ul className="run-list">
            {task.runs.map((run) => (
              <Run key={run.id} run={run} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
