// The git door: smart HTTP at /<monorepo>/<repo>.git, proxied to the repo's
// Artifacts remote with tokens the Worker mints for itself. Receive-pack is
// checked before the pack is streamed: main moves only by a merge (the first
// push that creates it passes). Only members of the monorepo get through.

import type { Env } from "../env";
import { agentHeader, credential, errorJson, HttpError, toErrorResponse } from "../http";
import { gitRequest, listRefs } from "./artifacts";
import { compare } from "./graph";
import { ZERO } from "./names";
import { drain, parseReport, prepend, readCommandSection, refusal } from "./pktline";
import type { Identity, RepoEvent, RepoRecord } from "./types";
import { monorepoStub } from "./session";
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

export async function handleDoor(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    return await door(req, env, ctx);
  } catch (err) {
    return toErrorResponse(err);
  }
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
    const repo = await stub.getRepo(repoName);
    if (!repo) return errorJson(404, "not_found", `no repo ${monorepo}/${repoName}`);
    return relay(await toArtifacts(req, repo, action, url.search, { authorization: req.headers.get("authorization")! }));
  }

  const auth = await authenticate(env, secret, monorepo);
  if (!auth) return unauthorized();
  if (!auth.monorepo) return errorJson(404, "not_found", `no monorepo ${monorepo}`);
  if (!auth.role) return errorJson(403, "not_a_member", `${auth.user.login} is not a member of ${monorepo}`);
  const identity = { ...identityOf(auth), agent: agentHeader(req) };
  const repo = await stub.getRepo(repoName);
  if (!repo) return errorJson(404, "not_found", `no repo ${monorepo}/${repoName}`);

  const v2 = /version=2/.test(req.headers.get("git-protocol") ?? "");
  if (v2 && service === "git-upload-pack" && action === "info/refs") {
    // Artifacts' v2 advertisement, plus object-info, which the door answers itself.
    const res = await gitRequest(env, repo, `/info/refs${url.search}`, "read", { method: "GET", headers: passHeaders(req, ["accept", "git-protocol"]) });
    if (!res.ok) return relay(res);
    const body = withObjectInfo(new Uint8Array(await res.arrayBuffer()));
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
    const res = await gitRequest(env, repo, action === "info/refs" ? `/info/refs${url.search}` : `/${action}`, scope, {
      method: req.method,
      headers: passHeaders(req, ["content-type", "content-encoding", "accept", "git-protocol"]),
      body: req.method === "POST" ? uploadBody : undefined,
    });
    return relay(res);
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

  const res = await gitRequest(env, repo, "/git-receive-pack", "write", {
    method: "POST",
    headers: {
      "content-type": "application/x-git-receive-pack-request",
      accept: "application/x-git-receive-pack-result",
    },
    body: prepend(section.head, section.rest),
  });
  if (!res.ok || !res.body) return relay(res);

  // Send the report to git as it comes, and read a copy to record the push.
  const [toClient, toUs] = res.body.tee();
  ctx.waitUntil(
    (async () => {
      const bytes = new Uint8Array(await new Response(toUs).arrayBuffer());
      const report = parseReport(bytes, section.caps);
      if (report.unpack !== "ok") return;
      const accepted = section.commands.filter((c) => report.refs.get(c.ref) === null);
      if (!accepted.length) return;
      const events = await stub.recordPush(repo.name, identity, accepted);
      if (!events.length) return;
      await stub.publishRepoEvents(repo.name, events, identity);
      await withBases(env, repo, events);
      await stub.enqueue(events, origin);
    })().catch((err) => console.error("recording a push failed:", err instanceof Error ? err.message : String(err))),
  );
  return relay(res, toClient);
}

/** Fill in each event's merge base with the default branch, best effort. */
async function withBases(env: Env, repo: RepoRecord, events: RepoEvent[]): Promise<void> {
  const main = (await listRefs(env, repo)).get(`refs/heads/${repo.default_branch}`);
  if (!main) return;
  await Promise.all(
    events.map(async (e) => {
      if (e.head === ZERO || e.branch === repo.default_branch) return;
      try {
        e.base = (await compare(env, repo.artifacts_name, main, e.head)).mergeBase;
      } catch {
        e.base = null;
      }
    }),
  );
}
