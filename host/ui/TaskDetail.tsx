import { useState } from "react";
import { Link } from "react-router";
import type { TaskRun, TaskWithRuns } from "./api";
import { useArmedAction } from "./useArmedAction";

/** Full timestamp — a run's history is exactly where the date matters. */
function formatStamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

/**
 * How long a run took. TaskRun maps `updatedAt` to `endedAt`, so the two stamps
 * are equal until the run actually finishes and writes its status — treat that
 * case as "still going" rather than reporting a 0s duration.
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
      {open && run.transcript && <pre className="run-transcript">{run.transcript}</pre>}
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
  // A second click is required to delete. Keyed on the task id so an armed
  // button can never carry over onto a different record.
  const { armed: confirming, trigger: arm } = useArmedAction(onDelete, task.id);
  // Prompts are instructions, not titles — real ones run to several paragraphs.
  // Clamp by default so the schedule, metadata and runs stay above the fold.
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
            // A real link, so it opens in a new tab / can be copied like any
            // other. The thread may since have been deleted — that route shows
            // its own "could not load" rather than failing here.
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
