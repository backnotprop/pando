// Large files outside projects/ on GitHub. Pando keeps their bytes in R2
// (BLOBS, meta/<monorepo id>/<sha256>) and a Git LFS pointer in git, and
// GitHub refuses a push naming LFS objects it lacks. So before such a push,
// every object is offered to the repository's LFS batch API; GitHub answers
// an upload action only for the ones it does not have, and those are streamed
// from R2. Nothing is kept in Pando: GitHub says what it lacks.

import type { Env } from "../env";
import { isInteger, isRecord, isText, type Json } from "../parse";
import { RemoteError, type Remote } from "./pipe";

/** GitHub's LFS batch API takes at most 100 objects a call. */
const BATCH = 100;

const LFS_JSON = "application/vnd.git-lfs+json";

/** One object as the batch API names it. */
interface LfsObject {
  oid: string;
  size: number;
}

/** Every large file this repository's shared files ever stored (R2 keys meta/<id>/<sha256>). */
async function storedObjects(env: Env, monorepoId: string): Promise<LfsObject[]> {
  const out: LfsObject[] = [];
  const prefix = `meta/${monorepoId}/`;
  let cursor: string | undefined;

  do {
    const page = await env.BLOBS.list({ prefix, cursor, limit: 1000 });

    for (const o of page.objects) {
      const oid = o.key.slice(prefix.length);

      if (/^[0-9a-f]{64}$/.test(oid)) out.push({ oid, size: o.size });
    }

    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return out;
}

/** Upload the shared files' large objects GitHub lacks. Answers how many were sent. */
export async function uploadLfs(env: Env, monorepoId: string, remote: Remote): Promise<number> {
  const objects = await storedObjects(env, monorepoId);
  let sent = 0;

  for (let i = 0; i < objects.length; i += BATCH) {
    const batch = objects.slice(i, i + BATCH);

    const res = await fetch(`${remote.url}/info/lfs/objects/batch`, {
      method: "POST",
      headers: { authorization: remote.authorization, accept: LFS_JSON, "content-type": LFS_JSON, "user-agent": "git-lfs/3.5 pando-mirror" },
      body: JSON.stringify({ operation: "upload", transfers: ["basic"], objects: batch }),
    });

    if (!res.ok) {
      await res.body?.cancel();
      throw new RemoteError(res.status, `GitHub's large-file storage answered ${res.status}`, res.headers.get("retry-after"));
    }

    const answer: Json = await res.json<Json>();
    const listed = isRecord(answer) && Array.isArray(answer.objects) ? answer.objects : [];

    for (const o of listed) {
      if (!isRecord(o) || !isText(o.oid)) continue;

      if (isRecord(o.error)) throw new RemoteError(isInteger(o.error.code) ? o.error.code : 422, `GitHub refused a large file: ${isText(o.error.message) ? o.error.message : o.oid}`);
      const actions = isRecord(o.actions) ? o.actions : null;
      const upload = actions && isRecord(actions.upload) ? actions.upload : null;

      if (!upload || !isText(upload.href)) continue; // GitHub has it already
      const size = batch.find((b) => b.oid === o.oid)?.size ?? 0;
      await putObject(env, monorepoId, o.oid, size, upload.href, headersOf(upload.header, "application/octet-stream"));
      const verify = actions && isRecord(actions.verify) ? actions.verify : null;

      if (verify && isText(verify.href)) {
        const headers = headersOf(verify.header, LFS_JSON);
        headers.set("accept", LFS_JSON);
        const v = await fetch(verify.href, { method: "POST", headers, body: JSON.stringify({ oid: o.oid, size }) });

        if (!v.ok) throw new RemoteError(v.status, `GitHub did not confirm a large file (${v.status})`);
        await v.body?.cancel();
      }

      sent++;
    }
  }

  return sent;
}

/** The headers GitHub asks an upload or verify call to carry, with the content type. */
function headersOf(v: Json | undefined, contentType: string): Headers {
  const out = new Headers({ "content-type": contentType });

  if (isRecord(v)) for (const [k, x] of Object.entries(v)) if (isText(x)) out.set(k, x);

  return out;
}

/** Stream one object from R2 to its upload address. */
async function putObject(env: Env, monorepoId: string, oid: string, size: number, href: string, headers: Headers): Promise<void> {
  const obj = await env.BLOBS.get(`meta/${monorepoId}/${oid}`);

  if (!obj) throw new RemoteError(500, `a large file is missing from Pando's storage (${oid.slice(0, 12)})`);
  const body = obj.body.pipeThrough(new FixedLengthStream(size));
  const res = await fetch(href, { method: "PUT", headers, body });

  if (!res.ok) throw new RemoteError(res.status, `GitHub's large-file storage refused an upload (${res.status})`, res.headers.get("retry-after"));
  await res.body?.cancel();
}
