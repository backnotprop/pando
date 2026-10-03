// Talking to one Artifacts repo: reads through the Workers binding, writes
// through git's receive-pack. The token for the push is the caller's (`write`),
// or one minted for the one push and revoked after it.
import { concat, ZERO_SHA, type TreeEntry } from "./objects";
import { timeArtifacts } from "../timing";

export interface GitRepo {
  artifacts: Artifacts;
  name: string;
  /**
   * Optional: how to push without minting a token for each push. `token`
   * gives a write token for this one repo, held by the caller and never
   * sent outside the Worker (so it is not revoked here); `fresh` asks for a
   * new one after Artifacts refused it. `remote` saves the info() lookup.
   */
  write?: { remote?: string; token: (fresh: boolean) => Promise<string> };
}

export type GitWriteErrorCode =
  | "invalid_input"
  | "not_found"
  | "no_merge_base"
  | "too_large"
  | "push_failed"
  | "artifacts";

export class GitWriteError extends Error {
  constructor(
    readonly code: GitWriteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GitWriteError";
  }
}

export interface Stats {
  commitsRead: number;
  treesRead: number;
  objectsWritten: number;
  packBytes: number;
}

const SHA_RE = /^[0-9a-f]{40}$/;
export const isSha = (s: unknown): s is string => typeof s === "string" && SHA_RE.test(s);

// Turn an Artifacts binding error into a GitWriteError. The message never
// carries a token: none is ever passed to the binding calls wrapped here.
function wrap(what: string, e: unknown): GitWriteError {
  if (e instanceof GitWriteError) return e;
  const code = (e as { code?: string })?.code;
  const msg = (e as Error)?.message ?? String(e);
  if (code === "NOT_FOUND") return new GitWriteError("not_found", `${what}: ${msg}`);
  return new GitWriteError("artifacts", `${what}: ${code ?? "error"}: ${msg}`);
}

async function call<T>(what: string, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    throw wrap(what, e);
  }
}

export interface CommitInfo {
  hash: string;
  treeHash: string;
  parents: string[];
  committedAt: number;
}

const LOG_BATCH = 32;
const COMMIT_CACHE_MAX = 10_000;

// An open repo for the length of one gitwrite call.
export class OpenRepo {
  readonly stats: Stats = { commitsRead: 0, treesRead: 0, objectsWritten: 0, packBytes: 0 };
  private commits = new Map<string, CommitInfo>();

  private constructor(
    readonly name: string,
    private readonly handle: ArtifactsRepo,
    private readonly write?: GitRepo["write"],
  ) {}

  static async open(repo: GitRepo): Promise<OpenRepo> {
    if (!repo?.artifacts || typeof repo.name !== "string" || !repo.name) {
      throw new GitWriteError("invalid_input", "repo needs { artifacts, name }");
    }
    const handle = await call(`open repo ${repo.name}`, () => repo.artifacts.get(repo.name));
    return new OpenRepo(repo.name, handle, repo.write);
  }

  close(): void {
    // Symbol.dispose is not in the worker's TypeScript lib (ES2022), so look it up.
    const dispose = (Symbol as unknown as { dispose?: symbol }).dispose;
    try {
      if (dispose) (this.handle as unknown as Record<symbol, () => void>)[dispose]?.();
    } catch {
      // already released
    }
  }

  // The sha a branch points at, or null when the branch does not exist.
  // log() takes the short name ("main"), not "refs/heads/main", and a branch
  // wins over a tag of the same name (checked on Artifacts, 2026-10-02).
  async branchHead(branch: string): Promise<string | null> {
    const log = await call(`resolve ${branch}`, () => this.handle.log({ ref: branch, limit: 1 }));
    return log[0]?.hash ?? null;
  }

  // Commit metadata, cached. A miss reads a short run of first-parent history
  // in one call, since merge base walks mostly follow first parents.
  async commit(sha: string): Promise<CommitInfo> {
    const hit = this.commits.get(sha);
    if (hit) return hit;
    this.stats.commitsRead++;
    if (this.commits.size < COMMIT_CACHE_MAX) {
      const run = await call(`log ${sha}`, () => this.handle.log({ ref: sha, limit: LOG_BATCH }));
      for (const c of run) this.commits.set(c.hash, pick(c));
      const got = this.commits.get(sha);
      if (got) return got;
    }
    const c = await call(`read commit ${sha}`, () => this.handle.readCommit(sha));
    if (!c) throw new GitWriteError("not_found", `commit ${sha} not found in ${this.name}`);
    const info = pick(c);
    this.commits.set(sha, info);
    return info;
  }

  async tree(sha: string | null): Promise<TreeEntry[]> {
    if (sha === null) return [];
    this.stats.treesRead++;
    const t = await call(`read tree ${sha}`, () => this.handle.readTree(sha));
    if (!t) throw new GitWriteError("not_found", `tree ${sha} not found in ${this.name}`);
    return t.map((e) => ({ name: e.name, mode: e.mode, hash: e.hash }));
  }

  // Send one ref update and its pack to receive-pack. Returns null on
  // success or the server's reason for refusing the update.
  async push(ref: string, oldSha: string | null, newSha: string, pack: Uint8Array): Promise<string | null> {
    this.stats.packBytes = pack.length;
    const line = `${oldSha ?? ZERO_SHA} ${newSha} ${ref}\0report-status agent=pando-gitwrite\n`;
    const body = concat([pktLine(line), FLUSH, pack]);
    const send = async (remote: string, token: string): Promise<Response> => {
      try {
        // Timed for the caller's pando.timing line (worker/src/timing.ts), when there is one.
        return await timeArtifacts("http POST git-receive-pack (gitwrite)", this.name, () =>
          fetch(`${remote}/git-receive-pack`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/x-git-receive-pack-request",
              accept: "application/x-git-receive-pack-result",
            },
            body,
          }),
        );
      } catch (e) {
        throw new GitWriteError("artifacts", `receive-pack request failed: ${(e as Error).message}`);
      }
    };
    const report = async (res: Response): Promise<string | null> => {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!res.ok) throw new GitWriteError("artifacts", `receive-pack answered ${res.status}: ${preview(bytes)}`);
      return readReport(bytes, ref);
    };

    if (this.write) {
      // The caller's token for this repo: no mint, no revoke (it never leaves the Worker).
      const remote = this.write.remote ?? (await call("repo info", () => this.handle.info())).remote;
      let res = await send(remote, await call("caller's write token", () => this.write!.token(false)));
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel();
        res = await send(remote, await call("caller's write token", () => this.write!.token(true)));
      }
      return report(res);
    }

    const info = await call("repo info", () => this.handle.info());
    const token = await call("mint write token", () => this.handle.createToken("write", 120));
    try {
      return await report(await send(info.remote, token.plaintext));
    } finally {
      try {
        await this.handle.revokeToken(token.id);
      } catch {
        // it expires in two minutes anyway
      }
    }
  }
}

function pick(c: ArtifactsCommitMetadata): CommitInfo {
  return { hash: c.hash, treeHash: c.treeHash, parents: c.parents, committedAt: c.committedAt };
}

// pkt-line framing: four hex digits of length (including themselves), then data.
const enc = new TextEncoder();
const dec = new TextDecoder();
const FLUSH = enc.encode("0000");

function pktLine(s: string): Uint8Array {
  const data = enc.encode(s);
  return concat([enc.encode((data.length + 4).toString(16).padStart(4, "0")), data]);
}

function readPktLines(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let i = 0;
  while (i + 4 <= bytes.length) {
    const len = parseInt(dec.decode(bytes.subarray(i, i + 4)), 16);
    if (Number.isNaN(len)) break;
    if (len < 4) {
      i += 4; // flush or delimiter
      continue;
    }
    out.push(bytes.subarray(i + 4, i + len));
    i += len;
  }
  return out;
}

// report-status: "unpack ok", then "ok <ref>" or "ng <ref> <reason>". If the
// server wrapped it in side-band anyway, band 1 holds the same lines.
function readReport(bytes: Uint8Array, ref: string): string | null {
  let lines = readPktLines(bytes);
  if (lines.length && (lines[0][0] === 1 || lines[0][0] === 2 || lines[0][0] === 3)) {
    const band1 = lines.filter((l) => l[0] === 1).map((l) => l.subarray(1));
    const band3 = lines.filter((l) => l[0] === 3).map((l) => dec.decode(l.subarray(1)));
    if (band3.length) return band3.join(" ").trim();
    lines = readPktLines(concat(band1));
  }
  const text = lines.map((l) => dec.decode(l).replace(/\n$/, ""));
  const unpack = text.find((t) => t.startsWith("unpack "));
  if (unpack && unpack !== "unpack ok") return unpack;
  for (const t of text) {
    if (t === `ok ${ref}`) return null;
    if (t.startsWith(`ng ${ref} `)) return t.slice(`ng ${ref} `.length);
  }
  return `no status for ${ref} in the reply: ${text.join(" | ") || preview(bytes)}`;
}

function preview(bytes: Uint8Array): string {
  return dec.decode(bytes.subarray(0, 300)).replace(/[^\x20-\x7e]+/g, " ").trim();
}
