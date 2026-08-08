import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Two-step confirm: the first call arms, the second commits. Disarms itself so
 * a hot button isn't left for a later, unrelated click.
 *
 * @param resetKey - Disarms when it changes. Pass the id of whatever the button
 * acts on, so an armed button can't carry onto a different record.
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

  // A deleted row unmounts the moment the action succeeds.
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
