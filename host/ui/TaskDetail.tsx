import { useState } from "react";
import { Link } from "react-router";
import { Transcript } from "./Transcript";
import type { TaskRun, TaskWithRuns } from "./api";
import { useArmedAction } from "./useArmedAction";

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
}: {
  task: TaskWithRuns;
  onDelete: () => void;
  deleting: boolean;
}) {
  // Keyed on the task id so an armed button can't carry to another record.
  const { armed: confirming, trigger: arm } = useArmedAction(onDelete, task.id);
  // Prompts are instructions, not titles; clamp so the rest stays above the fold.
  const [promptOpen, setPromptOpen] = useState(false);

  const succeeded = task.runs.filter((r) => r.status === "success").length;
  const failed = task.runs.filter((r) => r.status === "failed").length;

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
          </div>
        </div>
        <button
          className={`btn danger ${confirming ? "confirming" : ""}`}
          onClick={arm}
          disabled={deleting}
        >
          {deleting ? "Deleting…" : confirming ? "Confirm delete" : "Delete"}
        </button>
      </div>

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
