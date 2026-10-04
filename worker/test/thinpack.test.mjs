// The door's pack rewrite (src/monorepo/thinpack.ts), checked with real git: packs made by git (and one by hand, for
// a delta whose distance crosses a rewritten tree) are rewritten, then git index-pack takes them and git fsck passes.
// The push itself is tested end to end by test/revert-push.mjs against real Artifacts.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { wholeThinTrees } from "../src/monorepo/thinpack";

const work = mkdtempSync(join(tmpdir(), "pando-thinpack-"));

afterAll(() => rmSync(work, { recursive: true, force: true }));

function git(cwd, args, input) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@pando.invalid", "-c", "init.defaultBranch=main", ...args], {
    cwd, input, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work },
  });

  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);

  return r.stdout;
}

const text = (cwd, args) => git(cwd, args).toString().trim();

/** The repo's trees, as the door reads them from Artifacts. */
/** @returns {import("../src/monorepo/thinpack").ReadTree} */
const readTreeIn = (repo) => async (sha) => {
  if (spawnSync("git", ["cat-file", "-t", sha], { cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).stdout.toString().trim() !== "tree") return null;

  return text(repo, ["ls-tree", sha]).split("\n").map((line) => {
    const [meta, name] = line.split("\t");
    const [mode, , hash] = meta.split(" ");

    return { name, mode: mode.replace(/^0+/, ""), hash };
  });
};

/** A repo with four files, then two commits each adding one (the server's side), and a clone of it. */
function history(name) {
  const client = join(work, name);
  git(work, ["init", "-q", client]);

  for (let i = 0; i < 4; i++) writeFileSync(join(client, `file-${i}.txt`), `file ${i}\n`);
  git(client, ["add", "-A"]);
  git(client, ["commit", "-qm", "four files"]);

  for (const f of ["add-0.txt", "add-1.txt"]) {
    writeFileSync(join(client, f), `${f}\n`);
    git(client, ["add", "-A"]);
    git(client, ["commit", "-qm", f]);
  }

  const server = join(work, `${name}-server.git`);
  git(work, ["clone", "-q", "--bare", client, server]);

  return { server, client };
}

/** The pack taken by the server: index-pack completes it from the server's objects, then a full fsck. */
function take(server, pack) {
  git(server, ["index-pack", "--stdin", "--fix-thin", "--strict"], pack);
  git(server, ["fsck", "--full", "--strict"]);
}

describe("thin tree deltas written whole", () => {
  it("rewrites a revert's push as git makes it, and git takes the result", async () => {
    const { server, client } = history("revert");
    const old = text(client, ["rev-parse", "HEAD"]);
    git(client, ["revert", "--no-edit", "HEAD"]);
    // Two new files alike, so the pack also carries an OFS_DELTA (one blob against the other).
    const big = Array.from({ length: 40 }, (_, i) => `line ${i} of a file long enough to deltify\n`).join("");
    writeFileSync(join(client, "big-1.txt"), big);
    writeFileSync(join(client, "big-2.txt"), big + "one more line\n");
    git(client, ["add", "-A"]);
    git(client, ["commit", "-qm", "two files alike"]);
    const pack = git(client, ["pack-objects", "--revs", "--thin", "--stdout", "-q", "--delta-base-offset"], new TextEncoder().encode(`HEAD\n^${old}\n`));

    const out = await wholeThinTrees(new Uint8Array(pack), readTreeIn(server));
    expect(out?.trees).toBeGreaterThanOrEqual(1);
    take(server, out.pack);
    git(server, ["update-ref", "refs/heads/main", text(client, ["rev-parse", "HEAD"])]);
    expect(text(server, ["rev-parse", "main~1^{tree}"])).toBe(text(server, ["rev-parse", "main~3^{tree}"]));
  });

  it("writes again an OFS_DELTA distance that crosses a rewritten tree", async () => {
    const { server } = history("ofs");
    const x = text(server, ["rev-parse", "main^{tree}"]);
    const a = text(server, ["rev-parse", "main~1^{tree}"]);
    const raw = (sha) => git(server, ["cat-file", "tree", sha]);
    const blob = text(server, ["rev-parse", "main:file-0.txt"]);
    // One more entry at the end of a tree (its name sorts last), as a delta: copy the base, insert the entry.
    const entry = Buffer.concat([Buffer.from("100644 zz.txt\0"), Buffer.from(blob, "hex")]);
    const delta = (base) => Buffer.concat([varint(base.length), varint(base.length + entry.length), Buffer.from([0x90 | 0x20, base.length & 0xff, base.length >> 8]), Buffer.from([entry.length]), entry]);
    const xRaw = raw(x);
    const aRaw = raw(a);

    // [tree A whole] [tree B: REF_DELTA against the server's X] [tree C: OFS_DELTA against A, across B]
    const first = Buffer.concat([header(2, aRaw.length), deflateSync(aRaw)]);
    const bDelta = delta(xRaw);
    const second = Buffer.concat([header(7, bDelta.length), Buffer.from(x, "hex"), deflateSync(bDelta)]);
    const cDelta = delta(aRaw);
    const third = Buffer.concat([header(6, cDelta.length), ofs(first.length + second.length), deflateSync(cDelta)]);
    const body = Buffer.concat([Buffer.from("PACK"), Buffer.from([0, 0, 0, 2, 0, 0, 0, 3]), first, second, third]);
    const { createHash } = await import("node:crypto");
    const pack = Buffer.concat([body, createHash("sha1").update(body).digest()]);
    take(server, pack); // the hand-made pack is sound to begin with

    const fresh = history("ofs-again").server;
    const out = await wholeThinTrees(new Uint8Array(pack), readTreeIn(fresh));
    expect(out?.trees).toBe(1);
    take(fresh, out.pack);
  });
});

function varint(n) {
  const out = [];

  do {
    out.push((n & 0x7f) | (n >= 0x80 ? 0x80 : 0));
    n >>= 7;
  } while (n > 0);

  return Buffer.from(out);
}

function header(type, size) {
  const out = [(type << 4) | (size & 0x0f)];
  size >>= 4;

  while (size > 0) {
    out[out.length - 1] |= 0x80;
    out.push(size & 0x7f);
    size >>= 7;
  }

  return Buffer.from(out);
}

function ofs(distance) {
  const out = [distance & 0x7f];

  while ((distance >>= 7) > 0) out.unshift(0x80 | (--distance & 0x7f));

  return Buffer.from(out);
}
