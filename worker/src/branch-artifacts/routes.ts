// Artifacts on a branch's page and their comments (research/plans/artifacts-2026-10-12/SPEC.md), members only,
// under /v1/monorepos/{owner}/{name}:
//   GET    /repos/{repo}/branches/{branch}/artifacts            the branch's artifacts
//   POST   /repos/{repo}/branches/{branch}/artifacts            multipart: `file`, and `image` fields named by their path
//   GET    /repos/{repo}/branches/{branch}/artifact-comments    every artifact's threads on the branch (?state=)
//   GET    /artifacts/{id}                                       one, with every version
//   DELETE /artifacts/{id}                                       any member; every version, its bytes and comments
//   GET    /artifacts/{id}/versions/{n}/files/{path}             a file's bytes, sandboxed
//   GET    /artifacts/{id}/versions/{n}/document                 the document, its images written in as data: addresses
//   GET    /artifacts/{id}/comments                              its threads (?state=open|resolved)
//   POST   /artifacts/{id}/comments                              a thread or a reply (Idempotency-Key)
//   GET    /artifact-comments/{id}                               one comment, whole
//   PATCH  /artifact-comments/{id}                               {body, base_version?} your own, or {state} any member
//   DELETE /artifact-comments/{id}                               your own
// The Worker checks requests and moves the bytes (R2, BLOBS); the monorepo object keeps the rows.
import type { Context, Hono } from "hono";
import type * as Contract from "@pando/contract";
import { accounts } from "../accounts/auth";
import type { Env } from "../env";
import { deletePrefix, putBytes } from "../hashput";
import { HttpError } from "../http";
import type { ApiVars } from "../monorepo/api";
import type { Identity, Outcome, RepoRecord } from "../monorepo/types";
import { isRecord, isText, isWholeNumber, type Json, type JsonObject } from "../parse";
import type { ArtifactKind, FileEntry, VersionFound } from "./store";

type C = Context<{ Bindings: Env; Variables: ApiVars }>;

type Api = Hono<{ Bindings: Env; Variables: ApiVars }>;

/** One artifact, all its files: its images are written into an HTML page as one string (a third larger as data:). */
export const ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;

/** Its document (Markdown or HTML): the largest text Pando's shared files carry live; the viewer renders it at once. */
export const DOCUMENT_MAX_BYTES = 1.5 * 1024 * 1024;

/** Files in one artifact: a document and its images. */
export const FILES_MAX = 20;

/** A comment, in characters (as an issue comment). */
export const BODY_MAX = 65_536;

/** One anchor, in bytes of JSON, and its extra HTML elements: Plannotator's own caps (DEFAULT_HTML_ANCHOR_MAX_BYTES). */
export const ANCHOR_MAX_BYTES = 16_384;

const ANCHOR_TARGETS_MAX = 16;

/** People named in one comment (as an issue's assignees). */
export const MENTIONS_MAX = 10;

const TITLE_MAX = 200;

const KEY_MAX = 64;

/** A file's name, or one part of an image's path: letters, digits, '.', '_', '+' and '-', starting with a letter or digit (as release files). */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

const PATH_MAX = 200;

interface FileType {
  kind: ArtifactKind;
  type: string;
}

const MARKDOWN: FileType = { kind: "markdown", type: "text/markdown; charset=utf-8" };

const HTML: FileType = { kind: "html", type: "text/html; charset=utf-8" };

const TYPES = new Map<string, FileType>([
  ["md", MARKDOWN], ["markdown", MARKDOWN], ["html", HTML], ["htm", HTML],
  ["png", { kind: "image", type: "image/png" }], ["jpg", { kind: "image", type: "image/jpeg" }], ["jpeg", { kind: "image", type: "image/jpeg" }],
  ["gif", { kind: "image", type: "image/gif" }], ["webp", { kind: "image", type: "image/webp" }], ["svg", { kind: "image", type: "image/svg+xml" }],
]);

const ANCHOR_TYPES = ["COMMENT", "DELETION", "GLOBAL_COMMENT"];

function unwrap<T>(o: Outcome<T>): T {
  if (o.ok) return o.value;
  throw new HttpError(o.status, o.code, o.message, o.extra ?? {});
}

function bad(message: string, code = "bad_request"): never {
  throw new HttpError(400, code, message);
}

function notFound(message: string): never {
  throw new HttpError(404, "not_found", message);
}

/** Rounded up to a tenth, so a size just over a limit never reads as the limit. */
function mib(bytes: number): string {
  return `${(Math.ceil((bytes / 1024 / 1024) * 10) / 10).toString()} MiB`;
}

/** Where the person acted from: "web" for the browser, else the machine's credential name. */
function machineOf(by: Identity): string | null {
  return by.credential_kind === "browser" ? "web" : by.credential_name;
}

function typeOf(path: string): FileType | null {
  const dot = path.lastIndexOf(".");

  return dot < 0 ? null : (TYPES.get(path.slice(dot + 1).toLowerCase()) ?? null);
}

function validPath(path: string): boolean {
  return path.length <= PATH_MAX && path.split("/").every((part) => NAME.test(part) && part !== "." && part !== "..");
}

/** The document's first heading (Markdown) or its <title> (HTML), at most 200 characters. */
function titleOf(kind: ArtifactKind, text: string): string | null {
  const found = kind === "markdown" ? /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(text)?.[1] : kind === "html" ? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1] : undefined;

  if (!found) return null;

  const plain = found
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

  return plain ? [...plain].slice(0, TITLE_MAX).join("") : null;
}

async function bodyOf(c: C): Promise<JsonObject> {
  const b = await c.req.json<Json>().catch(() => bad("the body must be JSON"));

  return isRecord(b) ? b : bad("the body must be a JSON object");
}

function keyOf(c: C): string | null {
  const k = c.req.header("idempotency-key") ?? null;

  if (k !== null && (!k || k.length > KEY_MAX)) bad(`Idempotency-Key: 1 to ${KEY_MAX} characters`);

  return k;
}

function commentBody(v: Json | undefined): string {
  if (!isText(v) || !v.trim()) bad("body: the comment, as Markdown");

  if (v.length > BODY_MAX) throw new HttpError(413, "too_large", `body: at most ${BODY_MAX.toLocaleString("en-US")} characters`);

  return v;
}

function stateQuery(c: C): "open" | "resolved" | null {
  const s = c.req.query("state") ?? "all";

  if (s !== "open" && s !== "resolved" && s !== "all") bad("state: open, resolved or all");

  return s === "all" ? null : s;
}

/** Members named with @login in a comment, each once; at most MENTIONS_MAX. Words that name no member are left alone. */
async function mentionsOf(c: C, body: string): Promise<string[]> {
  const named = [...new Set([...body.matchAll(/(?:^|[^A-Za-z0-9_.`/-])@([a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38})(?![A-Za-z0-9_-])/g)].map((m) => m[1]!))];

  if (!named.length) return [];
  const members = new Set((await accounts(c.env).members(c.get("m"))).map((m) => m.login));
  const out = named.filter((l) => members.has(l));

  if (out.length > MENTIONS_MAX) bad(`a comment names at most ${MENTIONS_MAX} people; this one names ${out.length}`, "too_many_mentions");

  return out;
}

/**
 * A root's anchor, as JSON text: Plannotator's (checked for size and shape, never read further), or a plain quote
 * stored as Plannotator's external annotation (blockId `external`, offsets 0: the browser places it by text).
 */
function anchorOf(b: JsonObject): string | null {
  if (b.anchor !== undefined && b.anchor !== null && b.quote !== undefined && b.quote !== null) bad("send anchor or quote, not both");

  if (b.quote !== undefined && b.quote !== null) {
    if (!isText(b.quote) || !b.quote.trim()) bad("quote: the words the comment is on");
    b = { anchor: { type: "COMMENT", originalText: b.quote, blockId: "external", startOffset: 0, endOffset: 0 } };
  }

  const a = b.anchor;

  if (a === undefined || a === null) return null;

  if (!isRecord(a)) bad("anchor: Plannotator's annotation fields, as a JSON object");
  const text = JSON.stringify(a);

  if (new TextEncoder().encode(text).length > ANCHOR_MAX_BYTES) throw new HttpError(413, "too_large", `anchor: at most ${ANCHOR_MAX_BYTES.toLocaleString("en-US")} bytes`);

  if (a.type !== undefined && !ANCHOR_TYPES.some((t) => t === a.type)) bad(`anchor.type: ${ANCHOR_TYPES.join(", ")}`);

  if (a.originalText !== undefined && !isText(a.originalText)) bad("anchor.originalText must be a string");

  if (a.htmlAnchor !== undefined && !(isRecord(a.htmlAnchor) && isText(a.htmlAnchor.selector) && isText(a.htmlAnchor.tagName))) bad("anchor.htmlAnchor: {selector, tagName, ...}");

  if (a.htmlAdditionalTargets !== undefined && !(Array.isArray(a.htmlAdditionalTargets) && a.htmlAdditionalTargets.length <= ANCHOR_TARGETS_MAX)) {
    bad(`anchor.htmlAdditionalTargets: a list of at most ${ANCHOR_TARGETS_MAX}`);
  }

  return text;
}

// ── Upload ───────────────────────────────────────────────────────────────

interface Upload {
  blob: File;
  path: string;
  type: string;
}

/** The multipart body checked whole before any byte goes to R2: names, kinds, the counts and sizes. */
async function uploadOf(c: C): Promise<{ name: string; kind: ArtifactKind; files: Upload[] }> {
  const sent = c.req.header("content-length");
  const length = Number(sent);

  if (!sent || !Number.isSafeInteger(length)) throw new HttpError(411, "length_required", "send Content-Length");

  // The multipart framing on top of the files: a few hundred bytes each.
  if (length > ARTIFACT_MAX_BYTES + 64 * 1024) throw new HttpError(413, "too_large", `an artifact is at most ${mib(ARTIFACT_MAX_BYTES)} in all; this upload is ${mib(length)}`);
  const form = await c.req.raw.formData().catch(() => bad("send multipart/form-data: a `file` field, and an `image` field for each image it uses"));
  const mains = form.getAll("file");
  const images = form.getAll("image");

  const main = mains.length === 1 && mains[0] instanceof File ? mains[0] : bad("send one `file`: the Markdown or HTML document, or an image");
  const name = main.name;

  if (!NAME.test(name) || name.length > PATH_MAX) bad("the file's name: letters, digits, '.', '_', '+' and '-', starting with a letter or digit, at most 200 characters");
  const mainType = typeOf(name) ?? bad("an artifact is a .md or .markdown file, an .html or .htm file, or a .png, .jpg, .gif, .webp or .svg image");

  if (mainType.kind === "image" && images.length) bad("an image artifact is the image alone; send its images with a Markdown or HTML document");

  if (1 + images.length > FILES_MAX) bad(`an artifact has at most ${FILES_MAX} files (a document and its images); this one has ${1 + images.length}`, "too_many_files");

  if (main.size === 0) bad(`${name} is empty`);

  if (mainType.kind !== "image" && main.size > DOCUMENT_MAX_BYTES) throw new HttpError(413, "too_large", `a document is at most ${mib(DOCUMENT_MAX_BYTES)}; ${name} is ${mib(main.size)}`);
  const files: Upload[] = [{ blob: main, path: name, type: mainType.type }];

  for (const img of images) {
    if (!(img instanceof File)) bad("each `image` field is a file, named by its path from the document (img/hero.png)");
    const path = img.name.replace(/^\.\//, "");

    if (!validPath(path)) bad(`${img.name}: an image's path is parts of letters, digits, '.', '_', '+' and '-', separated by '/', at most 200 characters, never '..'`);

    if (typeOf(path)?.kind !== "image") bad(`${path}: an artifact's other files are its images (.png, .jpg, .gif, .webp or .svg)`);

    if (files.some((f) => f.path === path)) bad(`${path} is sent twice`);
    files.push({ blob: img, path, type: typeOf(path)!.type });
  }

  const total = files.reduce((sum, f) => sum + f.blob.size, 0);

  if (total > ARTIFACT_MAX_BYTES) throw new HttpError(413, "too_large", `an artifact is at most ${mib(ARTIFACT_MAX_BYTES)} in all; this one is ${mib(total)}`);
  // The document first, then its images by path.
  files.splice(1, files.length - 1, ...files.slice(1).sort((x, y) => (x.path < y.path ? -1 : 1)));

  return { name, kind: mainType.kind, files };
}

function uploadId(): string {
  return `up_${[...crypto.getRandomValues(new Uint8Array(8))].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

async function addArtifact(c: C, r: RepoRecord, branch: string): Promise<Response> {
  const up = await uploadOf(c);
  const stub = c.get("stub");
  const slot = unwrap(await stub.artifactSlot(r.name, branch, up.name));
  const prefix = `artifacts/${c.get("m")}/${r.name}/${slot.id}/${uploadId()}/`;
  const identity = c.get("identity");
  let recorded = false;

  try {
    const files: FileEntry[] = [];

    for (const f of up.files) {
      const sha256 = await putBytes(c.env.BLOBS, prefix + f.path, await f.blob.arrayBuffer(), f.type);
      files.push({ path: f.path, size: f.blob.size, sha256, type: f.type });
    }

    const title = up.kind === "image" ? null : titleOf(up.kind, await up.files[0]!.blob.text());
    const via = identity.credential_kind === "browser" ? "web" : "cli";
    const out = unwrap(await stub.artifactAddVersion(r.name, branch, { id: slot.id, branch_created_at: slot.branch_created_at, name: up.name, kind: up.kind, title, files, prefix, machine: machineOf(identity), via }, identity));
    recorded = true;

    return c.json(out.artifact satisfies typeof Contract.Artifact.Encoded, out.created ? 201 : 200);
  } finally {
    // Bytes of a version that was not recorded go.
    if (!recorded) await deletePrefix(c.env.BLOBS, prefix).catch((err) => console.warn(`artifact ${up.name}: unrecorded bytes not deleted: ${err instanceof Error ? err.message : String(err)}`));
  }
}

/** The branch routes, reached through the branch catch-all in monorepo/api.ts (a branch's name may hold '/'). */
export async function branchArtifacts(c: C, r: RepoRecord, branch: string, rest: "artifacts" | "artifact-comments"): Promise<Response> {
  const method = c.req.method;

  if (rest === "artifacts" && method === "GET") {
    const artifacts = unwrap(await c.get("stub").artifactList(r.name, branch));

    return c.json({ branch, artifacts, total: artifacts.length } satisfies typeof Contract.ArtifactList.Encoded);
  }

  if (rest === "artifacts" && method === "POST") return addArtifact(c, r, branch);

  if (rest === "artifact-comments" && method === "GET") {
    return c.json(unwrap(await c.get("stub").artifactBranchThreads(r.name, branch, stateQuery(c))) satisfies typeof Contract.ArtifactThreads.Encoded);
  }

  throw new HttpError(405, "method", "method not allowed");
}

// ── Reads ────────────────────────────────────────────────────────────────

/** Never run on Pando's address when opened directly (as raw files, monorepo/files.ts). */
const SANDBOX = { "content-security-policy": "sandbox; default-src 'none'", "x-content-type-options": "nosniff", "cache-control": "private, no-cache" };

async function versionOf(c: C): Promise<VersionFound> {
  const id = c.req.param("id")!;
  const n = Number(c.req.param("n"));

  if (!Number.isInteger(n) || n < 1) notFound(`no version ${c.req.param("n")} of ${id}`);

  return (await c.get("stub").artifactVersion(id, n)) ?? notFound(`no version ${n} of ${id}`);
}

async function bytesOf(c: C, v: VersionFound, f: FileEntry): Promise<R2ObjectBody> {
  return (await c.env.BLOBS.get(v.prefix + f.path)) ?? notFound(`${f.path}'s bytes are missing; upload the artifact again`);
}

function base64(bytes: Uint8Array): string {
  let s = "";

  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));

  return btoa(s);
}

/** Each of the version's images, where the document names it by its path (`img/a.png` or `./img/a.png`), as a data: address. */
async function inlineImages(c: C, v: VersionFound, text: string): Promise<string> {
  let out = text;

  for (const f of v.files.slice(1)) {
    const escaped = f.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const at = new RegExp(`(^|["'(\\s,=])(?:\\./)?${escaped}(?=["')\\s,>]|$)`, "gm");

    if (!at.test(out)) continue;
    const data = `data:${f.type};base64,${base64(new Uint8Array(await (await bytesOf(c, v, f)).arrayBuffer()))}`;
    out = out.replace(at, (_m, before: string) => before + data);
  }

  return out;
}

/** By id: one artifact, its files, its document, its comments; and comments by id. */
export function artifactRoutes(api: Api): void {
  const one = "/v1/monorepos/:o/:m/artifacts/:id";
  const comment = "/v1/monorepos/:o/:m/artifact-comments/:cid";

  api.get(one, async (c) => {
    const a = (await c.get("stub").artifactGet(c.req.param("id"))) ?? notFound(`no artifact ${c.req.param("id")}`);

    return c.json(a satisfies typeof Contract.ArtifactDetail.Encoded);
  });

  api.delete(one, async (c) => {
    const identity = c.get("identity");
    const prefixes = unwrap(await c.get("stub").artifactDelete(c.req.param("id"), identity, machineOf(identity)));

    // The rows are gone, so a failure here leaves only unreachable bytes behind.
    for (const p of prefixes) await deletePrefix(c.env.BLOBS, p).catch((err) => console.warn(`artifact ${c.req.param("id")}: bytes not deleted: ${err instanceof Error ? err.message : String(err)}`));

    return c.body(null, 204);
  });

  api.get(`${one}/versions/:n/files/*`, async (c) => {
    const v = await versionOf(c);
    const marker = `/versions/${c.req.param("n")}/files/`;
    const raw = new URL(c.req.url).pathname;
    let path: string;

    try {
      path = raw.slice(raw.indexOf(marker) + marker.length).split("/").map(decodeURIComponent).join("/");
    } catch {
      notFound("no such file");
    }

    const f = v.files.find((x) => x.path === path) ?? notFound(`v${c.req.param("n")} of ${v.artifact.name} has no file ${path}`);
    const obj = await bytesOf(c, v, f);

    return new Response(obj.body, { headers: { ...SANDBOX, "content-type": f.type, "content-length": String(f.size), "x-pando-sha256": f.sha256, etag: `"${f.sha256}"` } });
  });

  api.get(`${one}/versions/:n/document`, async (c) => {
    const v = await versionOf(c);
    const main = v.files[0] ?? notFound(`${v.artifact.name} has no files`);
    const obj = await bytesOf(c, v, main);

    if (v.artifact.kind === "image") return new Response(obj.body, { headers: { ...SANDBOX, "content-type": main.type, "content-length": String(main.size) } });

    return new Response(await inlineImages(c, v, await obj.text()), { headers: { ...SANDBOX, "content-type": main.type, "x-pando-sha256": main.sha256 } });
  });

  api.get(`${one}/comments`, async (c) => c.json(unwrap(await c.get("stub").artifactThreads(c.req.param("id"), stateQuery(c))) satisfies typeof Contract.ArtifactThreads.Encoded));

  api.post(`${one}/comments`, async (c) => {
    const b = await bodyOf(c);
    const body = commentBody(b.body);
    const inReplyTo = b.in_reply_to === undefined || b.in_reply_to === null ? null : isText(b.in_reply_to) ? b.in_reply_to : bad("in_reply_to: a comment's id");

    if (inReplyTo !== null && ((b.anchor ?? null) !== null || (b.quote ?? null) !== null)) bad("a reply takes no anchor or quote: it is on its thread");
    const version = b.version === undefined || b.version === null ? null : isWholeNumber(b.version) ? b.version : bad("version: the version it is on (1, 2, ...)");
    const identity = c.get("identity");
    const input = { version, anchor: inReplyTo === null ? anchorOf(b) : null, body, in_reply_to: inReplyTo, mentions: await mentionsOf(c, body), machine: machineOf(identity) };
    const out = unwrap(await c.get("stub").artifactComment(c.req.param("id"), input, identity, keyOf(c)));

    return c.json(out.comment satisfies typeof Contract.ArtifactComment.Encoded, out.replayed ? 200 : 201, out.replayed ? { "pando-replayed": "true" } : {});
  });

  api.get(comment, async (c) => c.json(((await c.get("stub").artifactGetComment(c.req.param("cid"))) ?? notFound(`no comment ${c.req.param("cid")}`)) satisfies typeof Contract.ArtifactComment.Encoded));

  api.patch(comment, async (c) => {
    const b = await bodyOf(c);
    const identity = c.get("identity");
    const id = c.req.param("cid");

    if ((b.state === undefined) === (b.body === undefined)) bad("send body (with base_version) to edit, or state (open or resolved), not both");

    if (b.state !== undefined) {
      if (b.state !== "open" && b.state !== "resolved") bad("state: open or resolved");

      return c.json(unwrap(await c.get("stub").artifactCommentState(id, b.state, identity, machineOf(identity))) satisfies typeof Contract.ArtifactComment.Encoded);
    }

    const body = commentBody(b.body);
    const base = b.base_version === undefined || b.base_version === null ? null : isWholeNumber(b.base_version) ? b.base_version : bad("base_version: the body_version you edited");

    return c.json(unwrap(await c.get("stub").artifactEditComment(id, body, await mentionsOf(c, body), base, identity, machineOf(identity))) satisfies typeof Contract.ArtifactComment.Encoded);
  });

  api.delete(comment, async (c) => {
    const identity = c.get("identity");
    unwrap(await c.get("stub").artifactDeleteComment(c.req.param("cid"), identity, machineOf(identity)));

    return c.body(null, 204);
  });
}
