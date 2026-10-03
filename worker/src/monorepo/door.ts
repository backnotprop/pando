// The git door: smart HTTP at /<monorepo>/<repo>.git, proxied to the repo's
// Artifacts remote with tokens the Worker mints for itself. Receive-pack is
// checked before the pack is streamed: main moves only by a merge (the first
// push that creates it passes). Only members of the monorepo get through.

import type { Env } from "../env";
import { agentHeader, credential, errorJson, HttpError, toErrorResponse } from "../http";
import { gitRequest, listRefs } from "./artifacts";
import { compare } from "./graph";
import { ZERO } from "./names";
import { concat, drain, parseReport, pkt, prepend, readCommandSection, refusal } from "./pktline";
import { isBusy, LEASE_MS } from "./gate";
import { addGate, currentTiming, finishTiming, note, relayTimed, runTimed, startTiming, timeArtifacts } from "../timing";

/** Count the pack bytes git sends (push_bytes on the timing line). */
/**
 * A push up to this size is held in memory, so the door can send it to
 * Artifacts again when Artifacts answers that the repo is busy (about 2
 * receive-packs run at once per repo). Larger pushes stream through and can
 * still be refused; the person pushes again.
 */
export const BUSY_REPLAY_MAX = 1 << 20;
/** The wait before the one retry: jittered, so two refused pushes do not collide again. */
const BUSY_WAIT_MS = [150, 400] as const;

/** Read up to `max` bytes after `head`. `all` when the body ended within them. */
async function bufferUpTo(head: Uint8Array, reader: ReadableStreamDefaultReader<Uint8Array>, max: number): Promise<{ all: boolean; bytes: Uint8Array }> {
  const chunks: Uint8Array[] = [head];
  let n = head.byteLength;
  while (n <= max) {
    const { done, value } = await reader.read();
    if (done) return { all: true, bytes: concat(chunks) };
    chunks.push(value);
    n += value.byteLength;
  }
  return { all: false, bytes: concat(chunks) };
}

function countBytes(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const t = currentTiming(); // the stream's callbacks may run outside the request's context
  let n = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        n += chunk.byteLength;
        ctl.enqueue(chunk);
      },
      flush() {
        if (t) t.fields.push_bytes = n;
      },
    }),
  );
}
import type { Identity, RepoEvent, RepoRecord } from "./types";
import { cachedRepo, monorepoStub } from "./session";
import { answerObjectInfo, peekCommand, withObjectInfo } from "./objectinfo";
import { accounts, authenticate, identityOf } from "../accounts/auth";
import type { MonorepoInfo } from "../accounts/store";
import { monorepoRef } from "./names";

// /owner/monorepo/repo.git/... (a monorepo's repo, meta included) or /owner/name.git/... (a plain repo).
const DOOR_RE = /^\/([^/]+)\/([^/]+)(?:\/([^/]+))?\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export function isDoorPath(pathname: string): boolean {
  return DOOR_RE.test(pathname);
}

function unauthorized(): Response {
  return new Response("Pando: a token is needed (Bearer, or as the password)\n", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="Pando"', "content-type": "text/plain" },
  });
}

function passHeaders(req: Request, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = req.headers.get(n);
    if (v) out[n] = v;
  }
  return out;
}

function relay(res: Response, body: ReadableStream | null = res.body): Response {
  const headers = new Headers({ "cache-control": "no-cache" });
  const ct = res.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  return new Response(body, { status: res.status, headers });
}

/** Relay Artifacts' answer; its body counts as Artifacts time until its last byte (pando.timing). */
function relayFrom(res: Response, op: string, repo: string | null, since: number): Response {
  const out = relay(res);
  const t = currentTiming();
  if (!t || !out.body) return out;
  t.fields.stream = "sending";
  return relayTimed(out, t, op, repo, since);
}

export async function handleDoor(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const m = new URL(req.url).pathname.match(DOOR_RE);
  const t = startTiming("door", {
    route: m ? m[4] : "door",
    method: req.method,
    monorepo: m ? `${m[1]}/${m[2]}`.toLowerCase() : null,
    repo: m ? (m[3] ?? m[2]).toLowerCase() : null,
    service: new URL(req.url).searchParams.get("service") ?? undefined,
    protocol: /version=2/.test(req.headers.get("git-protocol") ?? "") ? "v2" : "v0",
    colo: (req as Request & { cf?: { colo?: string } }).cf?.colo,
  });
  return runTimed(t, async () => {
    let res: Response;
    try {
      res = await door(req, env, ctx);
    } catch (err) {
      res = toErrorResponse(err);
    }
    // A relayed body writes its line when it has been sent.
    if (t.fields.stream === undefined) finishTiming(t, { status: res.status });
    return res;
  });
}

async function door(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const [, o, mono, repoSeg, action] = url.pathname.match(DOOR_RE)!;
  const ref = monorepoRef(o, mono);
  if (!ref) return errorJson(404, "not_found", `no monorepo ${o}/${mono}`);
  const shown = `${ref.owner}/${ref.name}`;
  // null: the plain repo (/owner/name.git); else a monorepo's repo by name.
  const repoName = repoSeg === undefined ? null : repoSeg.toLowerCase();
  const service = action === "info/refs" ? url.searchParams.get("service") : action;
  if (service !== "git-upload-pack" && service !== "git-receive-pack") {
    return errorJson(403, "smart_http_only", "Pando serves git's smart HTTP protocol only");
  }
  if (action === "info/refs" ? req.method !== "GET" : req.method !== "POST") return errorJson(405, "method", "method not allowed");

  const secret = credential(req);
  if (!secret) return unauthorized();

  // A hook delivery's read token: clone and fetch only, checked by Artifacts.
  if (/^art_v\d+_/.test(secret)) {
    if (service !== "git-upload-pack") return unauthorized();
    const info = await accounts(env).resolve(ref);
    const shape = info && shapeProblem(info, repoName);
    if (!info || shape) return errorJson(404, "not_found", shape ?? `no monorepo ${shown}`);
    const repo = await cachedRepo(env, info.id, repoName);
    if (!repo) return errorJson(404, "not_found", `no repo ${info.full_name}/${repoName}`);
    const s0 = Date.now();
    const res = await timeArtifacts(`http ${req.method} ${action}`, repo.artifacts_name, () =>
      toArtifacts(req, repo, action, url.search, { authorization: req.headers.get("authorization")! }),
    );
    note({ credential: "hook_read_token" });
    return relayFrom(res, `http ${req.method} ${action}`, repo.artifacts_name, s0);
  }

  const auth = await authenticate(env, secret, ref);
  // A browser session never works at the git door (it only travels as the /v1 cookie).
  if (!auth || auth.credential.kind === "browser") return unauthorized();
  if (!auth.monorepo) return errorJson(404, "not_found", `no monorepo ${shown}`);
  if (!auth.role) return errorJson(403, "not_a_member", `${auth.user.login} is not a member of ${auth.monorepo.full_name}`);
  const shape = shapeProblem(auth.monorepo, repoName);
  if (shape) return errorJson(404, "not_found", shape);
  const id = auth.monorepo.id;
  note({ monorepo: auth.monorepo.full_name, monorepo_id: id });
  const stub = monorepoStub(env, id);
  const identity = { ...identityOf(auth), agent: agentHeader(req) };
  const repo = await cachedRepo(env, id, repoName);
  if (!repo) return errorJson(404, "not_found", `no repo ${auth.monorepo.full_name}/${repoName}`);

  const v2 = /version=2/.test(req.headers.get("git-protocol") ?? "");
  if (v2 && service === "git-upload-pack" && action === "info/refs") {
    // Artifacts' v2 advertisement, plus object-info, which the door answers itself.
    const res = await gitRequest(env, repo, `/info/refs${url.search}`, "read", { method: "GET", headers: passHeaders(req, ["accept", "git-protocol"]) });
    if (!res.ok) return relay(res);
    const body = withObjectInfo(new Uint8Array(await timeArtifacts("http GET info/refs (body)", repo.artifacts_name, () => res.arrayBuffer())));
    return new Response(body, { headers: { "content-type": res.headers.get("content-type") ?? "application/x-git-upload-pack-advertisement", "cache-control": "no-cache" } });
  }
  let uploadBody: ReadableStream<Uint8Array> | null = req.body;
  if (v2 && action === "git-upload-pack" && req.body) {
    const gzip = (req.headers.get("content-encoding") ?? "").toLowerCase() === "gzip";
    const peeked = await peekCommand(req.body, gzip);
    if (peeked.objectInfo) {
      return new Response(await answerObjectInfo(env, stub, repo, peeked.objectInfo), {
        headers: { "content-type": "application/x-git-upload-pack-result", "cache-control": "no-cache" },
      });
    }
    uploadBody = peeked.body;
  }

  if (service === "git-upload-pack" || action === "info/refs") {
    const scope = service === "git-upload-pack" ? "read" : "write";
    const s0 = Date.now();
    const res = await gitRequest(env, repo, action === "info/refs" ? `/info/refs${url.search}` : `/${action}`, scope, {
      method: req.method,
      headers: passHeaders(req, ["content-type", "content-encoding", "accept", "git-protocol"]),
      body: req.method === "POST" ? uploadBody : undefined,
    });
    return relayFrom(res, `http ${req.method} ${action}`, repo.artifacts_name, s0);
  }

  return receivePack(req, env, ctx, id, repo, identity, url.origin);
}

/** A plain repo's git URL is /owner/name.git; a monorepo's repos are /owner/monorepo/repo.git. Why this one doesn't fit, or null. */
function shapeProblem(m: MonorepoInfo, repoName: string | null): string | null {
  if (m.kind === "repo" && repoName !== null) return `${m.full_name} is a plain git repo: its URL is /${m.full_name}.git`;
  if (m.kind === "monorepo" && repoName === null) return `${m.full_name} is a monorepo: clone one of its repos, /${m.full_name}/<repo>.git`;
  return null;
}

async function toArtifacts(req: Request, repo: RepoRecord, action: string, search: string, auth: Record<string, string>): Promise<Response> {
  return fetch(`${repo.remote}${action === "info/refs" ? `/info/refs${search}` : `/${action}`}`, {
    method: req.method,
    headers: { ...passHeaders(req, ["content-type", "content-encoding", "accept", "git-protocol"]), ...auth },
    body: req.method === "POST" ? req.body : undefined,
  });
}

async function receivePack(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  monorepo: string,
  repo: RepoRecord,
  identity: Identity,
  origin: string,
): Promise<Response> {
  if (!req.body) throw new HttpError(400, "bad_request", "empty push");
  let body: ReadableStream<Uint8Array> = req.body;
  if ((req.headers.get("content-encoding") ?? "").toLowerCase() === "gzip") {
    body = body.pipeThrough(new DecompressionStream("gzip"));
  }
  const section = await readCommandSection(body);
  const stub = monorepoStub(env, monorepo);
  const refused = await stub.checkPush(repo.name, section.commands);
  if (refused.length) {
    await drain(section.rest);
    const reasons = new Map(refused.map((r) => [r.ref, r.reason]));
    const message = `Pando refused this push: ${refused.map((r) => r.reason).join("; ")}`;
    return new Response(refusal(section.commands, reasons, section.caps, message), {
      headers: { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-cache" },
    });
  }

  // Small pushes are read in full first (before taking a slot), so a busy answer can be replayed.
  const buffered = await bufferUpTo(section.head, section.rest, BUSY_REPLAY_MAX);
  // Tests only: take the first attempt as busy without sending it.
  let fakeBusy = env.DOOR_TEST === "1" && req.headers.get("x-pando-test-busy") === "1";

  // One of the repo's two write slots (gate.ts). git waits here while the slot is taken.
  const g0 = Date.now();
  const slot = await stub.acquireWrite(repo.artifacts_name);
  addGate(slot.ok ? slot.value.waited_ms : Date.now() - g0);
  note({ refs: section.commands.length });
  if (!slot.ok) {
    if (!buffered.all) await drain(section.rest);
    return busyRefusal(section, `Pando: ${repo.name} is busy with other writes; push again`);
  }
  const lease = slot.value.lease;
  const renew = setInterval(() => {
    stub.renewWrite(repo.artifacts_name, lease).catch(() => {});
  }, LEASE_MS / 3);
  let bytes: Uint8Array = new Uint8Array(0);
  let res: Response | null = null;
  let busy = false;
  // A failed call (thrown, or Artifacts answering 5xx): its reason, for the log; git gets a plain refusal.
  let failed: string | null = null;
  let fakeFail = env.DOOR_TEST === "1" && req.headers.get("x-pando-test-fail") === "1";
  const send = async (): Promise<{ res: Response | null; bytes: Uint8Array; busy: boolean; failed: string | null }> => {
    try {
      return await sendOnce();
    } catch (err) {
      return { res: null, bytes: new Uint8Array(0), busy: false, failed: err instanceof Error ? err.message : String(err) };
    }
  };
  const sendOnce = async () => {
    if (fakeBusy) {
      fakeBusy = false;
      return { res: null, bytes: pkt("ERR artifacts_git_receive_pack_busy (test)\n"), busy: true, failed: null };
    }
    if (fakeFail) {
      fakeFail = false;
      throw new Error("door test: a failed Artifacts call");
    }
    if (buffered.all) note({ push_bytes: buffered.bytes.byteLength });
    const r = await gitRequest(env, repo, "/git-receive-pack", "write", {
      method: "POST",
      headers: {
        "content-type": "application/x-git-receive-pack-request",
        accept: "application/x-git-receive-pack-result",
      },
      body: buffered.all ? buffered.bytes : countBytes(prepend(buffered.bytes, section.rest)),
    });
    // The whole report, before git sees it: the push is recorded first (it is small).
    const b = new Uint8Array(await timeArtifacts("http POST git-receive-pack (body)", repo.artifacts_name, () => r.arrayBuffer()));
    // Busy: Artifacts' code, and no pack taken (a branch could be named like the code).
    const refusedBusy = isBusy(new TextDecoder().decode(b.subarray(0, 512))) && parseReport(b, section.caps).unpack !== "ok";
    return { res: r, bytes: b, busy: refusedBusy, failed: r.status >= 500 ? `Artifacts answered ${r.status}` : null };
  };
  try {
    ({ res, bytes, busy, failed } = await send());
    if ((busy || failed) && buffered.all) {
      // Busy (mid-push with others) or failed: wait a moment and send the same pack again, once, in the same slot.
      // A replay cannot apply twice: each ref update names the old head it expects.
      const why = busy ? "busy_retry" : "fail_retry";
      if (failed) console.warn(`receive-pack on ${repo.artifacts_name} failed, retrying once: ${failed}`);
      await new Promise((r) => setTimeout(r, BUSY_WAIT_MS[0] + Math.random() * (BUSY_WAIT_MS[1] - BUSY_WAIT_MS[0])));
      ({ res, bytes, busy, failed } = await send());
      note({ [why]: busy || failed ? "failed" : "ok" });
    } else if (busy) {
      if (!res) await drain(section.rest); // the test's unsent large push
      note({ busy_retry: "too_large" });
    } else if (failed) {
      note({ fail_retry: "too_large" });
      await drain(section.rest).catch(() => undefined); // whatever git still sends
    }
  } finally {
    clearInterval(renew);
    await stub.releaseWrite(repo.artifacts_name, lease, false).catch(() => false);
  }
  // Still busy: a plain message, not Artifacts' code.
  if (busy) return busyRefusal(section, `Pando: ${repo.name} is busy with other pushes right now; push again`);
  // Failed: never a bare 500 to git. Nothing was recorded; the person pushes again.
  if (failed) {
    console.error(`receive-pack on ${repo.artifacts_name} failed: ${failed}`);
    note({ push_error: failed.slice(0, 200) });
    return busyRefusal(section, `Pando: ${repo.name} couldn't take this push right now; push again`, "couldn't take it; push again");
  }
  const headers = { "content-type": res!.headers.get("content-type") ?? "application/x-git-receive-pack-result", "cache-control": "no-cache" };
  if (!res!.ok) return new Response(bytes, { status: res!.status, headers });

  // Record before ack: branch heads and their events are written before git gets its report.
  const report = parseReport(bytes, section.caps);
  if (report.error) console.warn(`receive-pack on ${repo.artifacts_name}: ${report.error}`);
  const accepted = report.unpack === "ok" ? section.commands.filter((c) => report.refs.get(c.ref) === null) : [];
  // The object writes the branch rows, their events and their hook deliveries in one step (C2, C9).
  if (accepted.length) await stub.recordPush(repo.name, identity, accepted, {}, origin);
  return new Response(bytes, { headers });
}

/** Every ref refused with `message` (side-band aware: git prints it, then "! [remote rejected] ... (busy; push again)"). */
function busyRefusal(section: { commands: import("./pktline").RefCommand[]; caps: Set<string> }, message: string, reason = "busy; push again"): Response {
  const reasons = new Map(section.commands.map((c) => [c.ref, reason]));
  return new Response(refusal(section.commands, reasons, section.caps, message), {
    headers: { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-cache" },
  });
}

