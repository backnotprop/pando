// A page's folder, kept on screen while its newer version is read: when a ref
// moves (a merge to main, a push to the branch on screen), the folder's tree
// names a new commit, and everything read at that commit (the file, the
// README) has a new query key. Shown at once, the page would suspend and React
// would hide it until the reads land. Deferred, React keeps the page as it
// was and swaps in the new one when it is ready.
import { useDeferredValue, useMemo, useState } from "react";

/**
 * `value` for `key`, held back (useDeferredValue) while what it leads to is
 * read. Another key (another folder or ref, a navigation) shows at once, so a
 * page never draws one folder's data under another's address.
 */
export function useHeld<T>(key: string, value: T): T {
  const now = useMemo(() => ({ key, value }), [key, value]);
  const shown = useDeferredValue(now);

  return shown.key === key ? shown.value : value;
}

/**
 * The newest answer seen for `key`: while a moved ref's new one is read
 * (`value` undefined), the last one stays, so what it draws (a last-commit
 * bar) does not drop out and come back. Another key starts empty.
 */
export function useLastAnswer<T>(key: string, value: T | undefined): T | undefined {
  const [kept, setKept] = useState<{ key: string; value: T } | null>(null);

  // React's pattern for state that follows a prop: set during render, drawn again at once.
  if (value !== undefined && (kept?.key !== key || kept.value !== value)) setKept({ key, value });

  return value ?? (kept?.key === key ? kept.value : undefined);
}
