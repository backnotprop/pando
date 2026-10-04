// The git door: smart HTTP at /<monorepo>/<repo>.git, proxied to the repo's
// Artifacts remote with tokens the Worker mints for itself. Receive-pack is
// checked before the pack is streamed: main moves only by a merge (the first
// push that creates it passes). Only members of the monorepo get through.

import type { Env } from "../env";
import { agentHeader, credential, errorJson, HttpError, toErrorResponse } from "../http";
import { gitRequest, listRefs, withRepo } from "./artifacts";
import { concat, drain, parseReport, pkt, readCommandSection, refusal, statusReport, type RefCommand } from "./pktline";
import { isBusy, LEASE_MS } from "./gate";
import { wholeThinTrees } from "./thinpack";
import { addGate, currentTiming, finishTiming, note, relayTimed, runTimed, startTiming, timeArtifacts } from "../timing";

/**
 * A push up to this size is held in memory, so the door can send it to
 * Artifacts again when Artifacts answers that the repo is busy (about 2
 * receive-packs run at once per repo). Larger pushes stream through and can
 * still be refused; the person pushes again.
 */
export const BUSY_REPLAY_MAX = 1 << 20;

/**
 * The largest push Artifacts takes: 64 MiB of receive-pack request (measured 2026-10-04: 67,101,123 bytes landed,
 * 67,116,129 got "receive-pack request exceeds maximum size"). A larger push is refused by the door, never sent whole.
 */
export const PUSH_MAX = 64 << 20;

/** Tests only (DOOR_TEST=1): X-Pando-Test-Push-Max lowers PUSH_MAX for one push, so a small push can be over it. */
function pushMax(env: Env, req: Request): number {
  const lowered = env.DOOR_TEST === "1" ? Number(req.headers.get("x-pando-test-push-max") ?? 0) : 0;

  return lowered > 0 ? Math.min(lowered, PUSH_MAX) : PUSH_MAX;
}

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

interface CappedPush {
  body: ReadableStream<Uint8Array>;
  /** Aborts the call to Artifacts when the push goes over the cap. */
  signal: AbortSignal;
  /** Whether the push is over the cap: stopped on its way, or found so when the rest of git's body was read. */
  over: () => boolean;
  /** Read what git still sends (after a failed or early answer), still counting: git reads the answer only after. */
  readRest: () => Promise<void>;
}

/**
 * A streamed push on its way to Artifacts: `first`, then the rest of git's body, counted (push_bytes on the timing
 * line). Going over `max`, it aborts the call before the pack's last bytes (its checksum) are sent, so Artifacts
 * cannot take the push. git's body is never cancelled: readRest reads it to the end.
 */
function capped(first: Uint8Array, rest: ReadableStreamDefaultReader<Uint8Array>, max: number): CappedPush {
  const t = currentTiming(); // the stream's callbacks may run outside the request's context
  let n = 0;
  let next: Uint8Array | null = first;
  let over = false;
  const abort = new AbortController();

  const readRest = async () => {
    for (;;) {
      const { done, value } = await rest.read();

      if (done) {
        if (t) t.fields.push_bytes = n;

        return;
      }

      n += value.byteLength;
      over ||= n > max;
    }
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      const { done, value } = next ? { done: false, value: next } : await rest.read();
      next = null;

      if (done) {
        if (t) t.fields.push_bytes = n;
        ctl.close();

        return;
      }

      n += value.byteLength;

      if (n > max) {
        over = true;
        abort.abort();

        return;
      }

      ctl.enqueue(value);
    },
  });

  return { body, signal: abort.signal, over: () => over, readRest };
}

import type { Identity, RepoRecord } from "./types";
import { cachedRepo, monorepoStub } from "./session";
import { answerObjectInfo, peekCommand, withObjectInfo } from "./objectinfo";
import { accounts, authenticate, identityOf } from "../accounts/auth";
import type { MonorepoInfo } from "../accounts/store";
import { monorepoRef, ZERO } from "./names";
import { runReconcile } from "./reconcile";

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
  return Object.fromEntries(
    names.flatMap((n) => {
      const v = req.headers.get(n);

      return v ? [[n, v]] : [];
    }),
  );
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

/** A request as it arrives at the Worker: Cloudflare's incoming properties (colo...) on `cf`. */
export type IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

export async function handleDoor(req: IncomingRequest, env: Env, ctx: ExecutionContext): Promise<Response> {
  const m = new URL(req.url).pathname.match(DOOR_RE);

  const t = startTiming("door", {
    route: m ? m[4] : "door",
    method: req.method,
    monorepo: m ? `${m[1]}/${m[2]}`.toLowerCase() : null,
    repo: m ? (m[3] ?? m[2]).toLowerCase() : null,
    service: new URL(req.url).searchParams.get("service") ?? undefined,
    protocol: /version=2/.test(req.headers.get("git-protocol") ?? "") ? "v2" : "v0",
    colo: req.cf?.colo,
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
    const misfit = info && urlKindProblem(info, repoName);

    if (!info || misfit) return errorJson(404, "not_found", misfit ?? `no monorepo ${shown}`);
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
  const misfit = urlKindProblem(auth.monorepo, repoName);

  if (misfit) return errorJson(404, "not_found", misfit);
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
function urlKindProblem(m: MonorepoInfo, repoName: string | null): string | null {
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

  const gzip = (req.headers.get("content-encoding") ?? "").toLowerCase() === "gzip";

  if (gzip) body = body.pipeThrough(new DecompressionStream("gzip"));

  const section = await readCommandSection(body);
  const stub = monorepoStub(env, monorepo);
  // Tests only: the refs compare after this push comes this soon (else REFS_CHECK_MS).
  const checkEveryMs = env.DOOR_TEST === "1" ? Number(req.headers.get("x-pando-test-refs-check-ms") ?? 0) || null : null;
  const { refused, kept } = await stub.checkPush(repo.name, section.commands, checkEveryMs);

  if (refused.length) {
    await drain(section.rest);
    const reasons = new Map(refused.map((r) => [r.ref, r.reason]));
    const message = `Pando refused this push: ${refused.map((r) => r.reason).join("; ")}`;

    return new Response(refusal(section.commands, reasons, section.caps, message), {
      headers: { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-cache" },
    });
  }

  const max = pushMax(env, req);
  const declared = Number(req.headers.get("content-length") ?? 0);

  // Over the most Artifacts takes, by git's own count: refused before anything is sent.
  if (declared > max && !gzip) {
    await drain(section.rest);

    return tooLarge(section, max, repo);
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
  // What goes to Artifacts for a push held in memory: git's bytes, or the same push with its thin tree deltas whole.
  let payload = buffered.bytes;
  let res: Response | null = null;
  let busy = false;
  // A failed call (thrown, or Artifacts answering 5xx): its reason, for the log. The push may have landed anyway.
  let failed: string | null = null;
  let fakeFail = env.DOOR_TEST === "1" && req.headers.get("x-pando-test-fail") === "1";
  // A push not held in memory, as it streams to Artifacts (stopped if it goes over `max`). Sent once: never resent.
  const streamed = buffered.all ? null : capped(buffered.bytes, section.rest, max);
  // Tests only: the pack reaches Artifacts for real; its answer is dropped as if the call threw.
  let loseAnswer = env.DOOR_TEST === "1" && req.headers.get("x-pando-test-lose-answer") === "1";

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
      body: streamed ? streamed.body : payload,
      signal: streamed?.signal,
    });

    // The whole report, before git sees it: the push is recorded first (it is small).
    const b = new Uint8Array(await timeArtifacts("http POST git-receive-pack (body)", repo.artifacts_name, () => r.arrayBuffer()));

    if (loseAnswer) {
      loseAnswer = false;
      throw new Error("door test: Artifacts' answer was lost");
    }

    // Busy: Artifacts' code, and no pack taken (a branch could be named like the code).
    const refusedBusy = isBusy(new TextDecoder().decode(b.subarray(0, 512))) && parseReport(b, section.caps).unpack !== "ok";

    return { res: r, bytes: b, busy: refusedBusy, failed: r.status >= 500 ? `Artifacts answered ${r.status}` : null };
  };

  // After a lost answer: where the push's refs are at Artifacts now. All at their new heads (it landed), all at their old
  // ones (it did not), or anything else (or unreadable).
  const readWhere = async (): Promise<{ at: "new" | "old" | "unknown"; refs: Map<string, string> | null }> => {
    try {
      // Tests only: a pause after the lost answer, before the read, for another push to move the ref meanwhile.
      const pause = env.DOOR_TEST === "1" ? Math.min(Number(req.headers.get("x-pando-test-pause-after-lost-ms") ?? 0), 10_000) : 0;

      if (pause > 0) await new Promise((r) => setTimeout(r, pause));
      const refs = await listRefs(env, repo);
      const there = (c: RefCommand) => refs.get(c.ref) ?? ZERO;

      if (section.commands.every((c) => there(c) === c.new)) return { at: "new", refs };

      return { at: section.commands.every((c) => there(c) === c.old) ? "old" : "unknown", refs };
    } catch (err) {
      console.warn(`reading ${repo.artifacts_name}'s refs after a lost answer failed: ${err instanceof Error ? err.message : String(err)}`);

      return { at: "unknown", refs: null };
    }
  };

  const wait = () => new Promise((r) => setTimeout(r, BUSY_WAIT_MS[0] + Math.random() * (BUSY_WAIT_MS[1] - BUSY_WAIT_MS[0])));
  // What decides git's answer: Artifacts' own report, or, after a lost answer, where the refs are (CODE-VS-MODEL.md P1).
  let outcome: "report" | "landed" | "unknown" = "report";
  let refsNow: Map<string, string> | null = null;

  try {
    let lost = false;

    // In the same slot: one resend after a busy or lost answer, and one with whole trees after a delta cycle. A resend
    // cannot apply twice: each ref update names the old head it expects.
    let resent = false;
    let rewritten = false;

    for (;;) {
      ({ res, bytes, busy, failed } = await send());
      const again = buffered.all && !resent;

      // Over the most Artifacts takes: the door stopped the pack before its end, so it cannot have landed.
      if (streamed?.over()) break;

      if (busy) {
        // Busy (mid-push with others): no pack taken. A push held in memory is sent again after a moment.
        note({ busy_retry: again ? "resent" : buffered.all ? "failed" : "too_large" });

        if (again) {
          resent = true;
          await wait();
          continue;
        }

        break;
      }

      // Artifacts refused a tree delta (a revert's tree, thinpack.ts): the push held in memory goes again with those trees whole.
      if (!failed && !rewritten && buffered.all && DELTA_CYCLE.test(parseReport(bytes, section.caps).unpack ?? "")) {
        rewritten = true;
        const whole = await withWholeTrees(env, repo, payload, section.packAt);
        note({ delta_cycle: whole ? "resent" : "no_tree_delta", whole_trees: whole?.trees ?? 0 });

        if (whole) {
          payload = whole.body;
          continue;
        }
      }

      // Artifacts' report decides, unless the answer was lost (a throw or a 5xx) or a resend after one was refused.
      if (!failed && !(lost && refusedSome(bytes, section))) break;
      lost = true;

      if (failed) {
        console.warn(`receive-pack on ${repo.artifacts_name} failed: ${failed}`);
        note({ push_error: failed.slice(0, 200) });
      }

      // The push may have landed: read its refs before sending it again.
      const where = await readWhere();
      refsNow = where.refs;

      if (where.at === "new") {
        outcome = "landed";
        break;
      }

      if (where.at === "old" && again) {
        resent = true;
        note({ fail_retry: "resent" });
        await wait();
        continue;
      }

      outcome = "unknown";
      break;
    }
  } finally {
    clearInterval(renew);
    await stub.releaseWrite(repo.artifacts_name, lease, false).catch(() => false);
  }

  // A streamed push: whatever git still sends, read with the slot free. Over the cap in all, it cannot have landed:
  // the door never sent it whole.
  if (streamed) {
    await streamed.readRest().catch(() => undefined);

    if (streamed.over()) return tooLarge(section, max, repo);
  }

  // Still busy: a plain message, not Artifacts' code.
  if (busy) return busyRefusal(section, `Pando: ${repo.name} is busy with other pushes right now; push again`);

  // Not known to have landed: kept as 'unknown' and reconciled from Artifacts' refs before git hears anything (record
  // before ack), so a push that did land is recorded with its events and hook delivery. If either fails, git is answered
  // anyway; the refs compare covers it. git hears ok for each ref already at its new head, "push again" for the rest.
  if (outcome === "unknown") {
    note({ push_outcome: "unknown" });
    const notThere = section.commands.filter((c) => (refsNow?.get(c.ref) ?? ZERO) !== c.new);

    try {
      await keepUnrecorded(stub, repo.name, identity, section.commands, origin, false, "unknown");
      await runReconcile(env, stub, repo);
    } catch (err) {
      console.error(`reconciling ${repo.name} after a lost answer failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return reportResponse(section, new Map(notThere.map((c) => [c.ref, "couldn't take it; push again"])), notThere.length ? `Pando: ${repo.name} couldn't take this push right now; push again` : "");
  }

  let accepted: RefCommand[];
  let answer: Response;

  if (outcome === "landed") {
    // Artifacts' answer was lost, but every ref is at its new head: the push landed.
    note({ push_outcome: "landed_after_lost_answer" });
    accepted = section.commands;
    answer = reportResponse(section, new Map(), "");
  } else {
    const headers = { "content-type": res!.headers.get("content-type") ?? "application/x-git-receive-pack-result", "cache-control": "no-cache" };

    if (!res!.ok) return new Response(bytes, { status: res!.status, headers });

    // Record before ack: branch heads and their events are written before git gets its report.
    const report = parseReport(bytes, section.caps);

    if (report.error) console.warn(`receive-pack on ${repo.artifacts_name}: ${report.error}`);
    accepted = report.unpack === "ok" ? section.commands.filter((c) => report.refs.get(c.ref) === null) : [];
    answer = new Response(bytes, { headers });
  }

  // The object writes the branch rows, their events and their hook deliveries in one step (C2, C9). If that fails,
  // the push still landed: git gets its report, and the commands are kept for the next branch read to reconcile.
  if (accepted.length) {
    try {
      // Tests only: a slow record (another push's record can land first), or a failed one.
      const delay = env.DOOR_TEST === "1" ? Number(req.headers.get("x-pando-test-record-delay-ms") ?? 0) : 0;

      if (delay > 0) await new Promise((r) => setTimeout(r, Math.min(delay, 10_000)));

      if (env.DOOR_TEST === "1" && req.headers.get("x-pando-test-record-fail") === "1") throw new Error("door test: the record failed");
      await stub.recordPush(repo.name, identity, accepted, {}, origin);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);

      console.error(`recording a push to ${repo.name} failed; kept for a reconcile: ${why}`);
      note({ record_error: why.slice(0, 200) });
      ctx.waitUntil(keepUnrecorded(stub, repo.name, identity, accepted, origin, env.DOOR_TEST === "1" && req.headers.get("x-pando-test-keep-fail") === "1"));
    }
  }

  // Pushes kept earlier (a record that failed, an answer lost) are repaired now, not at the next compare.
  if (kept) ctx.waitUntil(runReconcile(env, stub, repo).catch((err) => console.error(`reconciling ${repo.name} on a push failed: ${err instanceof Error ? err.message : String(err)}`)));

  return answer;
}

/** Artifacts' unpack refusal of a tree sent as a delta against a tree it holds as a delta against that same tree. */
const DELTA_CYCLE = /stored delta chain contains a cycle/;

/** The push (command section, then pack at `packAt`) with its thin tree deltas whole, or null (none, or not readable). */
async function withWholeTrees(env: Env, repo: RepoRecord, body: Uint8Array, packAt: number): Promise<{ body: Uint8Array; trees: number } | null> {
  try {
    const whole = await withRepo(env, repo.artifacts_name, (r) =>
      wholeThinTrees(body.subarray(packAt), async (sha) => {
        try {
          return await r.readTree(sha);
        } catch {
          return null; // not a tree (a blob or commit base), or not there
        }
      }),
    );

    return whole && { body: concat([body.subarray(0, packAt), whole.pack]), trees: whole.trees };
  } catch (err) {
    console.warn(`writing ${repo.artifacts_name}'s pushed trees whole failed: ${err instanceof Error ? err.message : String(err)}`);

    return null;
  }
}

/** Whether a report refused any of the push's refs (or did not unpack). */
function refusedSome(bytes: Uint8Array, section: { commands: RefCommand[]; caps: Set<string> }): boolean {
  const report = parseReport(bytes, section.caps);

  return report.unpack !== "ok" || section.commands.some((c) => report.refs.get(c.ref) !== null);
}

/** git's report for the push: ok for each ref, but those in `ng` with their reason; `message` is shown first (side-band). */
function reportResponse(section: { commands: RefCommand[]; caps: Set<string> }, ng: Map<string, string>, message: string): Response {
  return new Response(statusReport(section.commands, ng, section.caps, message), {
    headers: { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-cache" },
  });
}

/** Store a push the object could not record (or one not known to have landed), trying again a few times while the object is unreachable. */
async function keepUnrecorded(
  stub: ReturnType<typeof monorepoStub>,
  repo: string,
  identity: Identity,
  commands: RefCommand[],
  origin: string | null,
  testFail = false,
  landed: "yes" | "unknown" = "yes",
): Promise<void> {
  for (const wait of [0, 1_000, 3_000, 10_000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));

    try {
      if (testFail) throw new Error("door test: keeping the push failed");
      await stub.markUnrecorded(repo, identity, commands, origin, landed);

      return;
    } catch (err) {
      console.error(`keeping an unrecorded push to ${repo} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * A push over the most one push carries: every ref refused, nothing sent whole to Artifacts, so nothing landed. It
 * names the limit and the way that works: steps under it, oldest commits first. main takes only its first push, so a
 * main too large for one push goes up through pando init, which pushes it in steps.
 */
function tooLarge(section: { commands: RefCommand[]; caps: Set<string> }, max: number, repo: RepoRecord): Response {
  note({ push_outcome: "too_large" });
  const limit = max % (1 << 20) ? `${max} bytes` : `${max >> 20} MiB`;
  const main = section.commands.some((c) => c.ref === `refs/heads/${repo.default_branch}`);

  const how = main
    ? [`Pando: ${repo.default_branch} takes only its first push, so run pando init in this checkout: it pushes the history in steps.`]
    : [
        "Pando: push it in steps, oldest commits first, each under the limit:",
        "Pando:   git push <remote> <an older commit>:refs/heads/<branch>   then the next, then git push",
      ];

  return busyRefusal(section, [`Pando: this push is over ${limit}, the most one push can carry (Artifacts' limit); nothing landed.`, ...how].join("\n"), `over ${limit}; push in steps`);
}

/** Every ref refused with `message` (side-band aware: git prints it, then "! [remote rejected] ... (busy; push again)"). */
function busyRefusal(section: { commands: import("./pktline").RefCommand[]; caps: Set<string> }, message: string, reason = "busy; push again"): Response {
  const reasons = new Map(section.commands.map((c) => [c.ref, reason]));

  return new Response(refusal(section.commands, reasons, section.caps, message), {
    headers: { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-cache" },
  });
}


/**
 * Tests only (DOOR_TEST=1 and the bootstrap secret): GET
 * /v1/_door/test?monorepo=<id>&repo=<name> lists the repo's kept pushes.
 */
export async function doorTestRoute(request: Request, env: Env): Promise<Response> {
  if (env.DOOR_TEST !== "1") return Response.json({ error: { code: "not_found", message: "no such route" } }, { status: 404 });
  const { isBootstrap } = await import("./session");

  if (!(await isBootstrap(env, credential(request)))) return Response.json({ error: { code: "unauthorized", message: "the bootstrap secret only" } }, { status: 401 });
  const q = new URL(request.url).searchParams;
  const [monorepo, repo] = [q.get("monorepo"), q.get("repo")];

  if (!monorepo || !repo) return Response.json({ error: { code: "bad_request", message: "monorepo (its id) and repo" } }, { status: 400 });

  return Response.json({ kept: await env.MONOREPO.getByName(monorepo).testKept(repo) });
}
