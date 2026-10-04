// The mirror's git plumbing: ask Artifacts' upload-pack for exactly the
// objects a remote lacks, and stream that pack into the remote's
// receive-pack. Pando never rebuilds Artifacts' commits (readCommit drops the
// timezone and signatures), so the bytes go through as Artifacts made them.
// Nothing here holds a whole pack in memory.

import type { Env } from "../env";
import { HttpError } from "../http";
import { gitRequest, type ArtifactsRef } from "../monorepo/artifacts";
import { concat, FLUSH, parseAdvertisement, parseReport, pkt, pktLines, prepend, type PushReport, type RefCommand } from "../monorepo/pktline";

const dec = new TextDecoder();

export const ZERO = "0000000000000000000000000000000000000000";

/** A git remote reached over smart HTTP: its base (…/name.git) and the Authorization header to send. */
export interface Remote {
  url: string;
  authorization: string;
}

/** At most this many `have` lines: enough for every ref a mirror target carries. */
const MAX_HAVES = 256;

/**
 * A stream of the pack Artifacts sends for `wants`, given that the remote
 * already has `haves`. Protocol v0, stateless: wants, flush, haves, done. The
 * answer's side-band 1 is the pack; band 3 (or an ERR line) fails the stream.
 */
export async function artifactsPack(env: Env, repo: ArtifactsRef, wants: string[], haves: string[]): Promise<ReadableStream<Uint8Array>> {
  const caps = "side-band-64k thin-pack ofs-delta no-progress agent=pando-mirror";
  const lines = wants.map((w, i) => pkt(`want ${w}${i === 0 ? " " + caps : ""}\n`));
  const body = concat([...lines, FLUSH, ...haves.slice(0, MAX_HAVES).map((h) => pkt(`have ${h}\n`)), pkt("done\n")]);

  const res = await gitRequest(env, repo, "/git-upload-pack", "read", {
    method: "POST",
    headers: { "content-type": "application/x-git-upload-pack-request", accept: "application/x-git-upload-pack-result" },
    body,
  });

  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw new HttpError(502, "artifacts", `Artifacts answered ${res.status} to a fetch`);
  }

  return res.body.pipeThrough(sidebandPack());
}

/**
 * Upload-pack's answer to a pack stream: skip the ACK/NAK lines, pass band 1
 * through, drop band 2 (progress), fail on band 3 or `ERR`.
 */
export function sidebandPack(): TransformStream<Uint8Array, Uint8Array> {
  let buf: Uint8Array = new Uint8Array(0);
  let done = false;

  return new TransformStream({
    transform(chunk, controller) {
      if (done) return;
      buf = buf.length ? concat([buf, chunk]) : chunk;
      let pos = 0;

      while (pos + 4 <= buf.length) {
        const len = parseInt(dec.decode(buf.subarray(pos, pos + 4)), 16);

        if (Number.isNaN(len)) throw new HttpError(502, "artifacts", "the fetch answer is not pkt-lines");

        if (len === 0) {
          done = true;
          pos += 4;
          break;
        }

        if (len < 4) {
          pos += 4;
          continue;
        }

        if (pos + len > buf.length) break;
        const line = buf.subarray(pos + 4, pos + len);
        pos += len;
        const band = line[0];

        if (band === 1) controller.enqueue(line.slice(1));
        else if (band === 3) throw new HttpError(502, "artifacts", `Artifacts failed the fetch: ${dec.decode(line.subarray(1)).trim()}`);
        else if (band !== 2) {
          const text = dec.decode(line).trim();

          if (text.startsWith("ERR ")) throw new HttpError(502, "artifacts", `Artifacts refused the fetch: ${text.slice(4)}`);
          // "NAK", "ACK <sha>" and "shallow" lines come before the pack: nothing to pass on.
        }
      }

      buf = buf.subarray(pos);
    },
  });
}

/** Basic auth for a GitHub App installation token, as git sends it. */
export function tokenAuth(token: string): string {
  return `Basic ${btoa(`x-access-token:${token}`)}`;
}

/** The remote's refs, from its receive-pack advertisement. An empty repository has none. */
export async function remoteRefs(remote: Remote): Promise<Map<string, string>> {
  const res = await fetch(`${remote.url}/info/refs?service=git-receive-pack`, {
    headers: { authorization: remote.authorization, "user-agent": "git/2.45 pando-mirror" },
  });

  if (!res.ok) {
    await res.body?.cancel();
    throw new RemoteError(res.status, `GitHub answered ${res.status} to its refs`, res.headers.get("retry-after"));
  }

  return parseAdvertisement(new Uint8Array(await res.arrayBuffer()));
}

/** A failed call to the remote, with its HTTP status (0: no answer) and any retry-after it gave. */
export class RemoteError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfter: string | null = null,
  ) {
    super(message);
  }
}

const PUSH_CAPS = ["report-status", "side-band-64k", "ofs-delta", "agent=pando-mirror"];

/**
 * Push `commands` to the remote with `pack` (a stream from artifactsPack, a
 * built pack, or null when every command is a delete). Returns the remote's
 * report. Commands carry the remote's current value as their old id, so each
 * is a compare-and-swap on the remote even though the mirror always overwrites.
 */
/** A push's report, and what the remote said on side-band 2 (GitHub's "remote:" lines: a refusal's reason). */
export interface PushAnswer {
  report: PushReport;
  messages: string;
}

export async function pushPack(remote: Remote, commands: RefCommand[], pack: ReadableStream<Uint8Array> | Uint8Array | null): Promise<PushAnswer> {
  const head = concat([...commands.map((c, i) => pkt(`${c.old} ${c.new} ${c.ref}${i === 0 ? "\0" + PUSH_CAPS.join(" ") : ""}\n`)), FLUSH]);
  let body: ReadableStream<Uint8Array> | Uint8Array;

  if (pack === null) body = head;
  else if (pack instanceof Uint8Array) body = concat([head, pack]);
  else body = prepend(head, pack.getReader());

  let res: Response;

  try {
    res = await fetch(`${remote.url}/git-receive-pack`, {
      method: "POST",
      headers: {
        authorization: remote.authorization,
        "content-type": "application/x-git-receive-pack-request",
        accept: "application/x-git-receive-pack-result",
        "user-agent": "git/2.45 pando-mirror",
      },
      body,
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new RemoteError(0, `GitHub did not answer the push: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new RemoteError(res.status, `GitHub answered ${res.status} to the push${text ? `: ${text.trim()}` : ""}`, res.headers.get("retry-after"));
  }

  const bytes = new Uint8Array(await res.arrayBuffer());

  return { report: parseReport(bytes, new Set(PUSH_CAPS)), messages: bandTwo(bytes) };
}

/** Side-band 2 text of a receive-pack answer, trimmed. */
function bandTwo(bytes: Uint8Array): string {
  const out: string[] = [];

  for (const line of pktLines(bytes)) {
    if (line && line.length > 1 && line[0] === 2) out.push(dec.decode(line.subarray(1)));
  }

  return out.join("").replace(/\r/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean).join("\n").slice(0, 1_000);
}
