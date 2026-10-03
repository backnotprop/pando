// Test harness for gitwrite. It runs only under `wrangler dev` on the
// developer's machine (see run.mjs), with the Artifacts binding on the remote
// pando-spike namespace, and only touches repos named gw-test-*.
import { commitChanges, GitWriteError, mergeCommit } from "../index";
import { buildPack } from "../pack";
import { OpenRepo } from "../repo";

interface Env {
  ARTIFACTS: Artifacts;
}

const person = (p: { name: string; email: string; date?: string }) =>
  p && { name: p.name, email: p.email, date: p.date ? new Date(p.date) : undefined };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") return new Response("POST only\n", { status: 405 });
    const body = (await request.json()) as Record<string, any>;
    const name = String(body.name ?? "");
    if (!/^gw-test-[a-z0-9-]+$/.test(name)) return Response.json({ error: "name must be gw-test-*" }, { status: 400 });
    const repo = { artifacts: env.ARTIFACTS, name };
    try {
      switch (url.pathname) {
        case "/create": {
          const created = await env.ARTIFACTS.create(name, { setDefaultBranch: "main" });
          const r = await env.ARTIFACTS.get(name);
          await r.revokeToken(created.token); // the tests mint their own
          return Response.json({ name: created.name, remote: created.remote });
        }
        case "/token": {
          // A write token for the test's own git client. run.mjs keeps it in
          // an environment variable and never prints it.
          const r = await env.ARTIFACTS.get(name);
          const t = await r.createToken("write", 600);
          return Response.json({ token: t.plaintext, id: t.id });
        }
        case "/delete":
          return Response.json({ deleted: await env.ARTIFACTS.delete(name) });
        case "/merge":
          return Response.json(
            await mergeCommit(repo, {
              ...body.opts,
              author: person(body.opts.author),
              committer: body.opts.committer ? person(body.opts.committer) : undefined,
            }),
          );
        case "/commit": {
          const changes = body.opts.changes.map((c: any) =>
            c.base64 !== undefined
              ? { path: c.path, mode: c.mode, content: Uint8Array.from(atob(c.base64), (ch) => ch.charCodeAt(0)) }
              : c,
          );
          return Response.json(
            await commitChanges(repo, body.branch, {
              ...body.opts,
              changes,
              author: person(body.opts.author),
              committer: body.opts.committer ? person(body.opts.committer) : undefined,
            }),
          );
        }
        case "/raw-push": {
          // Send a ref update with an empty pack and whatever old sha the test
          // gives, to see Artifacts itself refuse a stale old.
          const r = await OpenRepo.open(repo);
          try {
            const refused = await r.push(body.ref, body.old, body.new, await buildPack([]));
            return Response.json({ refused });
          } finally {
            r.close();
          }
        }
        case "/log": {
          const r = await env.ARTIFACTS.get(name);
          return Response.json((await r.log({ ref: body.ref, limit: body.limit ?? 1 })).map((c) => c.hash));
        }
        case "/tokens": {
          const r = await env.ARTIFACTS.get(name);
          return Response.json(await r.listTokens());
        }
      }
      return Response.json({ error: "unknown route" }, { status: 404 });
    } catch (e) {
      if (e instanceof GitWriteError) return Response.json({ error: e.code, message: e.message }, { status: 400 });
      const err = e as { code?: string; message?: string };
      return Response.json({ error: "harness", code: err.code, message: err.message }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
