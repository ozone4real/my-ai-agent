import { useEffect, useRef } from "react";
import type { Page } from "./api";

export const emptyPage = <T,>(): Page<T> => ({ items: [], nextCursor: null });

/** Add the next page to the end, skipping rows already shown. */
export function appendPage<T extends { id: string }>(current: Page<T>, next: Page<T>): Page<T> {
  const shown = new Set(current.items.map((item) => item.id));
  return {
    items: [...current.items, ...next.items.filter((item) => !shown.has(item.id))],
    nextCursor: next.nextCursor,
  };
}

/**
 * Fold a freshly fetched first page into a list that may have more pages
 * loaded, so a refresh picks up new rows without collapsing the list back to
 * one page and losing the reader's place.
 *
 * The fresh rows replace their stale copies and go on top; everything else
 * already loaded stays below. The existing cursor is kept, since the loaded
 * rows still run contiguously down to it.
 */
export function mergeFirstPage<T extends { id: string }>(
  current: Page<T>,
  fresh: Page<T>
): Page<T> {
  if (current.items.length === 0) return fresh;
  const fetched = new Set(fresh.items.map((item) => item.id));
  return {
    items: [...fresh.items, ...current.items.filter((item) => !fetched.has(item.id))],
    nextCursor: current.nextCursor,
  };
}

/**
 * Loads the next page when scrolled into view. Render only when there is one.
 *
 * Re-armed whenever the list grows, so a page too short to scroll still pulls
 * in the next. A failed load doesn't grow it, so it isn't retried in a loop.
 */
export function InfiniteScroll({
  loading,
  itemCount,
  onLoad,
}: {
  loading: boolean;
  itemCount: number;
  onLoad: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef({ loading, onLoad });
  latest.current = { loading, onLoad };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !latest.current.loading) {
        latest.current.onLoad();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [itemCount]);

  return (
    <div ref={ref} className="scroll-sentinel">
      {loading && "Loading…"}
    </div>
  );
}
