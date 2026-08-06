import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Two-step confirmation for a destructive action: the first call arms it, the
 * second commits.
 *
 * Preferred over `window.confirm()` — that blocks the whole page and reads as a
 * browser error — and over a modal, which is a lot of machinery for "are you
 * sure". The armed state disarms itself so a hot button is never left lying
 * around for a later, unrelated click.
 *
 * @param onConfirm - Runs on the second call.
 * @param resetKey - Disarms whenever this changes. Pass the id of whatever the
 * button acts on, so an armed button can't carry over onto a different record.
 * @param timeoutMs - How long the armed state survives.
 */
export function useArmedAction(
  onConfirm: () => void,
  resetKey?: string,
  timeoutMs = 4000
) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => {
    setArmed(false);
    clear();
  }, [resetKey, clear]);

  // Don't leave a timer running against an unmounted component — a deleted row
  // unmounts the moment the action succeeds.
  useEffect(() => clear, [clear]);

  const trigger = useCallback(() => {
    if (!armed) {
      setArmed(true);
      clear();
      timer.current = window.setTimeout(() => setArmed(false), timeoutMs);
      return;
    }
    clear();
    setArmed(false);
    onConfirm();
  }, [armed, clear, onConfirm, timeoutMs]);

  return { armed, trigger };
}
