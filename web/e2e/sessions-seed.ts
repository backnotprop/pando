// Recorded agent sessions for the web's e2e and shots: the sessions recorded for the Worker's tests
// (worker/test/sessions/fixtures: Pi 0.85.1 and OpenCode V2 2.0.22, placeholder prompts in scratch folders), each
// appended through a machine's credential as `pando sync` sends them, with its agent's own id changed and its times
// moved so it reads as recorded when the story needs it. Commits that name them are pushed through the git door.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { BASE, type JsonValue } from "./seed";

const FIXTURES = new URL("../../worker/test/sessions/fixtures/", import.meta.url);

export type Fixture = "pi" | "opencode";

/** A session's id, as the Worker, the hook and `pando sync` derive it. */
export function sessionId(program: string, agentId: string): string {
  let n = BigInt(`0x${createHash("sha256").update(`${program}:${agentId}`).digest("hex").slice(0, 32)}`);
  let out = "";

  for (let i = 0; i < 26; i++) {
    out = `${"0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Number(n & 31n)]}${out}`;
    n >>= 5n;
  }

  return `s_${out}`;
}

/** Every recorded time in a line moved by `ms`. */
function shift(line: string, ms: number): string {
  const keys = new Set(["timestamp", "time_created", "created", "completed", "streamed", "ran", "start", "end"]);

  return JSON.stringify(
    JSON.parse(line, (k: string, v: JsonValue) => {
      if (!keys.has(k)) return v;

      if (Number.isSafeInteger(v) && Number(v) > 1e11) return Number(v) + ms;

      return /^\d{4}-\d\d-\d\dT/.test(String(v)) ? new Date(Date.parse(String(v)) + ms).toISOString() : v;
    }),
  );
}

function timeOf(line: string): number {
  const v = JSON.parse(line);
  const t = Date.parse(String(v.timestamp ?? ""));

  return Number.isNaN(t) ? Number(v.time_created ?? 0) : t;
}

export interface Recorded {
  id: string;
  /** The agent's own session id, for a commit's Pando-Session line. */
  agentId: string;
}

/**
 * One session from a fixture, its last record `endsAgoMs` before now, appended in one piece by the machine whose
 * credential is `secret`. `folder` null: the repository folder.
 */
export async function recordSession(secret: string, full: string, fx: Fixture, agentId: string, where: { repo: string | null; branch: string | null }, endsAgoMs: number): Promise<Recorded> {
  const lines = readFileSync(new URL(`${fx}.jsonl`, FIXTURES), "utf8").split("\n").filter(Boolean);
  const by = Date.now() - endsAgoMs - Math.max(...lines.map(timeOf));

  const moved = lines.map((l, i) => {
    const o = JSON.parse(shift(l, by));

    if (i === 0) o.id = agentId;

    return JSON.stringify(o);
  });

  const program = fx;
  const id = sessionId(program, agentId);
  const body = `${moved.join("\n")}\n`;
  const next = fx === "opencode" ? Math.max(...moved.map((l) => Number(JSON.parse(l).seq ?? 0))) : Buffer.byteLength(body);

  const res = await fetch(`${BASE}/v1/monorepos/${full}/sessions/${id}/pieces?at=0&next=${next}`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/x-ndjson", "pando-session": JSON.stringify({ program, agent_id: agentId, repo: where.repo, branch: where.branch, parent: null }) },
    body,
  });

  if (!res.ok && res.status !== 409) throw new Error(`recording ${fx} ${agentId}: ${res.status} ${await res.text()}`);

  return { id, agentId };
}

/** A commit message whose trailer names a session, as the commit hook writes it. */
export const naming = (title: string, ...sessions: string[]) => `${title}\n\n${sessions.map((s) => `Pando-Session: ${s}`).join("\n")}\n`;
