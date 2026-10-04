// Test harness for gitwrite. It runs only under `wrangler dev` on the
// developer's machine (see run.mjs), with the Artifacts binding on the remote
// pando-spike namespace, and only touches repos named gw-test-*.
import { hasCode, isRecord, isText, isWholeNumber, type Json, type JsonObject } from "../../parse";
import type { Change, CommitOptions } from "../commit";
import { commitChanges, GitWriteError, mergeCommit } from "../index";
import type { MergeOptions } from "../merge";
import type { Signature } from "../objects";
import { buildPack } from "../pack";
import { OpenRepo } from "../repo";

interface Env {
  ARTIFACTS: Artifacts;
}

// The test's JSON, decoded into gitwrite's own types; gitwrite then checks
// the values themselves (a bad path, an empty message) as it does for any caller.
const invalid = (message: string) => new GitWriteError("invalid_input", message);

function text(v: Json | undefined, field: string): string {
  if (!isText(v)) throw invalid(`${field} must be a string`);

  return v;
}

function object(v: Json | undefined, field: string): JsonObject {
  if (!isRecord(v)) throw invalid(`${field} must be an object`);

  return v;
}

function person(v: Json | undefined, field: string): Signature {
  const p = object(v, field);

  return { name: text(p.name, `${field}.name`), email: text(p.email, `${field}.email`), date: isText(p.date) ? new Date(p.date) : undefined };
}

function mergeOptions(o: JsonObject): MergeOptions {
  return {
    base: text(o.base, "base"),
    head: text(o.head, "head"),
    baseSha: o.baseSha === undefined ? undefined : text(o.baseSha, "baseSha"),
    message: text(o.message, "message"),
    author: person(o.author, "author"),
    committer: o.committer ? person(o.committer, "committer") : undefined,
    dryRun: o.dryRun === true,
  };
}

function change(v: Json): Change {
  const c = object(v, "a change");
  const path = text(c.path, "path");

  if (c.delete !== undefined) {
    if (c.delete !== true) throw invalid(`${path}: delete must be true`);

    return { path, delete: true };
  }

  const mode = c.mode === undefined ? undefined : c.mode === "100644" || c.mode === "100755" || c.mode === "120000" ? c.mode : null;

  if (mode === null) throw invalid(`${path}: mode must be 100644, 100755 or 120000`);
  const content = c.base64 !== undefined ? Uint8Array.from(atob(text(c.base64, "base64")), (ch) => ch.charCodeAt(0)) : text(c.content, "content");

  return { path, mode, content };
}

function commitOptions(o: JsonObject): CommitOptions {
  if (!Array.isArray(o.changes)) throw invalid("changes must be a list");

  return {
    parent: o.parent === null ? null : text(o.parent, "parent"),
    changes: o.changes.map(change),
    message: text(o.message, "message"),
    author: person(o.author, "author"),
    committer: o.committer ? person(o.committer, "committer") : undefined,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "POST") return new Response("POST only\n", { status: 405 });
    const body = await request.json<Json>();

    if (!isRecord(body)) return Response.json({ error: "the body must be a JSON object" }, { status: 400 });
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
          return Response.json(await mergeCommit(repo, mergeOptions(object(body.opts, "opts"))));
        case "/commit":
          return Response.json(await commitChanges(repo, text(body.branch, "branch"), commitOptions(object(body.opts, "opts"))));

        case "/raw-push": {
          // Send a ref update with an empty pack and whatever old sha the test
          // gives, to see Artifacts itself refuse a stale old.
          const r = await OpenRepo.open(repo);

          try {
            const refused = await r.push(text(body.ref, "ref"), body.old === null ? null : text(body.old, "old"), text(body.new, "new"), await buildPack([]));

            return Response.json({ refused });
          } finally {
            r.close();
          }
        }

        case "/log": {
          const r = await env.ARTIFACTS.get(name);

          return Response.json((await r.log({ ref: text(body.ref, "ref"), limit: isWholeNumber(body.limit) ? body.limit : 1 })).map((c) => c.hash));
        }

        case "/tokens": {
          const r = await env.ARTIFACTS.get(name);

          return Response.json(await r.listTokens());
        }
      }

      return Response.json({ error: "unknown route" }, { status: 404 });
    } catch (e) {
      if (e instanceof GitWriteError) return Response.json({ error: e.code, message: e.message }, { status: 400 });

      return Response.json({ error: "harness", code: hasCode(e) ? e.code : undefined, message: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
