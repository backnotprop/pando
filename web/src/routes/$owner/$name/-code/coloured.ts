// The coloured code view and the diff (Colour.tsx, Diff.tsx), loaded once the
// signed-in app is idle after its first paint (routes/__root.tsx), with the
// colour worker and its highlighter started and ready, and warmed on a few
// lines in each common language (ui/syntax.ts): the first file a person opens
// is not left plain while they start. A page that needs them sooner loads
// them itself. Until they are ready, or if their chunk cannot load (a deploy
// replaced it while the tab was open), code shows as plain lines. No
// Suspense: React holds a fallback at least 300 ms.
import { useEffect, useSyncExternalStore } from "react";
import type ColourView from "./Colour";
import type DiffView from "./Diff";

export interface ColourViews {
  Colour: typeof ColourView;
  Diff: typeof DiffView;
}

let views: ColourViews | null = null;

let loading: Promise<void> | null = null;

const waiting = new Set<() => void>();

/** Loads both views and readies the worker; again after a failure, never twice at once. */
export function loadColourViews(): Promise<void> {
  loading ??= Promise.all([import("./Colour"), import("./Diff"), import("../../../../ui/syntax")])
    .then(async ([colour, diff, syntax]) => {
      const pool = syntax.codePool();

      // Ready: Pierre draws at once, plain until the worker answers. A pool that fails falls back to the main thread.
      await pool.initialize().catch(() => {});
      views = { Colour: colour.default, Diff: diff.default };

      for (const done of waiting) done();

      // Then the worker colours a few lines in each common language, so the first real file in each is not left plain.
      await syntax.warmGrammars(pool).catch(() => {});
    })
    .catch(() => {
      loading = null;
    });

  return loading;
}

/** Loads them when the browser is idle (or after half a second where it has no idle callback). */
export function prewarmColourViews(): void {
  const load = () => void loadColourViews();

  if ("requestIdleCallback" in window) requestIdleCallback(load, { timeout: 2000 });
  else setTimeout(load, 500);
}

const subscribe = (done: () => void) => {
  waiting.add(done);

  return () => waiting.delete(done);
};

/** The views once ready, else null (and they start loading). */
export function useColourViews(): ColourViews | null {
  const ready = useSyncExternalStore(subscribe, () => views);

  useEffect(() => {
    if (!ready) void loadColourViews();
  }, [ready]);

  return ready;
}
