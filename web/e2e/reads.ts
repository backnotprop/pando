// A reporter that ends the run with its slowest server read, from the
// Worker's own timing lines (worker/src/timing.ts: one "pando.timing" line per
// request, which wrangler dev prints on stdout and playwright.config.ts keeps
// in e2e/.state/worker.log). A step that timed out then says whether the
// server was slow in that run.
import { existsSync, readFileSync } from "node:fs";
import type { Reporter } from "@playwright/test/reporter";

const LOG = new URL("./.state/worker.log", import.meta.url);

/** A slow read: one second or more. */
const SLOW_MS = 1000;

/** One read: what was asked, how long it took, and where the time went (worker/src/timing.ts). */
interface Read {
  what: string;
  ms: number;
  artifacts: number;
  objects: number;
  worker: number;
}

/** Terminal colours, as wrangler dev writes them even to a file. */
const COLOURS = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** The GETs among the log's timing lines (wrangler prints each as an object literal, over one or more lines). */
function reads(text: string): Read[] {
  const found: Read[] = [];

  for (const entry of text.replace(COLOURS, "").split("msg: 'pando.timing'").slice(1)) {
    const field = (name: string) => new RegExp(`\\b${name}: '([^']*)'`).exec(entry)?.[1];
    const number = (name: string) => Number(new RegExp(`\\b${name}: (\\d+)`).exec(entry)?.[1] ?? NaN);
    const ms = number("total_ms");

    if (field("method") !== "GET" || Number.isNaN(ms)) continue;
    found.push({ what: `GET ${field("path") ?? field("route") ?? "?"}`, ms, artifacts: number("artifacts_ms") || 0, objects: number("objects_ms") || 0, worker: number("worker_ms") || 0 });
  }

  return found;
}

export default class SlowestRead implements Reporter {
  onEnd() {
    if (!existsSync(LOG)) return;
    const all = reads(readFileSync(LOG, "utf8"));

    if (!all.length) {
      console.log("Server reads: the Worker logged no timing lines.");

      return;
    }

    const slowest = all.reduce((a, r) => (r.ms > a.ms ? r : a));
    const slow = all.filter((r) => r.ms >= SLOW_MS).length;

    const where = `Artifacts ${slowest.artifacts} ms, objects ${slowest.objects} ms, the Worker itself ${slowest.worker} ms`;

    console.log(`Slowest server read: ${slowest.what} took ${slowest.ms} ms (${where}); ${slow} of ${all.length} reads took 1 s or more.`);
  }
}
