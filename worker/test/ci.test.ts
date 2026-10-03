// Unit tests for ci/: the status token and Buildkite's adapter. The routes
// are tested end to end by test/ci.mjs against wrangler dev.
import { describe, expect, it } from "vitest";
import { buildState, jobCheck, jobState, normalizeBuild, normalizeJob, normalizePipeline, orgFromUrl, rateWaitMs, verifyWebhook, type NormJob } from "../src/ci/buildkite";
import { CiStore, decodeCursor, encodeCursor, READS_PER_MIN } from "../src/ci/store";
import { mintStatusToken, stampOf, STATUS_TOKEN_TTL_S, verifyStatusToken } from "../src/ci/statustoken";

const SECRET = "unit-test-secret";
const SHA = "a".repeat(40);
const claims = { m: "m_0123456789abcdef", r: "projects-web", s: SHA, a: "buildkite", h: "hk_1" };

describe("the status token", () => {
  it("mints pst1.<payload>.<signature> and verifies it", async () => {
    const t0 = Date.parse("2026-10-03T12:00:00Z");
    const { token, expires_at } = await mintStatusToken(SECRET, claims, t0);
    expect(token).toMatch(/^pst1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(expires_at) - t0).toBe(STATUS_TOKEN_TTL_S * 1000);
    const v = await verifyStatusToken(SECRET, token, t0 + 1000);
    expect(v).toEqual({ ok: true, claims: { ...claims, x: t0 / 1000 + STATUS_TOKEN_TTL_S } });
  });

  it("lives 24 hours, then is expired", async () => {
    const t0 = Date.parse("2026-10-03T12:00:00Z");
    const { token } = await mintStatusToken(SECRET, claims, t0);
    expect((await verifyStatusToken(SECRET, token, t0 + 24 * 3600_000 - 1000)).ok).toBe(true);
    expect(await verifyStatusToken(SECRET, token, t0 + 24 * 3600_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses another secret (rotation ends every token)", async () => {
    const { token } = await mintStatusToken(SECRET, claims);
    expect(await verifyStatusToken("rotated", token)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a forged app: the payload changed, the signature kept", async () => {
    const { token } = await mintStatusToken(SECRET, { ...claims, a: null });
    const [p, payload, sig] = token.split(".");
    const forged = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    forged.a = "buildkite";
    const b64 = btoa(JSON.stringify(forged)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifyStatusToken(SECRET, `${p}.${b64}.${sig}`)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses malformed tokens", async () => {
    for (const t of ["pst1.", "pst1.a.b", "pando_abc", "pst1.e30.AAAA", "pst1.!!.??"]) {
      expect((await verifyStatusToken(SECRET, t)).ok).toBe(false);
    }
  });

  it("stamps app:<slug>, or hook:<id> when the hook has no app", () => {
    expect(stampOf({ a: "buildkite", h: "hk_1" })).toEqual({ app: "buildkite", creator: "app:buildkite" });
    expect(stampOf({ a: null, h: "hk_2" })).toEqual({ app: null, creator: "hook:hk_2" });
  });

  it("refuses to mint a bad app slug", async () => {
    await expect(mintStatusToken(SECRET, { ...claims, a: "Build Kite" })).rejects.toThrow();
  });
});

describe("Buildkite's states, mapped", () => {
  it("builds", () => {
    expect(["creating", "scheduled", "waiting"].map(buildState)).toEqual(["queued", "queued", "queued"]);
    expect(["running", "failing", "canceling"].map(buildState)).toEqual(["running", "running", "running"]);
    expect(["passed", "failed", "blocked", "canceled", "skipped", "not_run"].map(buildState)).toEqual(["passed", "failed", "blocked", "canceled", "skipped", "skipped"]);
  });
  it("jobs", () => {
    expect(jobState("timed_out", 1)).toBe("failed");
    expect(jobState("broken", null)).toBe("skipped");
    expect(jobState("finished", 0)).toBe("passed");
    expect(jobState("finished", 2)).toBe("failed");
    expect(jobState("assigned", null)).toBe("queued");
  });
});

describe("a job's check", () => {
  const job = (o: Partial<NormJob>): NormJob => ({
    external_id: "j", name: "ci", step_key: "ci", type: "script", service_state: "passed", state: "passed", exit_status: 0, soft_failed: false,
    retried: false, web_url: null, created_at: null, started_at: "2026-10-03T12:00:00Z", finished_at: "2026-10-03T12:01:12Z", ...o,
  });
  it("passed, failed, soft failed", () => {
    expect(jobCheck(job({}), 1285)).toEqual({ state: "success", description: "#1285 passed in 1 min 12 s" });
    expect(jobCheck(job({ service_state: "failed", state: "failed", exit_status: 1 }), 7)).toEqual({ state: "failure", description: "#7 failed, exit status 1" });
    expect(jobCheck(job({ service_state: "failed", state: "failed", exit_status: 1, soft_failed: true }), 7).state).toBe("success");
  });
  it("a skipped step passes; a job that never ran because of an earlier failure, or that no agent took, does not", () => {
    expect(jobCheck(job({ service_state: "skipped", state: "skipped" }), 1).state).toBe("success");
    expect(jobCheck(job({ service_state: "broken", state: "skipped" }), 1).state).toBe("error");
    expect(jobCheck(job({ service_state: "expired", state: "failed" }), 1).state).toBe("error");
    expect(jobCheck(job({ service_state: "running", state: "running" }), 1)).toEqual({ state: "pending", description: "#1 running" });
  });
});

describe("Buildkite payloads", () => {
  const pipeline = normalizePipeline({ slug: "pando-ci", name: "pando-ci", url: "https://api.buildkite.com/v2/organizations/Acme/pipelines/pando-ci", web_url: "https://buildkite.com/acme/pando-ci" });
  it("the organization from an API or web URL, lower case", () => {
    expect(pipeline?.org).toBe("acme");
    expect(orgFromUrl("https://buildkite.com/acme/pando-ci/builds/3")).toBe("acme");
    expect(orgFromUrl("https://example.com/x")).toBeNull();
  });
  it("a build: Pando's meta_data kept, nothing else", () => {
    const b = normalizeBuild({ id: "b1", number: 3, state: "failing", commit: "A".repeat(40), meta_data: { pando_delivery: "dlv_1", other: "x" }, created_at: "2026-10-03T12:00:00Z" }, pipeline);
    expect(b).toMatchObject({ external_id: "b1", number: 3, state: "running", commit: "a".repeat(40), pipeline: "pando-ci", org: "acme", meta_data: { pando_delivery: "dlv_1" } });
    expect(normalizeBuild({ id: "b1" }, pipeline)).toBeNull();
  });
  it("a job", () => {
    expect(normalizeJob({ id: "j1", type: "script", label: "unit tests", step_key: "ci", state: "failed", exit_status: 1 })).toMatchObject({ name: "unit tests", step_key: "ci", state: "failed", exit_status: 1 });
  });
});

describe("Buildkite's webhook signature", () => {
  const secret = "s3cret-token-0123456789";
  const body = JSON.stringify({ event: "ping" });
  // Computed here with Web Crypto, apart from the code under test.
  const sig = async (ts: number, key = secret) => {
    const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${ts}.${body}`)));
    return `timestamp=${ts},signature=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  };
  it("accepts HMAC-SHA256 of '<timestamp>.<body>' within 5 minutes", async () => {
    expect(await verifyWebhook(secret, { token: null, signature: await sig(1000) }, body, 1100)).toEqual({ ok: true, ts: 1000 });
  });
  it("refuses another key, an old timestamp, a changed body, a wrong token, nothing", async () => {
    expect((await verifyWebhook(secret, { token: null, signature: await sig(1000, "other") }, body, 1000)).ok).toBe(false);
    expect((await verifyWebhook(secret, { token: null, signature: await sig(1000) }, body, 1301)).ok).toBe(false);
    expect((await verifyWebhook(secret, { token: null, signature: await sig(1000) }, body + " ", 1000)).ok).toBe(false);
    expect((await verifyWebhook(secret, { token: "nope", signature: null }, body, 1000)).ok).toBe(false);
    expect((await verifyWebhook(secret, { token: null, signature: null }, body, 1000)).ok).toBe(false);
    expect(await verifyWebhook(secret, { token: secret, signature: null }, body, 1000)).toEqual({ ok: true, ts: null });
  });
});

describe("Buildkite's rate limit", () => {
  it("waits on a 429 or a spent remaining count, for the longer reset", () => {
    expect(rateWaitMs(new Response("", { status: 429, headers: { "ratelimit-reset": "12" } }))).toBe(12_000);
    expect(rateWaitMs(new Response("", { status: 200, headers: { "ratelimit-user-remaining": "0", "ratelimit-user-reset": "40", "ratelimit-reset": "5" } }))).toBe(40_000);
    expect(rateWaitMs(new Response("", { status: 200, headers: { "ratelimit-remaining": "3" } }))).toBeNull();
  });
  it("a connection makes at most READS_PER_MIN calls a minute, and waits when told", () => {
    const store = new CiStore({} as DurableObjectState, {} as never, {} as SqlStorage, {} as never);
    const t = 1_000_000;
    for (let i = 0; i < READS_PER_MIN; i++) expect(store.permit("c", t + i).ok).toBe(true);
    const no = store.permit("c", t + 100);
    expect(no).toEqual({ ok: false, retry_after_ms: 60_000 - 100 });
    expect(store.permit("c", t + 60_001).ok).toBe(true);
    expect(store.permit("other", t).ok).toBe(true);
  });
});

describe("the builds cursor", () => {
  it("round-trips, and refuses junk", () => {
    expect(decodeCursor(encodeCursor("2026-10-03T12:00:00.000Z", "cib_1"))).toEqual({ sort_at: "2026-10-03T12:00:00.000Z", id: "cib_1" });
    expect(decodeCursor("!!")).toBeNull();
  });
});
