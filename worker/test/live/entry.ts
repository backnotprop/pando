// A Worker with only the meta layer routes, for testing the live lane with
// `wrangler dev` before it is wired into src/index.ts. Never deployed.
//
// POST /test/destroy calls the object's destroy() for an e2e-* monorepo, and
// POST /test/apply-from-main its applyFromMain().
// With the Artifacts binding (wrangler.artifacts.jsonc), POST /test/meta-repo
// makes, reads and deletes the meta layer repo of a test monorepo. It only
// touches repos named e2e-*--meta.
import { commitChanges } from "../../src/gitwrite";
import { metaRoute, routeMeta, type LiveEnv } from "../../src/live/route";
import { isRecord, isText, type Json } from "../../src/parse";

export { MetaLayerObject } from "../../src/live/object";

interface Env extends LiveEnv {
  ARTIFACTS?: Artifacts;
}

/** A change for applyFromMain: a path and its new text, or null to delete it. */
type TestChange = { path: string; text: string | null };

function isTestChange(v: Json): v is TestChange {
  return isRecord(v) && isText(v.path) && (v.text === null || isText(v.text));
}

const bad = (error: string) => Response.json({ error }, { status: 400 });

async function readPath(repo: ArtifactsRepo, path: string): Promise<string | null> {
  const [head] = await repo.log({ ref: "main", limit: 1 });

  if (!head) return null;
  let tree = head.treeHash;
  const parts = path.split("/");

  for (const [i, part] of parts.entries()) {
    const entries = (await repo.readTree(tree)) ?? [];
    const e = entries.find((x) => x.name === part);

    if (!e) return null;

    if (i === parts.length - 1) return (await (await repo.readBlob(e.hash))?.text()) ?? null;
    tree = e.hash;
  }

  return null;
}

async function testRoute(request: Request, env: Env): Promise<Response> {
  if (!env.ARTIFACTS) return Response.json({ error: "no Artifacts binding" }, { status: 400 });
  const body = await request.json<Json>();

  if (!isRecord(body) || !isText(body.monorepo) || !isText(body.action)) return bad("send {monorepo, action, path?, content?}");

  if (!/^e2e-[a-z0-9-]+$/.test(body.monorepo) || body.monorepo.includes("--")) return bad("test monorepos are e2e-*");

  const name = `${body.monorepo}--meta`;
  const path = isText(body.path) ? body.path : null;
  const content = isText(body.content) ? body.content : null;

  switch (body.action) {
    case "create": {
      const created = await env.ARTIFACTS.create(name, { setDefaultBranch: "main" });
      const repo = await env.ARTIFACTS.get(name);
      await repo.revokeToken(created.token);

      return Response.json({ name });
    }

    case "delete":
      return Response.json({ deleted: await env.ARTIFACTS.delete(name) });
    case "log": {
      const repo = await env.ARTIFACTS.get(name);

      return Response.json(await repo.log({ ref: "main", limit: 20 }));
    }

    case "read": {
      const repo = await env.ARTIFACTS.get(name);

      return Response.json({ content: await readPath(repo, path ?? "") });
    }

    case "move-main": {
      // Someone else commits on main (as a reviewed merge would), so the
      // object's remembered parent is stale.
      const repo = await env.ARTIFACTS.get(name);
      const [head] = await repo.log({ ref: "main", limit: 1 });

      const r = await commitChanges({ artifacts: env.ARTIFACTS, name }, "main", {
        parent: head?.hash ?? null,
        changes: [{ path: path ?? "elsewhere.md", content: content ?? "moved\n" }],
        message: "Merge a reviewed branch\n",
        author: { name: "Reviewer", email: "reviewer@example.com" },
      });

      return Response.json(r);
    }
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (path === "/healthz") return new Response("ok\n");

    if (path === "/test/meta-repo" && request.method === "POST") return testRoute(request, env);

    if (path === "/test/apply-from-main" && request.method === "POST") {
      // What the monorepo object does after a reviewed merge into the meta layer's main.
      const b = await request.json<Json>();

      if (!isRecord(b) || !isText(b.monorepo) || !isText(b.commit) || !Array.isArray(b.changes) || !b.changes.every(isTestChange)) {
        return bad("send {monorepo, commit, changes: [{path, text}]}");
      }

      if (!/^e2e-[a-z0-9-]+$/.test(b.monorepo)) return bad("test monorepos are e2e-*");
      const changes = b.changes.map((c) => ({ path: c.path, bytes: c.text === null ? null : new TextEncoder().encode(c.text) }));

      return Response.json(
        await env.META.get(env.META.idFromName(b.monorepo)).applyFromMain({ monorepo: b.monorepo, commit: b.commit, author: "Reviewer <r@example.com>", changes }),
      );
    }

    if (path === "/test/destroy" && request.method === "POST") {
      // What DELETE /v1/monorepos/{m} does to the meta layer object.
      const b = await request.json<Json>();

      if (!isRecord(b) || !isText(b.monorepo)) return bad("send {monorepo}");

      if (!/^e2e-[a-z0-9-]+$/.test(b.monorepo)) return bad("test monorepos are e2e-*");

      return Response.json(await env.META.get(env.META.idFromName(b.monorepo)).destroy());
    }

    // Paths are /v1/monorepos/{owner}/{name}/meta/... (namespaces); with no
    // accounts here, the test monorepo's name keys its object, as /test/* do.
    const ref = metaRoute(request);

    return (ref && (await routeMeta(request, env, ref.name))) || new Response("not found\n", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
