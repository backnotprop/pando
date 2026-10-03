// Unit tests for ci/: the status token. The routes are tested end to end by
// test/ci.mjs against wrangler dev.
import { describe, expect, it } from "vitest";
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
