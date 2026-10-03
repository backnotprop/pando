// Unit tests for the pure parts. The git paths themselves are tested end to
// end by test/e2e.mjs with real git and real Artifacts.
import { describe, expect, it } from "vitest";
import { combine } from "../src/monorepo/checks";
import { compareWith, type CommitInfo } from "../src/monorepo/graph";
import { repoNameFor, validBranchName, validMonorepoName, validRepoPath } from "../src/monorepo/names";
import { concat, FLUSH, parseAdvertisement, parseReport, pkt, readCommandSection, refusal } from "../src/monorepo/pktline";
import type { StatusRecord } from "../src/monorepo/types";

const dec = new TextDecoder();
const Z = "0".repeat(40);
const A = "a".repeat(40);
const B = "b".repeat(40);

function stream(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
}

describe("receive-pack command section", () => {
  it("reads commands and capabilities, and leaves the pack in the stream", async () => {
    const body = concat([
      pkt(`${Z} ${A} refs/heads/main\0report-status side-band-64k agent=git/2\n`),
      pkt(`${A} ${B} refs/heads/feature\n`),
      FLUSH,
    ]);
    const pack = new TextEncoder().encode("PACK....rest of the pack");
    // Split the body so the command section crosses chunk boundaries.
    const s = await readCommandSection(stream([body.subarray(0, 7), body.subarray(7), pack]));
    expect(s.commands).toEqual([
      { old: Z, new: A, ref: "refs/heads/main" },
      { old: A, new: B, ref: "refs/heads/feature" },
    ]);
    expect(s.caps.has("side-band-64k")).toBe(true);
    let rest = s.head;
    for (;;) {
      const { done, value } = await s.rest.read();
      if (done) break;
      rest = concat([rest, value]);
    }
    expect(dec.decode(rest).endsWith("PACK....rest of the pack")).toBe(true);
  });

  it("reads push options when negotiated", async () => {
    const body = concat([pkt(`${Z} ${A} refs/heads/x\0report-status push-options\n`), FLUSH, pkt("ci.skip\n"), FLUSH]);
    const s = await readCommandSection(stream([body]));
    expect(s.commands).toHaveLength(1);
    expect(s.head.length).toBe(body.length);
  });
});

describe("refusal and report", () => {
  it("writes ng lines inside side-band 1 that parse back", () => {
    const cmds = [{ old: A, new: B, ref: "refs/heads/main" }];
    const caps = new Set(["report-status", "side-band-64k"]);
    const out = refusal(cmds, new Map([["refs/heads/main", "main is protected"]]), caps, "Pando refused this push");
    const report = parseReport(out, caps);
    expect(report.unpack).toBe("ok");
    expect(report.refs.get("refs/heads/main")).toBe("main is protected");
  });

  it("parses a plain report", () => {
    const bytes = concat([pkt("unpack ok\n"), pkt("ok refs/heads/a\n"), pkt("ng refs/heads/b non-fast-forward\n"), FLUSH]);
    const r = parseReport(bytes, new Set(["report-status"]));
    expect(r.refs.get("refs/heads/a")).toBeNull();
    expect(r.refs.get("refs/heads/b")).toBe("non-fast-forward");
  });

  it("parses a ref advertisement", () => {
    const bytes = concat([
      pkt("# service=git-upload-pack\n"),
      FLUSH,
      pkt(`${A} HEAD\0multi_ack symref=HEAD:refs/heads/main\n`),
      pkt(`${A} refs/heads/main\n`),
      pkt(`${B} refs/heads/agent/x\n`),
      FLUSH,
    ]);
    const refs = parseAdvertisement(bytes);
    expect(refs.get("refs/heads/main")).toBe(A);
    expect(refs.get("refs/heads/agent/x")).toBe(B);
  });

  it("an empty repo advertises no refs", () => {
    const bytes = concat([pkt("# service=git-upload-pack\n"), FLUSH, pkt(`${Z} capabilities^{}\0report-status\n`), FLUSH]);
    expect(parseAdvertisement(bytes).size).toBe(0);
  });
});

describe("merge base, ahead and behind", () => {
  // root - m1 - m2 - m3 (main, m3 merges y2)
  //         \     \
  //          b1    y1 - y2
  //                       \
  //                        z1 (a branch stacked on y)
  const g: Record<string, CommitInfo> = {
    root: { parents: [], time: 1, tree: "t" },
    m1: { parents: ["root"], time: 2, tree: "t" },
    b1: { parents: ["m1"], time: 3, tree: "t" },
    m2: { parents: ["m1"], time: 4, tree: "t" },
    y1: { parents: ["m2"], time: 5, tree: "t" },
    y2: { parents: ["y1"], time: 6, tree: "t" },
    m3: { parents: ["m2", "y2"], time: 7, tree: "t" },
    z1: { parents: ["y2"], time: 8, tree: "t" },
  };
  const read = async (s: string) => g[s];

  it("a branch off an older main", async () => {
    expect(await compareWith(read, "m3", "b1")).toEqual({ mergeBase: "m1", ahead: 1, behind: 4 });
  });

  it("a stacked branch after the lower branch merged", async () => {
    expect(await compareWith(read, "m3", "z1")).toEqual({ mergeBase: "y2", ahead: 1, behind: 1 });
  });

  it("the same commit", async () => {
    expect(await compareWith(read, "m3", "m3")).toEqual({ mergeBase: "m3", ahead: 0, behind: 0 });
  });
});

describe("the merge gate", () => {
  const st = (context: string, state: StatusRecord["state"]): StatusRecord => ({
    sha: A, context, state, target_url: null, description: null, creator: "x", created_at: "",
  });

  it("passes with no statuses and no required checks", () => {
    expect(combine(A, [], []).state).toBe("success");
  });
  it("uses the latest status per context", () => {
    expect(combine(A, [], [st("ci", "failure"), st("ci", "success")]).state).toBe("success");
  });
  it("reports a missing required check", () => {
    const c = combine(A, ["ci"], [st("lint", "success")]);
    expect(c.state).toBe("missing");
    expect(c.missing).toEqual(["ci"]);
  });
  it("ignores contexts that are not required", () => {
    expect(combine(A, ["ci"], [st("ci", "success"), st("lint", "failure")]).state).toBe("success");
  });
  it("is pending while a reported check is pending", () => {
    expect(combine(A, [], [st("ci", "pending")]).state).toBe("pending");
  });
});

describe("names", () => {
  it("monorepo names", () => {
    expect(validMonorepoName("acme")).toBe(true);
    expect(validMonorepoName("Acme")).toBe(false);
    expect(validMonorepoName("a--b")).toBe(false);
    expect(validMonorepoName("v1")).toBe(false);
  });
  it("repo paths become URL names", () => {
    expect(validRepoPath("projects/web")).toBe(true);
    expect(validRepoPath("projects/../x")).toBe(false);
    expect(repoNameFor("acme", "projects/web")).toBe("projects-web");
    expect(repoNameFor("acme", ".")).toBe("acme");
    expect(repoNameFor("acme", "meta")).toBeNull();
    expect(repoNameFor("acme", "projects/-x")).toBeNull();
  });
  it("branch names follow git check-ref-format", () => {
    expect(validBranchName("agent-3/oauth")).toBe(true);
    expect(validBranchName("a..b")).toBe(false);
    expect(validBranchName("x.lock")).toBe(false);
    expect(validBranchName("has space")).toBe(false);
  });
});
