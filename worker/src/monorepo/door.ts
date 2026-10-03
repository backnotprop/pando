// The git door: smart HTTP at /<monorepo>/<repo>.git, proxied to the repo's
// Artifacts remote with tokens the Worker mints for itself. Receive-pack is
// checked before the pack is streamed: main moves only by a merge (the first
// push that creates it passes). Only members of the monorepo get through.

import type { Env } from "../env";
import { agentHeader, credential, errorJson, HttpError, toErrorResponse } from "../http";
import { gitRequest, listRefs } from "./artifacts";
import { compare } from "./graph";
import { ZERO } from "./names";
import { drain, parseReport, pkt, prepend, readCommandSection, refusal } from "./pktline";
import { LEASE_MS } from "./gate";
import { addGate, currentTiming, finishTiming, note, relayTimed, runTimed, startTiming, timeArtifacts } from "../timing";

/** Count the pack bytes git sends (push_bytes on the timing line). */
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
import { authenticate, identityOf } from "../accounts/auth";

const DOOR_RE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

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
    route: m ? m[3] : "door",
    method: req.method,
    monorepo: m?.[1] ?? null,
    repo: m?.[2] ?? null,
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
  const [, monorepo, repoName, action] = url.pathname.match(DOOR_RE)!;
  const service = action === "info/refs" ? url.searchParams.get("service") : action;
  if (service !== "git-upload-pack" && service !== "git-receive-pack") {
    return errorJson(403, "smart_http_only", "Pando serves git's smart HTTP protocol only");
  }
  if (action === "info/refs" ? req.method !== "GET" : req.method !== "POST") return errorJson(405, "method", "method not allowed");

  const secret = credential(req);
  if (!secret) return unauthorized();
  const stub = monorepoStub(env, monorepo);

  // A hook delivery's read token: clone and fetch only, checked by Artifacts.
  if (/^art_v\d+_/.test(secret)) {
    if (service !== "git-upload-pack") return unauthorized();
    const repo = await cachedRepo(env, monorepo, repoName);
    if (!repo) return errorJson(404, "not_found", `no repo ${monorepo}/${repoName}`);
    const s0 = Date.now();
    const res = await timeArtifacts(`http ${req.method} ${action}`, repo.artifacts_name, () =>
      toArtifacts(req, repo, action, url.search, { authorization: req.headers.get("authorization")! }),
    );
    note({ credential: "hook_read_token" });
    return relayFrom(res, `http ${req.method} ${action}`, repo.artifacts_name, s0);
  }

  const auth = await authenticate(env, secret, monorepo);
  // A browser session never works at the git door (it only travels as the /v1 cookie).
  if (!auth || auth.credential.kind === "browser") return unauthorized();
  if (!auth.monorepo) return errorJson(404, "not_found", `no monorepo ${monorepo}`);
  if (!auth.role) return errorJson(403, "not_a_member", `${auth.user.login} is not a member of ${monorepo}`);
  const identity = { ...identityOf(auth), agent: agentHeader(req) };
  const repo = await cachedRepo(env, monorepo, repoName);
  if (!repo) return errorJson(404, "not_found", `no repo ${monorepo}/${repoName}`);

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

  return receivePack(req, env, ctx, monorepo, repo, identity, url.origin);
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

  // One of the repo's two write slots (gate.ts). git waits here while the slot is taken.
  const g0 = Date.now();
  const slot = await stub.acquireWrite(repo.artifacts_name);
  addGate(slot.ok ? slot.value.waited_ms : Date.now() - g0);
  note({ refs: section.commands.length });
  if (!slot.ok) {
    await drain(section.rest);
    return gitError(`Pando: ${repo.name} is busy with other writes; try the push again`);
  }
  const lease = slot.value.lease;
  const renew = setInterval(() => {
    stub.renewWrite(repo.artifacts_name, lease).catch(() => {});
  }, LEASE_MS / 3);
  let bytes: Uint8Array;
  let res: Response;
  try {
    res = await gitRequest(env, repo, "/git-receive-pack", "write", {
      method: "POST",
      headers: {
        "content-type": "application/x-git-receive-pack-request",
        accept: "application/x-git-receive-pack-result",
      },
      body: countBytes(prepend(section.head, section.rest)),
    });
    // The whole report, before git sees it: the push is recorded first (it is small).
    bytes = new Uint8Array(await timeArtifacts("http POST git-receive-pack (body)", repo.artifacts_name, () => res.arrayBuffer()));
  } finally {
    clearInterval(renew);
    await stub.releaseWrite(repo.artifacts_name, lease).catch(() => false);
  }
  const headers = { "content-type": res.headers.get("content-type") ?? "application/x-git-receive-pack-result", "cache-control": "no-cache" };
  if (!res.ok) return new Response(bytes, { status: res.status, headers });

  // Record before ack: branch heads and their events are written before git gets its report.
  const report = parseReport(bytes, section.caps);
  if (report.error) console.warn(`receive-pack on ${repo.artifacts_name}: ${report.error}`);
  const accepted = report.unpack === "ok" ? section.commands.filter((c) => report.refs.get(c.ref) === null) : [];
  // The object writes the branch rows, their events and their hook deliveries in one step (C2, C9).
  if (accepted.length) await stub.recordPush(repo.name, identity, accepted, {}, origin);
  return new Response(bytes, { headers });
}

/** An `ERR` pkt-line: git prints "remote error: <message>". */
function gitError(message: string): Response {
  return new Response(pkt(`ERR ${message}\n`), {
    headers: { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-cache" },
  });
}

