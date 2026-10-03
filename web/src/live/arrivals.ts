// Lines the live socket just brought in, so each plays its arrival once
// (the prototype's one motion) and lines loaded with the page never do.
const arrived = new Set<string>();

export const lineKey = (e: { monorepo_id: string; seq: number }) => `${e.monorepo_id}:${e.seq}`;

export function markArrived(key: string): void {
  arrived.add(key);
  setTimeout(() => arrived.delete(key), 10_000);
}

/** True once, for a line that arrived live. */
export function takeArrived(key: string): boolean {
  return arrived.delete(key);
}
