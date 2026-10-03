// Unit tests for the pure parts. The git paths themselves are tested end to
// end by test/e2e.mjs with real git and real Artifacts.
import { describe, expect, it } from "vitest";
import { cacheable } from "../src/accounts/auth";
import type { Auth } from "../src/accounts/object";
import { combine } from "../src/monorepo/checks";
import { pandoTrailers } from "../src/monorepo/views";
import { compareWith, type CommitInfo, type CommitReader } from "../src/monorepo/graph";
import { repoNameFor, validBranchName, validMonorepoName, validRepoPath } from "../src/monorepo/names";
import { concat, FLUSH, parseAdvertisement, parseReport, pkt, readCommandSection, refusal } from "../src/monorepo/pktline";
import type { StatusRecord } from "../src/monorepo/types";
import { hasCode, isRecord, isText, isTextList, isWholeNumber, parseJson } from "../src/parse";

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
  /** A reader over a fixed graph; a commit the graph lacks is a broken test, so it throws. */
  const readerOf = (graph: Map<string, CommitInfo>): CommitReader => async (sha) => {
    const c = graph.get(sha);

    if (!c) throw new Error(`no commit ${sha} in the test graph`);

    return c;
  };

  const read = readerOf(
    new Map([
      ["root", { parents: [], time: 1, tree: "t" }],
      ["m1", { parents: ["root"], time: 2, tree: "t" }],
      ["b1", { parents: ["m1"], time: 3, tree: "t" }],
      ["m2", { parents: ["m1"], time: 4, tree: "t" }],
      ["y1", { parents: ["m2"], time: 5, tree: "t" }],
      ["y2", { parents: ["y1"], time: 6, tree: "t" }],
      ["m3", { parents: ["m2", "y2"], time: 7, tree: "t" }],
      ["z1", { parents: ["y2"], time: 8, tree: "t" }],
    ]),
  );

  it("a branch off an older main", async () => {
    expect(await compareWith(read, "m3", "b1")).toEqual({ mergeBase: "m1", ahead: 1, behind: 4, aheadCommits: ["b1"] });
  });

  it("a stacked branch after the lower branch merged", async () => {
    expect(await compareWith(read, "m3", "z1")).toEqual({ mergeBase: "y2", ahead: 1, behind: 1, aheadCommits: ["z1"] });
  });

  it("lists a branch's own commits newest first even within one second", async () => {
    const same = readerOf(
      new Map([
        ["r", { parents: [], time: 1, tree: "t" }],
        ["c1", { parents: ["r"], time: 5, tree: "t" }],
        ["c2", { parents: ["c1"], time: 5, tree: "t" }],
        ["c3", { parents: ["c2"], time: 5, tree: "t" }],
      ]),
    );

    const out = await compareWith(same, "r", "c3");
    expect(out.aheadCommits).toEqual(["c3", "c2", "c1"]);
  });

  it("the same commit", async () => {
    expect(await compareWith(read, "m3", "m3")).toEqual({ mergeBase: "m3", ahead: 0, behind: 0, aheadCommits: [] });
  });
});

describe("the merge gate", () => {
  const st = (context: string, state: StatusRecord["state"]): StatusRecord => ({
    sha: A, context, state, target_url: null, description: null, creator: "x", app: null, created_at: "",
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
    // Reserved names guard namespaces now (the first URL segment), not monorepo names.
    expect(validMonorepoName("v1")).toBe(true);
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

describe("the auth cache keeps successes only", () => {
  const user = { login: "ana", name: null, email: null, picture_url: null, created_at: "" };
  const credential = { id: "c", name: "m", kind: "machine" as const, created_at: "", last_used_at: null };
  const mono = { id: "m_1", owner: "ana", name: "acme", full_name: "ana/acme", kind: "monorepo" as const, created_at: "" };
  const auth = (over: Partial<Auth>): Auth => ({ user, credential, role: "member", monorepo: mono, ...over });

  it("caches a member of an existing monorepo", () => {
    expect(cacheable(auth({}), "acme")).toBe(true);
  });
  it("caches a known credential when no monorepo is asked", () => {
    expect(cacheable(auth({ role: null, monorepo: null }), null)).toBe(true);
  });
  it("never caches an unknown credential", () => {
    expect(cacheable(null, "acme")).toBe(false);
    expect(cacheable(null, null)).toBe(false);
  });
  it("never caches a monorepo that does not exist yet", () => {
    expect(cacheable(auth({ monorepo: null, role: null }), "acme")).toBe(false);
  });
  it("never caches a caller who is not a member yet", () => {
    expect(cacheable(auth({ role: null }), "acme")).toBe(false);
  });
});

describe("Pando's commit trailers", () => {
  it("reads the three from the last paragraph", () => {
    const msg = "Add login\n\nBody text.\n\nPando-Agent: agent-3\nPando-Worktree: projects/web/worktrees/login\nPando-Machine: ramos-mbp\n";
    expect(pandoTrailers(msg)).toEqual({ agent: "agent-3", worktree: "projects/web/worktrees/login", machine: "ramos-mbp" });
  });
  it("ignores look-alikes outside the last paragraph and missing ones", () => {
    expect(pandoTrailers("Pando-Agent: not a trailer\n\nbody")).toEqual({ agent: null, worktree: null, machine: null });
    expect(pandoTrailers("One line")).toEqual({ agent: null, worktree: null, machine: null });
  });
  it("keeps other trailers out and accepts any case", () => {
    expect(pandoTrailers("T\n\nSigned-off-by: x\npando-machine: box")).toEqual({ agent: null, worktree: null, machine: "box" });
  });
});

describe("the write gate", () => {
  it("lets two in at once, the rest in order", async () => {
    const { WriteGate } = await import("../src/monorepo/gate");
    const g = new WriteGate(2, 1000, 1000);
    const order: string[] = [];
    const l1 = await g.acquire("r");
    const l2 = await g.acquire("r");
    const w3 = g.acquire("r").then((l) => (order.push("third"), l));
    const w4 = g.acquire("r").then((l) => (order.push("fourth"), l));
    expect(g.stats("r")).toEqual({ held: 2, waiting: 2 });
    g.release("r", l1);
    await w3;
    g.release("r", l2);
    await w4;
    expect(order).toEqual(["third", "fourth"]);
  });

  it("frees a slot whose lease runs out, and turns away a writer that waits too long", async () => {
    const { WriteGate, GateBusy } = await import("../src/monorepo/gate");
    const g = new WriteGate(1, 50, 200);
    await g.acquire("r"); // never released: the lease ends after 50 ms
    const next = await g.acquire("r");
    expect(next).toEqual(expect.any(String));
    const slow = new WriteGate(1, 10_000, 50);
    await slow.acquire("r");
    await expect(slow.acquire("r")).rejects.toBeInstanceOf(GateBusy);
  });

  it("renewing keeps a lease alive", async () => {
    const { WriteGate } = await import("../src/monorepo/gate");
    const g = new WriteGate(1, 80, 1000);
    const l = await g.acquire("r");

    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 40));
      expect(g.renew("r", l)).toBe(true);
    }

    expect(g.stats("r").held).toBe(1);
  });
});

describe("event topics", () => {
  it("tags main moves, repos, kinds and the meta layer", async () => {
    const { eventTags, parseTopics } = await import("../src/monorepo/stream");
    expect(eventTags({ kind: "default_head.updated", repo: "projects-web", collection: "default_heads" })).toEqual(
      ["all", "kind:default_head.updated", "repo:projects-web", "main", "main:projects-web"],
    );
    expect(eventTags({ kind: "meta.saved", repo: "meta", collection: "meta_files" })).toContain("meta");
    expect(eventTags({ kind: "machine.connected", repo: "meta", collection: "presence" })).toContain("meta");
    expect(parseTopics(null)).toEqual(["all"]);
    expect(parseTopics("main,repo:projects-web")).toEqual(["main", "repo:projects-web"]);
    expect(parseTopics("nope")).toBeNull();
  });
});

describe("ERR answers from receive-pack", () => {
  it("are read as errors, not as a missing unpack line", () => {
    const r = parseReport(pkt("ERR artifacts_git_receive_pack_busy\n"), new Set(["report-status"]));
    expect(r.error).toBe("artifacts_git_receive_pack_busy");
  });
});

describe("browser sign-in helpers", () => {
  it("returns only to a path on this host", async () => {
    const { safeReturnTo } = await import("../src/accounts/signin");
    expect(safeReturnTo("/pando/projects/web")).toBe("/pando/projects/web");
    expect(safeReturnTo("//evil.example/x")).toBe("/");
    expect(safeReturnTo("https://evil.example/")).toBe("/");
    expect(safeReturnTo("/\\evil.example")).toBe("/");
    expect(safeReturnTo("/a\nb")).toBe("/");
    expect(safeReturnTo(null)).toBe("/");
  });
  it("names a session by browser and system", async () => {
    const { browserName } = await import("../src/accounts/signin");
    expect(browserName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15")).toBe("browser: Safari on macOS");
    expect(browserName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0")).toBe("browser: Edge on Windows");
    expect(browserName(null)).toBe("browser: a browser");
  });
});

describe("the write gate's release delay", () => {
  it("keeps a released slot taken for the delay, then lets the next writer in", async () => {
    const { WriteGate } = await import("../src/monorepo/gate");
    const g = new WriteGate(1, 10_000, 5_000, 120);
    const l1 = await g.acquire("r");
    let got = 0;
    const next = g.acquire("r").then(() => (got = Date.now()));
    const t0 = Date.now();
    expect(g.release("r", l1)).toBe(true);
    expect(g.release("r", l1)).toBe(false); // a second release is a no-op
    expect(g.renew("r", l1)).toBe(false); // and it cannot be renewed while releasing
    expect(g.stats("r").held).toBe(1);
    await next;
    expect(got - t0).toBeGreaterThanOrEqual(110);
  });
  it("a release with no hold lets the next writer in at once", async () => {
    const { WriteGate } = await import("../src/monorepo/gate");
    const g = new WriteGate(1, 10_000, 5_000, 500);
    const l1 = await g.acquire("r");
    const next = g.acquire("r");
    const t0 = Date.now();
    expect(g.release("r", l1, 0)).toBe(true);
    await next;
    expect(Date.now() - t0).toBeLessThan(100);
  });
  it("reads GATE_RELEASE_MS, else the default", async () => {
    const { releaseDelay, RELEASE_DELAY_MS } = await import("../src/monorepo/gate");
    expect(releaseDelay({})).toBe(RELEASE_DELAY_MS);
    expect(releaseDelay({ GATE_RELEASE_MS: "0" })).toBe(0);
    expect(releaseDelay({ GATE_RELEASE_MS: "350" })).toBe(350);
    expect(releaseDelay({ GATE_RELEASE_MS: "nope" })).toBe(RELEASE_DELAY_MS);
  });
});

describe("RPC results are released on arrival", () => {
  it("calls the result's disposer once and drops it, keeping the data", async () => {
    const { released } = await import("../src/timing");
    const D = Symbol.dispose;
    let calls = 0;
    const r = { token: "t", n: 2 };
    Object.defineProperty(r, D, { value: () => calls++, enumerable: false, configurable: true });
    const out = released(r);
    expect(calls).toBe(1);
    expect(D in out).toBe(false);
    expect(out.token).toBe("t");
    const arr = Object.defineProperty([1, 2], D, { value: () => calls++, configurable: true });
    expect(released(arr)).toEqual([1, 2]);
    expect(calls).toBe(2);
    expect(released(null)).toBe(null);
    expect(released(true)).toBe(true);
    expect(released({ plain: 1 })).toEqual({ plain: 1 });
  });
});

describe("a person's picture", () => {
  it("keeps https URLs only, at most 2,048 characters", async () => {
    const { pictureUrl } = await import("../src/accounts/signin");
    expect(pictureUrl("https://workoscdn.com/images/v1/123abc")).toBe("https://workoscdn.com/images/v1/123abc");
    expect(pictureUrl("http://example.com/a.png")).toBe(null);
    expect(pictureUrl("javascript:alert(1)")).toBe(null);
    expect(pictureUrl("data:image/png;base64,AAAA")).toBe(null);
    expect(pictureUrl("not a url")).toBe(null);
    expect(pictureUrl(`https://x.example/${"a".repeat(2100)}`)).toBe(null);
    expect(pictureUrl(null)).toBe(null);
    expect(pictureUrl(undefined)).toBe(null);
  });
});

describe("the home's activity feed (C25)", () => {
  const ev = (monorepo_id: string, seq: number, at: string) => ({ monorepo_id, monorepo: `o/${monorepo_id}`, seq, at, kind: "push", repo: null, repo_path: null, branch: null, actor: null, machine: null, summary: null });
  it("orders by (at, monorepo, seq), newest first, and merges sources once each", async () => {
    const { mergePages } = await import("../src/feed/shape");
    const a = [ev("a", 3, "2026-10-03T10:00:02.000Z"), ev("a", 2, "2026-10-03T10:00:01.000Z")];
    const b = [ev("b", 9, "2026-10-03T10:00:02.000Z"), ev("a", 2, "2026-10-03T10:00:01.000Z"), ev("b", 1, "2026-10-03T09:00:00.000Z")];
    const page = mergePages([a, b], 3);
    expect(page.map((e) => `${e.monorepo_id}${e.seq}`)).toEqual(["b9", "a3", "a2"]);
  });
  it("round-trips the cursor and refuses junk", async () => {
    const { decodeCursor, encodeCursor } = await import("../src/feed/shape");
    const k = { at: "2026-10-03T10:00:02.123Z", monorepo_id: "m_0123456789abcdef", seq: 41 };
    const c = encodeCursor(k);
    expect(c.length).toBeLessThan(64);
    expect(decodeCursor(c)).toEqual(k);
    expect(decodeCursor("nope")).toBeNull();
    expect(decodeCursor(encodeCursor({ ...k, seq: -1 }))).toBeNull();
  });
  it("bounds one monorepo's log by the cursor", async () => {
    const { seqBound } = await import("../src/feed/shape");
    const c = { at: "2026-10-03T10:00:00.000Z", monorepo_id: "m", seq: 5 };
    expect(seqBound(c, "a")).toBe(Number.MAX_SAFE_INTEGER); // sorts after m at the same time: all of it is older
    expect(seqBound(c, "z")).toBe(0);
    expect(seqBound(c, "m")).toBe(5);
  });
  it("knows when the window does not cover a page", async () => {
    const { effectiveAfter, uncovered, PENDING } = await import("../src/feed/shape");
    expect(uncovered(null, null)).toBe(false); // the whole history is in the feed
    expect(uncovered("2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z")).toBe(false);
    expect(uncovered("2026-10-02T00:00:00.000Z", "2026-10-01T00:00:00.000Z")).toBe(true);
    expect(uncovered("2026-10-01T00:00:00.000Z", null)).toBe(true); // the page is not full: older events may exist
    expect(uncovered(PENDING, "2026-10-03T00:00:00.000Z")).toBe(true);
    expect(effectiveAfter(null, "2026-09-26T00:00:00.000Z")).toBe("2026-09-26T00:00:00.000Z");
    expect(effectiveAfter("2026-09-20T00:00:00.000Z", "2026-09-26T00:00:00.000Z")).toBe("2026-09-26T00:00:00.000Z");
  });
  it("reads Co-authored-by trailers", async () => {
    const { coAuthors } = await import("../src/monorepo/views");
    const msg = "Add a\n\nBody line\n\nCo-authored-by: Claude <noreply@anthropic.com>\nco-authored-by: Ana Lima <ana@x.dev>\nCo-authored-by: Claude <noreply@anthropic.com>\nPando-Machine: m";
    expect(coAuthors(msg)).toEqual([{ name: "Claude", email: "noreply@anthropic.com" }, { name: "Ana Lima", email: "ana@x.dev" }]);
    expect(coAuthors("Co-authored-by: Not <a@trailer>")).toEqual([]); // a one-paragraph message has no trailers
  });
  it("accepts the feed topic on a monorepo's socket", async () => {
    const { parseTopics } = await import("../src/monorepo/stream");
    expect(parseTopics("feed")).toEqual(["feed"]);
  });
});

describe("namespaces", () => {
  it("a namespace: 1 to 39 of a-z, 0-9, single inner hyphens; not reserved", async () => {
    const { namespaceProblem } = await import("../src/monorepo/names");
    expect(namespaceProblem("ramos")).toBe(null);
    expect(namespaceProblem("ana-lima")).toBe(null);
    expect(namespaceProblem("a".repeat(39))).toBe(null);
    expect(namespaceProblem("a".repeat(40))).toBe("invalid");
    expect(namespaceProblem("ana-")).toBe("invalid");
    expect(namespaceProblem("-ana")).toBe("invalid");
    expect(namespaceProblem("ana--lima")).toBe("invalid");
    expect(namespaceProblem("Ana")).toBe("invalid"); // callers lower-case first
    expect(namespaceProblem("ana.lima")).toBe("invalid");
    expect(namespaceProblem("v1")).toBe("reserved");
    expect(namespaceProblem("settings")).toBe("reserved");
    expect(namespaceProblem("docs")).toBe("reserved"); // the app's /docs goes to the docs site
  });
  it("owner/name from a path, matched without case", async () => {
    const { monorepoRef } = await import("../src/monorepo/names");
    expect(monorepoRef("Ramos", "Pando")).toEqual({ owner: "ramos", name: "pando" });
    expect(monorepoRef("ramos", "a--b")).toBe(null);
    expect(monorepoRef("ramos-", "pando")).toBe(null);
    expect(monorepoRef(undefined, "pando")).toBe(null);
  });
  it("new ids are m_ and 16 hex", async () => {
    const { newMonorepoId } = await import("../src/monorepo/names");
    expect(newMonorepoId()).toMatch(/^m_[0-9a-f]{16}$/);
  });
  it("logins from an email skip reserved names and never end in a hyphen", async () => {
    const { loginsFor } = await import("../src/accounts/store");
    const first = (email: string, n = 3) => [...loginsFor(email, null)].slice(0, n);
    expect(first("ana@example.com")).toEqual(["ana", "ana-2", "ana-3"]);
    expect(first("login@example.com", 2)).toEqual(["login-2", "login-3"]);
    expect(first("Ana.Lima+tag@example.com", 1)).toEqual(["ana-lima-tag"]);
    const cut = first(`${"a".repeat(31)}.b@example.com`, 2);
    expect(cut).toEqual(["a".repeat(31), `${"a".repeat(31)}-2`]);
    expect(first("@example.com", 1)).toEqual(["user"]);
  });
});

describe("the file pages (FILES.md)", () => {
  it("paths: no empty, . or .. segments; slashes trimmed", async () => {
    const { cleanPath } = await import("../src/monorepo/files");
    expect(cleanPath("")).toBe("");
    expect(cleanPath(undefined)).toBe("");
    expect(cleanPath("/src/lib/")).toBe("src/lib");
    expect(() => cleanPath("src/../etc")).toThrow();
    expect(() => cleanPath("src//x")).toThrow();
    expect(() => cleanPath("./x")).toThrow();
  });
  it("raw: images as images, text (HTML and SVG too) as text, a NUL as binary; sandboxed", async () => {
    const { rawResponse } = await import("../src/monorepo/files");
    const as = async (name: string, bytes: Uint8Array) => (await rawResponse(new Response(bytes), name, "a".repeat(40), false, false)).headers;
    const enc = new TextEncoder();
    expect((await as("x.png", Uint8Array.of(0x89, 0, 1))).get("content-type")).toBe("image/png");
    expect((await as("x.html", enc.encode("<script>1</script>"))).get("content-type")).toBe("text/plain; charset=utf-8");
    expect((await as("x.svg", enc.encode("<svg/>"))).get("content-type")).toBe("text/plain; charset=utf-8");
    expect((await as("x.bin", Uint8Array.of(1, 0, 2))).get("content-type")).toBe("application/octet-stream");
    const h = await as("README", enc.encode("hi"));
    expect(h.get("content-security-policy")).toContain("sandbox");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("cache-control")).toBe("private, no-cache");
    const pinned = await rawResponse(new Response("hi"), "a.txt", "b".repeat(40), true, false);
    expect(pinned.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(await pinned.text()).toBe("hi");
  });
  it("a test budget, else the default", async () => {
    const { requestBudget, REQUEST_BUDGET } = await import("../src/monorepo/files");
    expect(requestBudget({})).toEqual(REQUEST_BUDGET);
    expect(requestBudget({ FILES_BUDGET: "1" }).misses).toBe(1);
  });
});

describe("raw ETags", () => {
  it("If-None-Match matches weakly: W/, lists and *", async () => {
    const { matchesEtag } = await import("../src/monorepo/files");
    const oid = "a".repeat(40);
    expect(matchesEtag(`"${oid}"`, oid)).toBe(true);
    expect(matchesEtag(`W/"${oid}"`, oid)).toBe(true);
    expect(matchesEtag(`"x", W/"${oid}"`, oid)).toBe(true);
    expect(matchesEtag("*", oid)).toBe(true);
    expect(matchesEtag(`"${"b".repeat(40)}"`, oid)).toBe(false);
    expect(matchesEtag(null, oid)).toBe(false);
  });
});

describe("parse guards (worker/src/parse.ts)", () => {
  it("tells the JSON kinds apart", () => {
    expect([isText("a"), isText(""), isText(1), isText(null), isText(undefined)]).toEqual([true, true, false, false, false]);
    expect([isWholeNumber(0), isWholeNumber(7), isWholeNumber(-1), isWholeNumber(1.5), isWholeNumber("3"), isWholeNumber(2 ** 53)]).toEqual([true, true, false, false, false, false]);
    expect([isRecord({}), isRecord({ a: 1 }), isRecord([]), isRecord(null), isRecord("x"), isRecord(undefined)]).toEqual([true, true, false, false, false, false]);
    expect([isTextList([]), isTextList(["a", "b"]), isTextList(["a", 1]), isTextList("a")]).toEqual([true, true, false, false]);
  });

  it("reads a thrown value's code, and JSON text", () => {
    expect([hasCode({ code: "NOT_FOUND" }), hasCode(Object.assign(new Error("x"), { code: "E" })), hasCode({ code: 404 }), hasCode(new Error("x")), hasCode(null)]).toEqual([true, true, false, false, false]);
    expect(parseJson('{"a":[1,"b"]}')).toEqual({ a: [1, "b"] });
    expect(parseJson("not json")).toBe(null);
  });
});
