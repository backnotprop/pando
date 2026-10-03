// The write gate: at most WRITE_SLOTS writes at once per Artifacts repo.
//
// An Artifacts repo accepts about two receive-packs at once; the rest are
// refused with `ERR artifacts_git_receive_pack_busy` (measured 2026-10-03).
// Every write to a repo (a push through the door, a branch create or delete,
// a merge, a meta layer commit) takes a slot here first, in first-come order.
// A slot is a lease: it ends when released, or LEASE_MS after it was taken or
// last renewed, so a Worker that dies cannot keep it. A writer that has waited
// WAIT_MS gives up with a "busy" answer.

/** Slots per Artifacts repo. */
export const WRITE_SLOTS = 2;
/** A lease lasts this long unless renewed; holders renew every LEASE_MS / 3. */
export const LEASE_MS = 60_000;
/** The longest a writer waits in the queue. */
export const WAIT_MS = 120_000;

export class GateBusy extends Error {
  constructor(key: string, waitedMs: number) {
    super(`${key} has had ${WRITE_SLOTS} writes running for ${Math.round(waitedMs / 1000)} s; try again`);
    this.name = "GateBusy";
  }
}

interface Waiter {
  resolve: (lease: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  since: number;
}

interface Gate {
  held: Map<string, ReturnType<typeof setTimeout>>;
  waiters: Waiter[];
}

export class WriteGate {
  private gates = new Map<string, Gate>();

  constructor(
    private slots = WRITE_SLOTS,
    private leaseMs = LEASE_MS,
    private waitMs = WAIT_MS,
  ) {}

  private gate(key: string): Gate {
    let g = this.gates.get(key);
    if (!g) this.gates.set(key, (g = { held: new Map(), waiters: [] }));
    return g;
  }

  /** Wait for a slot; resolves with the lease id. */
  acquire(key: string): Promise<string> {
    const g = this.gate(key);
    if (g.held.size < this.slots && g.waiters.length === 0) return Promise.resolve(this.grant(key, g));
    return new Promise<string>((resolve, reject) => {
      const since = Date.now();
      const w: Waiter = {
        resolve,
        reject,
        since,
        timer: setTimeout(() => {
          const i = g.waiters.indexOf(w);
          if (i >= 0) g.waiters.splice(i, 1);
          reject(new GateBusy(key, Date.now() - since));
        }, this.waitMs),
      };
      g.waiters.push(w);
    });
  }

  /** Extend a lease. False if it already ended. */
  renew(key: string, lease: string): boolean {
    const g = this.gates.get(key);
    const t = g?.held.get(lease);
    if (!g || !t) return false;
    clearTimeout(t);
    g.held.set(lease, setTimeout(() => this.release(key, lease), this.leaseMs));
    return true;
  }

  /** End a lease and let the next writer in. False if it already ended. */
  release(key: string, lease: string): boolean {
    const g = this.gates.get(key);
    const t = g?.held.get(lease);
    if (!g || !t) return false;
    clearTimeout(t);
    g.held.delete(lease);
    while (g.held.size < this.slots && g.waiters.length) {
      const w = g.waiters.shift()!;
      clearTimeout(w.timer);
      w.resolve(this.grant(key, g));
    }
    if (g.held.size === 0 && g.waiters.length === 0) this.gates.delete(key);
    return true;
  }

  /** Run fn while holding a slot (renewed as it runs), then release it. */
  async with<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lease = await this.acquire(key);
    const renew = setInterval(() => this.renew(key, lease), Math.max(1000, Math.floor(this.leaseMs / 3)));
    try {
      return await fn();
    } finally {
      clearInterval(renew);
      this.release(key, lease);
    }
  }

  stats(key: string): { held: number; waiting: number } {
    const g = this.gates.get(key);
    return { held: g?.held.size ?? 0, waiting: g?.waiters.length ?? 0 };
  }

  /** Drop every lease and waiter (the monorepo was deleted). */
  clear(): void {
    for (const [key, g] of this.gates) {
      for (const t of g.held.values()) clearTimeout(t);
      for (const w of g.waiters) {
        clearTimeout(w.timer);
        w.reject(new GateBusy(key, Date.now() - w.since));
      }
    }
    this.gates.clear();
  }

  private grant(key: string, g: Gate): string {
    const lease = crypto.randomUUID();
    g.held.set(lease, setTimeout(() => this.release(key, lease), this.leaseMs));
    return lease;
  }
}

/** Artifacts' answer when a repo has too many receive-packs running. */
export function isBusy(text: string): boolean {
  return /artifacts_git_receive_pack_busy/.test(text);
}

/** Run fn; when Artifacts says busy, try again up to `retries` times with jitter. */
export async function retryBusy<T>(fn: () => Promise<T>, busy: (err: unknown) => boolean, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !busy(err)) throw err;
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1) + Math.floor(Math.random() * 400)));
    }
  }
}
