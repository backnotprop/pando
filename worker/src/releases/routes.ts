// Builds of main, tags and releases (research/plans/releases-2026-10-04), members only, under
// /v1/monorepos/{owner}/{name}/repos/{repo}:
//   GET    /summary                       main's commit, its checks (or not built), the newest build on main, the latest release
//   GET    /tags                          tags, newest first
//   GET    /releases                      releases, newest first, 30 a page (?limit, ?cursor)
//   POST   /releases                      {tag, target?, title?, notes?, generate_notes?, draft?, force?}
//   GET    /releases/{tag}                one release (`latest`: the newest published), with its commit's checks
//   PATCH  /releases/{tag}                {title?, notes?}
//   DELETE /releases/{tag}                the release goes; its tag stays and is free again
//   POST   /releases/{tag}/publish        {force?}: refused on red or missing required checks unless forced, as merge is
//   GET    /releases/{tag}/notes          its notes; ?generate=1 writes them from the merges since the last release
//   PUT    /releases/{tag}/files/{name}   a file (at most 100 MB, 20 a release), its sha256 kept; the bytes go to R2 (BLOBS)
//   GET    /releases/{tag}/files/{name}   download it (`latest` works); without signing in when the project's switch
//                                        "Anyone can download releases" is on (only release files, never code)
//   DELETE /releases/{tag}/files/{name}
//   POST   /deployments                   {environment, sha, state?, release?, url?, description?}: a deploy recorded
//   GET    /deployments                   newest first (?environment, ?limit)
// Anyone who may merge may publish (the owner's rule, as with merging). Git reads happen here; the monorepo object
// keeps the records (releases/store.ts).
import type { Context, Hono } from "hono";
import type * as Contract from "@pando/contract";
import type { Env } from "../env";
import { HttpError } from "../http";
import { deletePrefix, putHashed } from "../hashput";
import type { ApiVars } from "../monorepo/api";
import { branchesOf, listRefs, tagCommits, withRepo } from "../monorepo/artifacts";
import { buildState, combine, requiredKept } from "../monorepo/checks";
import { commitReader, compareWith } from "../monorepo/graph";
import { isSha, validBranchName, ZERO } from "../monorepo/names";
import { cachedRepo, monorepoStub } from "../monorepo/session";
import { accounts } from "../accounts/auth";
import { monorepoRef } from "../monorepo/names";
import type { Checks, Outcome, RepoRecord } from "../monorepo/types";
import { isRecord, isText, type Json, type JsonObject } from "../parse";
import { NOTES_MAX } from "./notes";
import { FILE_MAX_BYTES, filesPrefix, RELEASES_PAGE, RELEASES_PAGE_MAX, type FileFound, type ReleaseView } from "./store";

type C = Context<{ Bindings: Env; Variables: ApiVars }>;

const BASE = "/v1/monorepos/:o/:m/repos/:r";

/** A release's title, in characters. */
const TITLE_MAX = 200;

function unwrap<T>(o: Outcome<T>): T {
  if (o.ok) return o.value;
  throw new HttpError(o.status, o.code, o.message, o.extra ?? {});
}

function bad(message: string): never {
  throw new HttpError(400, "bad_request", message);
}

async function bodyOf(c: C): Promise<JsonObject> {
  const b = await c.req.json<Json>().catch(() => bad("the body must be JSON"));

  return isRecord(b) ? b : bad("the body must be a JSON object");
}

function text(v: Json | undefined, field: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;

  if (!isText(v)) bad(`${field} must be a string`);

  if (v.length > max) throw new HttpError(max >= NOTES_MAX ? 413 : 400, max >= NOTES_MAX ? "too_large" : "bad_request", `${field}: at most ${max.toLocaleString("en-US")} characters`);

  return v;
}

function flag(v: Json | undefined, field: string): boolean {
  if (v === undefined || v === null) return false;

  if (v !== true && v !== false) bad(`${field} is true or false`);

  return v;
}

async function repoOf(c: C): Promise<RepoRecord> {
  const r = await cachedRepo(c.env, c.get("m"), c.req.param("r")!);

  if (!r) throw new HttpError(404, "not_found", `no repo ${c.req.param("r")}`);

  return r;
}

/** Main's head as recorded; a repo made before Pando kept heads is read once from Artifacts and kept. */
async function mainOf(c: C, r: RepoRecord): Promise<string | null> {
  const stub = c.get("stub");
  const kept = await stub.currentMain(r.name);

  if (kept) return kept;
  const sha = branchesOf(await listRefs(c.env, r).catch(() => new Map<string, string>())).get(r.default_branch) ?? null;

  if (sha) await stub.rememberHead(r.name, sha);

  return sha;
}

/** A commit's checks by the merge gate's rule: the required list from pando.toml, the latest status per context. */
async function checksOf(c: C, r: RepoRecord, sha: string): Promise<Checks> {
  return combine(sha, await requiredKept(c.env, c.get("info"), r), await c.get("stub").statuses(r.name, sha));
}

/** Whether `sha` is on main: main's head, or one of its ancestors. */
async function onMain(c: C, r: RepoRecord, main: string, sha: string): Promise<boolean> {
  if (sha === main) return true;

  return withRepo(c.env, r.artifacts_name, async (repo) => {
    if (!(await repo.readCommit(sha))) return false;

    return (await compareWith(commitReader(repo), main, sha)).mergeBase === sha;
  });
}

/**
 * A tag's commit as Pando knows it: recorded by the door, or (a tag pushed
 * before Pando recorded tags, or whose peel failed) read from Artifacts once
 * and recorded. Null when there is no such tag.
 */
async function tagCommit(c: C, r: RepoRecord, tag: string): Promise<string | null> {
  const stub = c.get("stub");
  const recorded = await stub.tagGet(r.name, tag);

  if (recorded?.sha) return recorded.sha;
  const found = (await tagCommits(c.env, r)).get(tag);

  if (!found) return null;

  if (recorded) await stub.tagSetCommits(r.name, { [tag]: found.commit });
  else await stub.recordTags(r.name, null, [{ old: ZERO, new: found.object, ref: `refs/tags/${tag}` }], { [tag]: found.commit }, new URL(c.req.url).origin);

  return found.commit;
}

/** The release in the path; on reads, `latest` is the newest published one. */
async function releaseOf(c: C, r: RepoRecord, latest = false): Promise<ReleaseView> {
  const tag = c.req.param("tag")!;
  const stub = c.get("stub");
  const rel = latest && tag === "latest" ? await stub.releaseLatest(r.name) : await stub.releaseGet(r.name, tag);

  return rel ?? (tag === "latest" ? fail404(`${r.name} has no published release yet`) : fail404(`no release ${tag}`));
}

function fail404(message: string): never {
  throw new HttpError(404, "not_found", message);
}

/** The release gate, the merge gate's rule: the commit's required checks green, else refused unless forced. */
async function gate(c: C, r: RepoRecord, sha: string, force: boolean): Promise<Checks> {
  const checks = await checksOf(c, r, sha);

  if (checks.state !== "success" && !force) {
    throw new HttpError(412, "checks_not_green", `checks are ${checks.state} on ${sha.slice(0, 12)}; wait, or publish with force`, { checks });
  }

  return checks;
}

/**
 * Publish a draft: its commit's required checks green, unless forced (the
 * merge rule); its tag made at its commit when it does not exist, refused
 * when it names another commit. From then on the door keeps the tag where it is.
 */
async function publish(c: C, r: RepoRecord, rel: ReleaseView, force: boolean): Promise<ReleaseView> {
  const stub = c.get("stub");
  const checks = await gate(c, r, rel.sha, force);

  const at = await tagCommit(c, r, rel.tag);

  if (at !== null && at !== rel.sha) throw new HttpError(409, "tag_exists", `tag ${rel.tag} names ${at.slice(0, 12)}, not this release's ${rel.sha.slice(0, 12)}`);

  if (at === null) {
    const ref = `refs/tags/${rel.tag}`;
    // Through the repo's write gate, as a branch made by the API is.
    const reason = unwrap(await stub.updateRefsQueued(r.name, [{ old: ZERO, new: rel.sha, ref }]))[ref];

    if (reason !== null) throw new HttpError(409, "tag_not_created", `Artifacts refused tag ${rel.tag}: ${reason ?? "no report"}`);
    await stub.recordTags(r.name, c.get("identity"), [{ old: ZERO, new: rel.sha, ref }], { [rel.tag]: rel.sha }, new URL(c.req.url).origin);
  }

  return unwrap(await stub.releasePublish(r.name, rel.tag, checks.state !== "success", c.get("identity")));
}

/** A release as the API answers it: with its commit's checks when asked for one. */
function answer(rel: ReleaseView, checks: Checks | null = null) {
  return checks ? { ...rel, checks } : rel;
}

type Api = Hono<{ Bindings: Env; Variables: ApiVars }>;

/** A release file's name: letters, digits, '.', '_', '+' and '-', starting with a letter or digit, at most 200 characters. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;

/** A file's bytes from R2, as a download. */
async function serveFile(env: Env, found: FileFound, isPublic: boolean): Promise<Response> {
  const obj = await env.BLOBS.get(found.key);

  if (!obj) fail404(`${found.file.name}'s bytes are missing; upload it again`);

  return new Response(obj.body, {
    headers: {
      "content-type": found.file.content_type,
      "content-length": String(found.file.size),
      "content-disposition": `attachment; filename="${found.file.name}"`,
      "x-pando-sha256": found.file.sha256,
      etag: `"${found.file.sha256}"`,
      "cache-control": isPublic ? "public, max-age=60" : "private, no-cache",
    },
  });
}

/**
 * Release file downloads without signing in, registered before the members-only check (monorepo/api.ts): when the
 * project's switch "Anyone can download releases" is on, the file is served to anyone; otherwise the request goes
 * on to the members-only route. Only release files: never code, never other routes.
 */
export function publicFileRoutes(api: Api): void {
  api.get(`${BASE}/releases/:tag/files/:name`, async (c, next) => {
    const ref = monorepoRef(c.req.param("o"), c.req.param("m"));
    const info = ref ? await accounts(c.env).resolve(ref) : null;
    const r = info ? await cachedRepo(c.env, info.id, c.req.param("r")!) : null;

    if (!info || !r) return next();
    const got = await monorepoStub(c.env, info.id).publicReleaseFile(r.name, c.req.param("tag")!, c.req.param("name")!);

    if (!got.allowed) return next();

    return got.found ? serveFile(c.env, got.found, true) : fail404(`no file ${c.req.param("name")} in ${c.req.param("tag")}`);
  });
}

/** A project's summary (main's build state, the newest build on main, the latest release) and its tags. */
export function tagRoutes(api: Api): void {
  api.get(`${BASE}/summary`, async (c) => {
    const r = await repoOf(c);
    const sha = await mainOf(c, r);
    const s = (await c.get("stub").mainSummary(r.name)) ?? fail404(`no repo ${r.name}`);
    const checks = sha ? await checksOf(c, r, sha) : null;
    const latest = s.latest_release;

    return c.json({
      repo: r.name,
      main: { branch: s.branch, sha, title: sha === s.sha ? s.title : null, state: checks ? buildState(checks) : "not_built", checks, build: s.build },
      latest_release: latest ? { tag: latest.tag, title: latest.title, sha: latest.sha, published_at: latest.published_at!, published_by: latest.published_by! } : null,
    } satisfies typeof Contract.RepoSummary.Encoded);
  });

  api.get(`${BASE}/tags`, async (c) => {
    const r = await repoOf(c);
    const stub = c.get("stub");
    let tags = await stub.tagList(r.name);

    // A tag recorded without its commit (the door's read failed): read them once here.
    if (tags.some((t) => t.sha === null)) {
      const found = await tagCommits(c.env, r).catch(() => null);

      if (found) {
        await stub.tagSetCommits(r.name, Object.fromEntries(tags.flatMap((t) => (t.sha === null && found.has(t.name) ? [[t.name, found.get(t.name)!.commit]] : []))));
        tags = await stub.tagList(r.name);
      }
    }

    return c.json({ tags } satisfies typeof Contract.TagList.Encoded);
  });
}

/** Releases: made, edited, published (checks green unless forced), deleted, and their notes. */
export function releaseRoutes(api: Api): void {

  api.get(`${BASE}/releases`, async (c) => {
    const r = await repoOf(c);
    const limit = Number(c.req.query("limit") ?? RELEASES_PAGE);

    if (!Number.isInteger(limit) || limit < 1 || limit > RELEASES_PAGE_MAX) bad(`limit is 1 to ${RELEASES_PAGE_MAX}`);

    return c.json(unwrap(await c.get("stub").releaseList(r.name, limit, c.req.query("cursor") ?? null)) satisfies typeof Contract.ReleaseList.Encoded);
  });

  api.post(`${BASE}/releases`, async (c) => {
    const r = await repoOf(c);
    const b = await bodyOf(c);
    const tag = b.tag;

    if (!validBranchName(tag)) bad("tag: a git tag name such as v0.1.0");

    if (tag === "latest") bad("tag: latest names the newest release in addresses; pick another name");
    const target = text(b.target, "target", 200);
    const title = text(b.title, "title", TITLE_MAX)?.trim() || tag;
    let notes = text(b.notes, "notes", NOTES_MAX) ?? "";
    const draft = flag(b.draft, "draft");
    const force = flag(b.force, "force");
    const stub = c.get("stub");

    if (await stub.releaseGet(r.name, tag)) throw new HttpError(409, "release_exists", `${tag} has a release already`);
    const main = (await mainOf(c, r)) ?? throw409("no_main", `${r.default_branch} does not exist yet`);
    const tagged = await tagCommit(c, r, tag);
    let sha: string;

    if (target === undefined || target === r.default_branch) sha = tagged ?? main;
    else if (isSha(target)) sha = target;
    else bad(`target: a commit on ${r.default_branch} (its full sha), or ${r.default_branch}`);

    if (tagged !== null && tagged !== sha) throw new HttpError(409, "tag_exists", `tag ${tag} names ${tagged.slice(0, 12)}, not ${sha.slice(0, 12)}; leave out target to release the tag's commit`);

    if (!(await onMain(c, r, main, sha))) throw new HttpError(422, "not_on_main", `${sha.slice(0, 12)} is not on ${r.default_branch}; a release is made from ${r.default_branch}`);

    // Published at once: refused before anything is made when its checks are not green (no draft is left behind).
    if (!draft) await gate(c, r, sha, force);

    if (flag(b.generate_notes, "generate_notes")) {
      const generated = (await stub.releaseNotes(r.name, sha, tag)).markdown;
      notes = notes ? `${notes}\n\n${generated}` : generated;
    }

    let rel = unwrap(await stub.releaseCreate(r.name, { tag, sha, title, notes: notes.slice(0, NOTES_MAX) }, c.get("identity")));

    if (!draft) rel = await publish(c, r, rel, force);

    return c.json(rel satisfies typeof Contract.Release.Encoded, 201);
  });

  api.get(`${BASE}/releases/:tag`, async (c) => {
    const r = await repoOf(c);
    const rel = await releaseOf(c, r, true);

    return c.json(answer(rel, await checksOf(c, r, rel.sha)) satisfies typeof Contract.Release.Encoded);
  });

  api.patch(`${BASE}/releases/:tag`, async (c) => {
    const r = await repoOf(c);
    const rel = await releaseOf(c, r);
    const b = await bodyOf(c);
    const title = text(b.title, "title", TITLE_MAX)?.trim();
    const notes = text(b.notes, "notes", NOTES_MAX);

    if (title === undefined && notes === undefined) bad("nothing to change: send title or notes");

    if (title === "") bad("title can't be empty");

    return c.json(unwrap(await c.get("stub").releaseUpdate(r.name, rel.tag, { title, notes }, c.get("identity"))) satisfies typeof Contract.Release.Encoded);
  });

  api.delete(`${BASE}/releases/:tag`, async (c) => {
    const r = await repoOf(c);
    const rel = await releaseOf(c, r);
    const id = unwrap(await c.get("stub").releaseDelete(r.name, rel.tag, c.get("identity")));
    // Its files' bytes: the record is gone, so a failure here leaves only unreachable bytes behind.
    await deletePrefix(c.env.BLOBS, filesPrefix(c.get("m"), r.name, id)).catch((err) => console.warn(`release ${rel.tag}: its files' bytes not deleted: ${err instanceof Error ? err.message : String(err)}`));

    return c.body(null, 204);
  });

  api.put(`${BASE}/releases/:tag/files/:name`, async (c) => {
    const r = await repoOf(c);
    const tag = c.req.param("tag");
    const name = c.req.param("name");

    if (!FILE_NAME.test(name)) bad("a file's name: letters, digits, '.', '_', '+' and '-', starting with a letter or digit, at most 200 characters");
    const sent = c.req.header("content-length");
    const size = Number(sent);

    if (!sent || !Number.isSafeInteger(size) || size < 0) throw new HttpError(411, "length_required", "send Content-Length: the file's size in bytes");

    if (size > FILE_MAX_BYTES) throw new HttpError(413, "too_large", `a release file is at most ${FILE_MAX_BYTES.toLocaleString("en-US")} bytes (100 MB, the most one upload to Pando can carry)`);
    const stub = c.get("stub");
    const slot = unwrap(await stub.releaseFileSlot(r.name, tag, name));
    const key = `${filesPrefix(c.get("m"), r.name, slot.release_id)}${name}`;
    const contentType = (c.req.header("content-type") ?? "").slice(0, 100) || "application/octet-stream";
    const sha256 = await putHashed(c.env.BLOBS, key, c.req.raw.body ?? new Blob([]).stream(), size, contentType);
    const expected = c.req.header("x-pando-sha256")?.toLowerCase();

    if (expected && expected !== sha256) {
      await c.env.BLOBS.delete(key);
      throw new HttpError(422, "sha256_mismatch", `the file's SHA-256 is ${sha256}, not ${expected}; it was not kept`);
    }

    const out = await stub.releaseFileAdd(r.name, tag, slot.release_id, { name, size, sha256, content_type: contentType }, c.get("identity"));

    // Not recorded (the release went, or filled up meanwhile): its bytes go too, unless they replaced a file still recorded.
    if (!out.ok && (!slot.replacing || out.code === "not_found")) await c.env.BLOBS.delete(key);

    return c.json(unwrap(out) satisfies typeof Contract.Release.Encoded, slot.replacing ? 200 : 201);
  });

  api.get(`${BASE}/releases/:tag/files/:name`, async (c) => {
    const r = await repoOf(c);
    const found = (await c.get("stub").releaseFile(r.name, c.req.param("tag"), c.req.param("name"))) ?? fail404(`no file ${c.req.param("name")} in ${c.req.param("tag")}`);

    return serveFile(c.env, found, false);
  });

  api.delete(`${BASE}/releases/:tag/files/:name`, async (c) => {
    const r = await repoOf(c);
    const key = unwrap(await c.get("stub").releaseFileDelete(r.name, c.req.param("tag"), c.req.param("name"), c.get("identity")));
    await c.env.BLOBS.delete(key);

    return c.body(null, 204);
  });

  api.post(`${BASE}/releases/:tag/publish`, async (c) => {
    const r = await repoOf(c);
    const rel = await releaseOf(c, r);
    // The body is optional here: none publishes without force.
    const b: JsonObject = c.req.header("content-length") === "0" || !c.req.header("content-type") ? {} : await bodyOf(c);

    if (!rel.draft) throw new HttpError(409, "published", `${rel.tag} is published already`);

    return c.json((await publish(c, r, rel, flag(b.force, "force"))) satisfies typeof Contract.Release.Encoded);
  });

  api.get(`${BASE}/releases/:tag/notes`, async (c) => {
    const r = await repoOf(c);
    const tag = c.req.param("tag");
    const stub = c.get("stub");
    const rel = tag === "latest" ? await stub.releaseLatest(r.name) : await stub.releaseGet(r.name, tag);

    if (!c.req.query("generate")) {
      if (!rel) fail404(`no release ${tag}`);

      return c.json({ tag: rel.tag, sha: rel.sha, markdown: rel.notes, generated: false, merges: null, more: null, since: null } satisfies typeof Contract.ReleaseNotes.Encoded);
    }

    // Generated for a release, a tag, or (neither yet) the commit the release would get: ?target, else main.
    const target = c.req.query("target");
    const main = (await mainOf(c, r)) ?? throw409("no_main", `${r.default_branch} does not exist yet`);
    const sha = rel?.sha ?? (await tagCommit(c, r, tag)) ?? (target && isSha(target) ? target : main);
    const g = await stub.releaseNotes(r.name, sha, rel?.tag ?? tag);

    return c.json({ tag: rel?.tag ?? tag, sha, markdown: g.markdown, generated: true, merges: g.merges, more: g.more, since: g.since } satisfies typeof Contract.ReleaseNotes.Encoded);
  });
}

function throw409(code: string, message: string): never {
  throw new HttpError(409, code, message);
}

/** An environment's name: pando-dev, production, staging-eu. */
const ENVIRONMENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const DEPLOY_STATES = ["in_progress", "success", "failure"] as const;

/** Deployments, recorded only: the CI (or a deploy script) deploys, then tells Pando which commit reached where. */
export function deploymentRoutes(api: Api): void {
  api.post(`${BASE}/deployments`, async (c) => {
    const r = await repoOf(c);
    const b = await bodyOf(c);
    const environment = b.environment;
    const sha = b.sha;

    if (!isText(environment) || !ENVIRONMENT.test(environment)) bad("environment: a name such as pando-dev or production (a-z, 0-9, '.', '_', '-'; at most 64)");

    if (!isText(sha) || !isSha(sha)) bad("sha: the full 40-character commit deployed");
    const state = b.state ?? "success";

    if (!DEPLOY_STATES.some((s) => s === state)) bad("state is in_progress, success or failure");
    const release = text(b.release, "release", 200) ?? null;
    const url = text(b.url, "url", 2000) ?? null;

    if (url !== null && !/^https?:\/\//.test(url)) bad("url must be http(s)");
    const d = { environment, sha, release, state: DEPLOY_STATES.find((s) => s === state)!, url, description: text(b.description, "description", 1000) ?? null };

    return c.json(unwrap(await c.get("stub").deploymentAdd(r.name, d, c.get("identity"))) satisfies typeof Contract.Deployment.Encoded, 201);
  });

  api.get(`${BASE}/deployments`, async (c) => {
    const r = await repoOf(c);
    const limit = Number(c.req.query("limit") ?? RELEASES_PAGE);

    if (!Number.isInteger(limit) || limit < 1 || limit > RELEASES_PAGE_MAX) bad(`limit is 1 to ${RELEASES_PAGE_MAX}`);

    return c.json({ deployments: await c.get("stub").deploymentList(r.name, c.req.query("environment") ?? null, limit) } satisfies typeof Contract.DeploymentList.Encoded);
  });
}
