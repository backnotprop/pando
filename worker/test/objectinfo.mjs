// object-info at the git door, checked against git itself.
//
//   PANDO_URL=http://localhost:8797 node test/objectinfo.mjs     (wrangler dev; uses .dev.vars)
//
// It pushes a repo through the door, then sends the same protocol v2
// object-info request to the door and to git's own `upload-pack` (with
// uploadpack.advertiseObjectInfo on) and compares the replies byte for byte.
// It also checks the advertisement through real git (GIT_TRACE_PACKET), a
// gzipped request, and that a blobless clone and its lazy fetches still work.
// Git never reaches the macOS keychain. It deletes what it made.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describeError, retryResetFetch } from "./errors.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8797").replace(/\/$/, "");
const BOOT = process.env.PANDO_BOOTSTRAP ?? /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];
const results = [];
const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
};
const work = mkdtempSync(join(tmpdir(), "pando-oi-"));
let S = "";
const git = (args, cwd, extraEnv = {}) => {
  const r = spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "buffer",
    env: {
      ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: S,
      GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x", ...extraEnv,
    },
    input: extraEnv.__input,
  });
  return { ok: r.status === 0, out: r.stdout, err: r.stderr.toString().replace(/pando_[a-f0-9]+/g, "<credential>") };
};
const pkt = (s) => {
  const b = Buffer.from(s);
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, "0")), b]);
};
const call = async (method, path, secret, body) =>
  fetch(URL_ + path, { method, headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: body && JSON.stringify(body) }).then((r) => r.json().catch(() => null));

const id = Date.now().toString(36);
const M = `oi-${id}`;
let O = null; // the owner (namespaces: owner/name), from the create answer
try {
  S = (await call("POST", "/v1/users", BOOT, { login: `oi-${id}` })).credential.secret;
  const made = await call("POST", "/v1/monorepos", S, { name: M, kind: "repo" });
  O = made.monorepo.owner;
  const url = made.repos[0].clone_url;
  const src = join(work, "src");
  mkdirSync(join(src, "a/b"), { recursive: true });
  writeFileSync(join(src, "README.md"), "# object-info\n");
  writeFileSync(join(src, "empty.txt"), "");
  writeFileSync(join(src, "a/b/deep.txt"), "x".repeat(12345));
  writeFileSync(join(src, "big.bin"), Buffer.alloc(2 << 20, 7));
  // 302 more small files, for requests over the 100-variable SQL limit.
  mkdirSync(join(src, "many"));
  for (let i = 0; i < 302; i++) writeFileSync(join(src, "many", `f${i}.txt`), `file ${i}\n`.repeat(i + 1));
  git(["init", "-q"], src);
  git(["add", "-A"], src);
  git(["commit", "-qm", "files"], src);
  check("push through the door", git(["push", "-q", url, "main"], src).ok);

  // 1. Real git sees object-info in the v2 advertisement.
  const ls = git(["-c", "protocol.version=2", "ls-remote", url], src, { GIT_TRACE_PACKET: "1" });
  check("git ls-remote (v2) sees object-info advertised", ls.ok && /git< object-info/.test(ls.err), ls.ok ? "" : ls.err.slice(-200));

  // 2. The door's reply equals git upload-pack's own reply.
  const blobs = git(["ls-tree", "-r", "HEAD", "--", "README.md", "empty.txt", "a", "big.bin"], src).out.toString().trim().split("\n").map((l) => l.split(/\s+/)[2]);
  const ghost = "0123456789abcdef0123456789abcdef01234567";
  const request = Buffer.concat([
    pkt("command=object-info\n"), pkt("agent=git/2.50.1\n"), pkt("object-format=sha1\n"), Buffer.from("0001"),
    pkt("size\n"), ...[...blobs, ghost].map((o) => pkt(`oid ${o}\n`)), Buffer.from("0000"),
  ]);
  const post = async (body, extra = {}) => {
    const r = await fetch(`${URL_}/${O}/${M}.git/git-upload-pack`, {
      method: "POST",
      headers: { authorization: `Bearer ${S}`, "git-protocol": "version=2", "content-type": "application/x-git-upload-pack-request", ...extra },
      body,
    });
    return { status: r.status, type: r.headers.get("content-type"), bytes: Buffer.from(await r.arrayBuffer()) };
  };
  const t0 = Date.now();
  const door = await post(request);
  const cold = Date.now() - t0;
  const ref = spawnSync("git", ["-c", "transfer.advertiseObjectInfo=true", "upload-pack", "--stateless-rpc", src], {
    input: request, env: { ...process.env, GIT_PROTOCOL: "version=2", GIT_CONFIG_NOSYSTEM: "1", HOME: work },
  }).stdout;
  check("the door's object-info reply is byte for byte git's own", door.status === 200 && door.bytes.equals(ref), `${door.status} ${JSON.stringify(door.bytes.toString())} vs ${JSON.stringify(ref.toString())}`);
  check("content type is the upload-pack result", door.type === "application/x-git-upload-pack-result");
  const t1 = Date.now();
  const again = await post(request);
  check("a second ask is answered from the size index", again.bytes.equals(ref), `cold ${cold} ms, warm ${Date.now() - t1} ms`);
  const gz = await post(gzipSync(request), { "content-encoding": "gzip" });
  check("a gzipped request gets the same reply", gz.bytes.equals(ref));

  // 2b. More oids than one SQL statement can bind (302), cold and warm.
  const many = git(["ls-tree", "-r", "HEAD", "many"], src).out.toString().trim().split("\n").map((l) => l.split(/\s+/)[2]);
  const bigRequest = Buffer.concat([
    pkt("command=object-info\n"), pkt("object-format=sha1\n"), Buffer.from("0001"),
    pkt("size\n"), ...many.map((o) => pkt(`oid ${o}\n`)), Buffer.from("0000"),
  ]);
  const bigRef = spawnSync("git", ["-c", "transfer.advertiseObjectInfo=true", "upload-pack", "--stateless-rpc", src], {
    input: bigRequest, env: { ...process.env, GIT_PROTOCOL: "version=2", GIT_CONFIG_NOSYSTEM: "1", HOME: work },
  }).stdout;
  const bigCold = await post(bigRequest);
  check(`${many.length} oids in one request (cold) match git's reply`, many.length === 302 && bigCold.status === 200 && bigCold.bytes.equals(bigRef), `${bigCold.status} ${bigCold.bytes.length} bytes`);
  const bigWarm = await post(bigRequest);
  check(`${many.length} oids again (warm, from the size index) match`, bigWarm.status === 200 && bigWarm.bytes.equals(bigRef), `${bigWarm.status}`);

  // 3. Everything else still goes to Artifacts: a blobless clone and its lazy fetches.
  const clone = join(work, "clone");
  const c = git(["-c", "protocol.version=2", "clone", "-q", "--filter=blob:none", "--no-checkout", url, clone], work);
  check("a blobless clone through the door (v2 fetch, peeked and forwarded)", c.ok, c.err.slice(-300));
  const batch = spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "cat-file", "--batch-check"], {
    cwd: clone, input: blobs.join("\n") + "\n",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: S },
  });
  const sizes = batch.stdout.toString().trim().split("\n").map((l) => l.split(" ")[2]);
  check("git cat-file --batch-check in the blobless clone fetches lazily and reports sizes", batch.status === 0 && [...sizes].sort().join(",") === ["0", "12345", "14", "2097152"].join(","), sizes.join(","));
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  if (S) await fetch(`${URL_}/v1/monorepos/${O}/${M}?confirm=${O}/${M}`, { method: "DELETE", headers: { authorization: `Bearer ${S}` } });
  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
