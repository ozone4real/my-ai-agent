import { useCallback, useEffect, useRef, useState } from "react";
import { getSettings, resetSettings, updateSettings, type Settings } from "./api";
import { useArmedAction } from "./useArmedAction";

/** A model id rendered for humans: "claude-sonnet-4-8" -> "Claude Sonnet 4 8". */
function modelLabel(id: string): string {
  return id
    .split("-")
    .map((part) => (part.length > 2 ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

export function SettingsPane() {
  const [settings, setSettings] = useState<Settings | null>(null);
  /** The editable copy. Kept separate so Reset can restore without a refetch. */
  const [draft, setDraft] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const savedTimer = useRef<number | null>(null);

  const adopt = useCallback((next: Settings) => {
    setSettings(next);
    setDraft(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await getSettings();
        if (!cancelled) adopt(loaded);
      } catch (err) {
        if (!cancelled) setError((err as Error)?.message ?? "Could not load settings");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (savedTimer.current) window.clearTimeout(savedTimer.current);
    };
  }, [adopt]);

  // Only send what actually changed, so a PATCH can't clobber a field edited
  // elsewhere between load and save.
  const changes = (() => {
    if (!settings || !draft) return {};
    const out: Record<string, string> = {};
    for (const key of ["fullName", "preferredName", "instructions", "defaultModel"] as const) {
      if (draft[key] !== settings[key]) out[key] = draft[key];
    }
    return out;
  })();
  const dirty = Object.keys(changes).length > 0;

  const save = useCallback(async () => {
    if (!dirty) return;
    setSaving(true);
    setError(null);
    try {
      adopt(await updateSettings(changes));
      setSavedAt(Date.now());
      if (savedTimer.current) window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setSavedAt(null), 2500);
    } catch (err) {
      setError((err as Error)?.message ?? "Could not save settings");
    } finally {
      setSaving(false);
    }
  }, [adopt, changes, dirty]);

  const doReset = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      adopt(await resetSettings());
    } catch (err) {
      setError((err as Error)?.message ?? "Could not reset settings");
    } finally {
      setSaving(false);
    }
  }, [adopt]);

  const { armed, trigger } = useArmedAction(() => void doReset());

  if (loading) return <div className="empty">Loading settings…</div>;
  if (!draft) {
    return <div className="empty">{error ?? "Settings unavailable."}</div>;
  }

  const set = (key: keyof Settings) => (value: string) =>
    setDraft({ ...draft, [key]: value });

  return (
    <div className="settings">
      <p className="settings-intro">
        Applied to every agent run — a new chat, and any scheduled task.
      </p>

      <label className="field">
        <span className="field-label">Full name</span>
        <input
          type="text"
          value={draft.fullName}
          placeholder="Ezenwa Ogbonna"
          onChange={(e) => set("fullName")(e.target.value)}
        />
      </label>

      <label className="field">
        <span className="field-label">Name the assistant should use</span>
        <input
          type="text"
          value={draft.preferredName}
          placeholder="Ezenwa"
          onChange={(e) => set("preferredName")(e.target.value)}
        />
        <span className="field-hint">Leave blank and it won't address you by name.</span>
      </label>

      <label className="field">
        <span className="field-label">Instructions for the assistant</span>
        <textarea
          rows={8}
          value={draft.instructions}
          placeholder="Answer concisely. Prefer British spelling. Ask before sending email."
          onChange={(e) => set("instructions")(e.target.value)}
        />
        <span className="field-hint">
          Added to the system message on every run, so it costs tokens per turn —
          {" "}
          {draft.instructions.length}/4000 characters.
        </span>
      </label>

      <label className="field">
        <span className="field-label">Default model</span>
        <select
          value={draft.defaultModel}
          onChange={(e) => set("defaultModel")(e.target.value)}
        >
          {draft.availableModels.map((id) => (
            <option key={id} value={id}>
              {modelLabel(id)}
            </option>
          ))}
        </select>
      </label>

      {error && <div className="error">{error}</div>}

      <div className="settings-actions">
        <button className="btn send" onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </button>
        <button className={`btn danger ${armed ? "confirming" : ""}`} onClick={trigger} disabled={saving}>
          {armed ? "Confirm reset" : "Reset to defaults"}
        </button>
        {savedAt && <span className="settings-saved">Saved</span>}
        {armed && <span className="settings-warning">This clears every field.</span>}
      </div>
    </div>
  );
}
