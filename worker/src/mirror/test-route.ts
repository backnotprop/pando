// Tests only (MIRROR_TEST=1, the bootstrap secret): /v1/_mirror/test.
// "pipe": send one Pando repo's main straight through the pipe to a remote
// on this machine, with timings (the spike's measurements).
// "link": connect an installation without the browser step (the real-GitHub
// suite; the installation id comes from the owner's .dev.vars).
// "remote-refs": GitHub's refs for a target, read by the Worker with its own
// token, so no token ever reaches the test.

import type { Env } from "../env";
import { credential } from "../http";
import { isInteger, isRecord, isText, type Json } from "../parse";
import { listRefs } from "../monorepo/artifacts";
import { cachedRepo, isBootstrap } from "../monorepo/session";
import { appInstallation, installationToken, remoteFor } from "./github";
import { linkInstallation } from "./routes";
import { artifactsPack, pushPack, remoteRefs, ZERO } from "./pipe";

const refuse = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status });

const local = (u: string) => /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(u);

export async function mirrorTestRoute(request: Request, env: Env): Promise<Response> {
  if (env.MIRROR_TEST !== "1") return refuse(404, "not_found", "no such route");

  if (!(await isBootstrap(env, credential(request)))) return refuse(401, "unauthorized", "the bootstrap secret only");
  const b = await request.json<Json>().catch(() => null);

  if (isRecord(b) && b.op === "pipe" && isText(b.monorepo) && isText(b.url) && local(b.url)) {
    return Response.json(await pipeOnce(env, b.monorepo, isText(b.repo) ? b.repo : null, b.url));
  }

  if (isRecord(b) && b.op === "link" && isText(b.monorepo) && isInteger(b.installation_id) && isText(b.by)) {
    await linkInstallation(env, b.monorepo, await appInstallation(env, b.installation_id), b.by, 0);

    return Response.json({ linked: b.installation_id });
  }

  if (isRecord(b) && b.op === "remote-refs" && isInteger(b.installation_id) && isInteger(b.repo_id) && isText(b.full_name)) {
    const token = await installationToken(env, b.installation_id, [b.repo_id]);

    return Response.json({ refs: Object.fromEntries(await remoteRefs(remoteFor(env, b.full_name, token))) });
  }

  return refuse(400, "bad_request", "op pipe (monorepo, repo, url), link (monorepo, installation_id, by) or remote-refs (installation_id, repo_id, full_name)");
}

async function pipeOnce(env: Env, monorepo: string, repoName: string | null, url: string) {
  const t0 = Date.now();
  const repo = await cachedRepo(env, monorepo, repoName);

  if (!repo) return { error: "no such repo" };
  const remote = { url, authorization: `Basic ${btoa("x-access-token:test")}` };
  const [mine, theirs] = await Promise.all([listRefs(env, repo), remoteRefs(remote)]);
  const ref = `refs/heads/${repo.default_branch || "main"}`;
  const want = mine.get(ref);
  const refsMs = Date.now() - t0;

  if (!want) return { error: "the repo has no main", refs_ms: refsMs };
  const had = theirs.get(ref) ?? ZERO;

  if (had === want) return { up_to_date: true, refs_ms: refsMs };
  let bytes = 0;
  let firstByteMs = 0;

  const count = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, c) {
      if (!bytes) firstByteMs = Date.now() - t0;
      bytes += chunk.length;
      c.enqueue(chunk);
    },
  });

  const pack = (await artifactsPack(env, repo, [want], [...new Set(theirs.values())])).pipeThrough(count);
  const { report } = await pushPack(remote, [{ old: had, new: want, ref }], pack);

  return { ref, sha: want, refs_ms: refsMs, first_pack_byte_ms: firstByteMs, total_ms: Date.now() - t0, pack_bytes: bytes, report: { unpack: report.unpack, error: report.error, refs: Object.fromEntries(report.refs) } };
}
