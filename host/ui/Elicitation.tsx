import { useState } from "react";
import type { ElicitationAnswer, ElicitationRequest } from "./api";

/**
 * A question the agent asked mid-run, rendered as a form.
 *
 * The turn is blocked while this is on screen: the tool call that asked is
 * still open, waiting. Every path out of here has to answer — submit, decline,
 * or the server's timeout — or the run sits until the timeout fires.
 *
 * Fields come from the JSON Schema the tool supplied, so this handles whatever
 * a tool asks for without a matching change here.
 */
export function Elicitation({
  request,
  onAnswer,
  answering,
}: {
  request: ElicitationRequest;
  onAnswer: (answer: ElicitationAnswer) => void;
  answering: boolean;
}) {
  const properties = request.requestedSchema?.properties ?? {};
  const required = new Set(request.requestedSchema?.required ?? []);
  const fields = Object.entries(properties);

  const [values, setValues] = useState<Record<string, string>>({});

  const missing = fields
    .filter(([name]) => required.has(name) && !(values[name] ?? "").trim())
    .map(([name]) => name);

  // A URL question isn't answered here — the user acts elsewhere and then says
  // whether it worked.
  if (request.mode === "url" && request.url) {
    return (
      <div className="elicitation">
        <p className="elicitation-message">{request.message}</p>
        <a className="btn new" href={request.url} target="_blank" rel="noopener noreferrer">
          Open link
        </a>
        <div className="elicitation-actions">
          <button
            className="btn new"
            disabled={answering}
            onClick={() => onAnswer({ action: "accept", content: {} })}
          >
            {answering ? "Sending…" : "Done"}
          </button>
          <button className="btn" disabled={answering} onClick={() => onAnswer({ action: "decline" })}>
            Skip
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="elicitation"
      onSubmit={(e) => {
        e.preventDefault();
        if (missing.length || answering) return;
        onAnswer({ action: "accept", content: values });
      }}
    >
      <p className="elicitation-message">{request.message}</p>

      {fields.map(([name, schema]) => (
        <div className="field" key={name}>
          <label className="field-label" htmlFor={`elicit-${request.id}-${name}`}>
            {schema.description || name}
            {required.has(name) && <span aria-hidden="true"> *</span>}
          </label>
          {schema.enum ? (
            <select
              id={`elicit-${request.id}-${name}`}
              value={values[name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
            >
              <option value="">Choose…</option>
              {schema.enum.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : (
            <textarea
              id={`elicit-${request.id}-${name}`}
              rows={2}
              value={values[name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
            />
          )}
        </div>
      ))}

      {/* No fields in the schema — a yes/no question, so submitting is enough. */}
      {fields.length === 0 && (
        <p className="field-hint">Confirm to let the agent continue.</p>
      )}

      <div className="elicitation-actions">
        <button className="btn new" type="submit" disabled={answering || missing.length > 0}>
          {answering ? "Sending…" : "Send answer"}
        </button>
        <button
          className="btn"
          type="button"
          disabled={answering}
          onClick={() => onAnswer({ action: "decline" })}
        >
          I don't know
        </button>
      </div>
    </form>
  );
}
