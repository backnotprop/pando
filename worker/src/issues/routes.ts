// Issue and label routes (api-v1.yaml, tag issues), members only, under /v1/monorepos/{owner}/{name}:
//   GET    /issues                          a page, filters, counts
//   POST   /issues                          open one (Idempotency-Key)
//   GET    /issues/{n}                      one issue
//   PATCH  /issues/{n}                      edit, label, assign, link, close, reopen
//   GET    /issues/{n}/timeline             comments and events, oldest first (?cursor, ?last)
//   POST   /issues/{n}/comments             comment (Idempotency-Key)
//   GET    /issues/{n}/comments/{id}        one comment
//   PATCH  /issues/{n}/comments/{id}        edit your comment
//   DELETE /issues/{n}/comments/{id}        yours, or anyone's as an owner
//   PUT    /issues/{n}[/comments/{id}]/reactions/{content}   react
//   DELETE /issues/{n}[/comments/{id}]/reactions/{content}   take it back
//   GET    /labels                          labels with their open issues
//   POST   /labels, PATCH and DELETE /labels/{name}         owners
// Requests are checked here (and assignees against the monorepo's members); the monorepo object does the rest.
import type { Context, Hono } from "hono";
import type * as Contract from "@pando/contract";
import { accounts } from "../accounts/auth";
import type { Env } from "../env";
import { HttpError } from "../http";
import type { ApiVars } from "../monorepo/api";
import type { Outcome } from "../monorepo/types";
import { isOneOf, isRecord, isText, isTextList, isWholeNumber, type Json, type JsonObject } from "../parse";
import { BODY_MAX, REACTIONS, TITLE_MAX, type BranchRef, type IssueFilters, type IssuePatch, type LabelPatch, type ReactionContent } from "./store";

type C = Context<{ Bindings: Env; Variables: ApiVars }>;

const LIST_DEFAULT = 30;

const LIST_MAX = 100;

const TIMELINE_DEFAULT = 50;

const KEY_MAX = 64;

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

function numberOf(c: C): number {
  const n = c.req.param("n") ?? "";

  if (!/^[1-9][0-9]{0,8}$/.test(n)) throw new HttpError(404, "not_found", `no issue ${n}`);

  return Number(n);
}

function textField(v: Json | undefined, field: string, max: number): string {
  if (!isText(v)) bad(`${field} must be a string`);

  if (v.length > max) throw new HttpError(max >= BODY_MAX ? 413 : 400, max >= BODY_MAX ? "too_large" : "bad_request", `${field}: at most ${max} characters`);

  return v;
}

function listField(v: Json | undefined, field: string): string[] {
  if (v === undefined) return [];

  if (!isTextList(v)) bad(`${field} must be a list of strings`);

  return v;
}

function branchRefs(v: Json | undefined, field: string): BranchRef[] {
  if (v === undefined) return [];

  if (!Array.isArray(v)) bad(`${field} must be a list of {repo, branch}`);

  return v.map((x) => (isRecord(x) && isText(x.repo) && isText(x.branch) ? { repo: x.repo, branch: x.branch } : bad(`${field}: each one {repo, branch}`)));
}

function projectField(v: Json | undefined): string | null {
  if (v === null) return null;

  return isText(v) && v ? v : bad("project: a repo's name, or null");
}

/** The Idempotency-Key header, when sent. */
function keyOf(c: C): string | null {
  const k = c.req.header("idempotency-key") ?? null;

  if (k !== null && (!k || k.length > KEY_MAX)) bad(`Idempotency-Key: 1 to ${KEY_MAX} characters`);

  return k;
}

/** Logins as sent, `@me` taken as the caller; every one must be a member. */
async function members(c: C, logins: string[]): Promise<string[]> {
  const me = c.get("identity").login;
  const out = [...new Set(logins.map((l) => (l === "@me" ? me : l)))];

  if (!out.length) return out;
  const known = new Set((await accounts(c.env).members(c.get("m"))).map((m) => m.login));
  const strangers = out.filter((l) => !known.has(l));

  if (strangers.length) throw new HttpError(400, "not_a_member", `not a member of this monorepo: ${strangers.join(", ")}`);

  return out;
}

function reactionOf(c: C): ReactionContent {
  const content = c.req.param("content") ?? "";

  return isOneOf(REACTIONS, content) ? content : bad(`a reaction is one of ${REACTIONS.join(", ")}`);
}

function ownerOnly(c: C, what: string): void {
  if (c.get("identity").role !== "owner") throw new HttpError(403, "owner_only", `only an owner can ${what}`);
}

function filtersOf(c: C): IssueFilters {
  const q = (k: string) => c.req.query(k) ?? null;
  const me = c.get("identity").login;
  const state = q("state") ?? "open";

  if (state !== "open" && state !== "closed" && state !== "all") bad("state: open, closed or all");
  const sort = q("sort") ?? "created";

  if (sort !== "created" && sort !== "updated" && sort !== "comments") bad("sort: created, updated or comments");
  const order = q("order") ?? "desc";

  if (order !== "desc" && order !== "asc") bad("order: desc or asc");
  const limit = Number(q("limit") ?? LIST_DEFAULT);

  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX) bad(`limit: 1 to ${LIST_MAX}`);
  const linked = q("linked");
  const colon = linked?.indexOf(":") ?? -1;

  if (linked !== null && colon < 1) bad("linked: <repo>:<branch>");
  const at = (v: string | null) => (v === "@me" ? me : v);

  return {
    state,
    labels: (c.req.queries("label") ?? []).flatMap((l) => l.split(",")).map((l) => l.trim()).filter(Boolean),
    assignee: at(q("assignee")),
    author: at(q("author")),
    project: q("project"),
    linked: linked !== null ? { repo: linked.slice(0, colon), branch: linked.slice(colon + 1) } : null,
    q: q("q"),
    sort,
    order,
    cursor: q("cursor"),
    limit,
  };
}

async function patchOf(c: C, b: JsonObject): Promise<IssuePatch> {
  const p: IssuePatch = {};

  if (b.title !== undefined) p.title = textField(b.title, "title", TITLE_MAX);

  if (b.body !== undefined) p.body = textField(b.body, "body", BODY_MAX);

  if (b.base_version !== undefined) p.base_version = isWholeNumber(b.base_version) ? b.base_version : bad("base_version: the body_version you edited");

  if (b.project !== undefined) p.project = projectField(b.project);

  if (b.state !== undefined) p.state = b.state === "open" || b.state === "closed" ? b.state : bad("state: open or closed");

  if (b.state_reason !== undefined) p.state_reason = b.state_reason === "completed" || b.state_reason === "not_planned" ? b.state_reason : bad("state_reason: completed or not_planned");

  if (b.add_labels !== undefined) p.add_labels = listField(b.add_labels, "add_labels");

  if (b.remove_labels !== undefined) p.remove_labels = listField(b.remove_labels, "remove_labels");

  if (b.add_assignees !== undefined) p.add_assignees = await members(c, listField(b.add_assignees, "add_assignees"));

  if (b.remove_assignees !== undefined) p.remove_assignees = listField(b.remove_assignees, "remove_assignees").map((l) => (l === "@me" ? c.get("identity").login : l));

  if (b.link !== undefined) p.link = branchRefs(b.link, "link");

  if (b.unlink !== undefined) p.unlink = branchRefs(b.unlink, "unlink");

  return p;
}

export function issueRoutes(api: Hono<{ Bindings: Env; Variables: ApiVars }>): void {
  const base = "/v1/monorepos/:o/:m/issues";
  const one = `${base}/:n`;
  const comment = `${one}/comments/:id`;

  api.get(base, async (c) => c.json(unwrap(await c.get("stub").issueList(filtersOf(c))) satisfies typeof Contract.IssueList.Encoded));

  api.post(base, async (c) => {
    const b = await bodyOf(c);

    const input = {
      title: textField(b.title, "title", TITLE_MAX),
      body: b.body === undefined ? "" : textField(b.body, "body", BODY_MAX),
      labels: listField(b.labels, "labels"),
      assignees: await members(c, listField(b.assignees, "assignees")),
      project: b.project === undefined ? null : projectField(b.project),
      link: branchRefs(b.link, "link"),
    };

    const out = unwrap(await c.get("stub").issueCreate(input, c.get("identity"), keyOf(c)));

    return c.json(out.issue satisfies typeof Contract.Issue.Encoded, out.replayed ? 200 : 201, out.replayed ? { "pando-replayed": "true" } : {});
  });

  api.get(one, async (c) => c.json(unwrap(await c.get("stub").issueGet(numberOf(c))) satisfies typeof Contract.Issue.Encoded));

  api.patch(one, async (c) => {
    const n = numberOf(c);
    const patch = await patchOf(c, await bodyOf(c));

    return c.json(unwrap(await c.get("stub").issueUpdate(n, patch, c.get("identity"))) satisfies typeof Contract.Issue.Encoded);
  });

  api.get(`${one}/timeline`, async (c) => {
    const n = numberOf(c);
    const num = (k: string, fallback: number | null) => (c.req.query(k) === undefined ? fallback : Number(c.req.query(k)));
    const limit = num("limit", TIMELINE_DEFAULT)!;
    const last = num("last", null);
    const cursor = num("cursor", null);

    if (!Number.isInteger(limit) || limit < 1 || limit > 100) bad("limit: 1 to 100");

    if (last !== null && (!Number.isInteger(last) || last < 1 || last > 100)) bad("last: 1 to 100");

    if (cursor !== null && !Number.isSafeInteger(cursor)) bad("cursor: pass back a next_cursor as it came");

    return c.json(unwrap(await c.get("stub").issueTimeline(n, { cursor, limit, last })) satisfies typeof Contract.Timeline.Encoded);
  });

  api.post(`${one}/comments`, async (c) => {
    const n = numberOf(c);
    const b = await bodyOf(c);
    const out = unwrap(await c.get("stub").issueComment(n, textField(b.body, "body", BODY_MAX), c.get("identity"), keyOf(c)));

    return c.json(out.comment satisfies typeof Contract.IssueComment.Encoded, out.replayed ? 200 : 201, out.replayed ? { "pando-replayed": "true" } : {});
  });

  api.get(comment, async (c) => c.json(unwrap(await c.get("stub").issueGetComment(numberOf(c), c.req.param("id")!)) satisfies typeof Contract.IssueComment.Encoded));

  api.patch(comment, async (c) => {
    const n = numberOf(c);
    const b = await bodyOf(c);
    const baseVersion = b.base_version === undefined ? null : isWholeNumber(b.base_version) ? b.base_version : bad("base_version: the body_version you edited");
    const out = unwrap(await c.get("stub").issueEditComment(n, c.req.param("id")!, textField(b.body, "body", BODY_MAX), baseVersion, c.get("identity")));

    return c.json(out satisfies typeof Contract.IssueComment.Encoded);
  });

  api.delete(comment, async (c) => {
    unwrap(await c.get("stub").issueDeleteComment(numberOf(c), c.req.param("id")!, c.get("identity")));

    return c.body(null, 204);
  });

  for (const [path, onComment] of [[`${one}/reactions/:content`, false], [`${comment}/reactions/:content`, true]] as const) {
    for (const on of [true, false]) {
      const handler = async (c: C) => {
        const reactions = unwrap(await c.get("stub").issueReact(numberOf(c), onComment ? c.req.param("id")! : null, reactionOf(c), c.get("identity"), on));

        return c.json({ reactions } satisfies typeof Contract.ReactionsAnswer.Encoded);
      };

      if (on) api.put(path, handler);
      else api.delete(path, handler);
    }
  }

  const labels = "/v1/monorepos/:o/:m/labels";

  api.get(labels, async (c) => c.json(unwrap(await c.get("stub").labelList()) satisfies typeof Contract.LabelList.Encoded));

  api.post(labels, async (c) => {
    ownerOnly(c, "make labels");
    const b = await bodyOf(c);
    const description = b.description === undefined || b.description === null ? null : textField(b.description, "description", 100);
    const label = unwrap(await c.get("stub").labelCreate({ name: textField(b.name, "name", 50), color: textField(b.color, "color", 20), description }, c.get("identity")));

    return c.json(label satisfies typeof Contract.Label.Encoded, 201);
  });

  api.patch(`${labels}/:label`, async (c) => {
    ownerOnly(c, "change labels");
    const b = await bodyOf(c);
    const patch: LabelPatch = {};

    if (b.name !== undefined) patch.name = textField(b.name, "name", 50);

    if (b.color !== undefined) patch.color = textField(b.color, "color", 20);

    if (b.description !== undefined) patch.description = b.description === null ? null : textField(b.description, "description", 100);

    return c.json(unwrap(await c.get("stub").labelUpdate(c.req.param("label")!, patch, c.get("identity"))) satisfies typeof Contract.Label.Encoded);
  });

  api.delete(`${labels}/:label`, async (c) => {
    ownerOnly(c, "delete labels");
    unwrap(await c.get("stub").labelDelete(c.req.param("label")!, c.get("identity")));

    return c.body(null, 204);
  });
}
