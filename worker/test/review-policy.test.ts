// Risk-based review's rules (src/review/policy.ts) and clef's answer read
// into a score (src/review/risk.ts): real logic with edges. The flow itself
// is tested end to end by test/risk-review.mjs against a real Worker.
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, gateOf, isSensitive, levelOf, sensitiveOf, settingsPatch, tierOf } from "../src/review/policy";
import { readAnswer, STATE_MAX_CHARS, stateOf } from "../src/review/risk";

const S = { ...DEFAULT_SETTINGS };

describe("sensitive paths", () => {
  it("a folder pattern matches anywhere in the path", () => {
    expect(isSensitive("auth/login.ts", "auth/")).toBe(true);
    expect(isSensitive("src/auth/login.ts", "auth/")).toBe(true);
    expect(isSensitive("src/oauth/login.ts", "auth/")).toBe(false);
    expect(isSensitive("authors.md", "auth/")).toBe(false);
  });

  it("a name pattern matches a file name or its start", () => {
    expect(isSensitive("config/.env.local", ".env")).toBe(true);
    expect(isSensitive("deploy/secrets.yaml", "secrets")).toBe(true);
    expect(isSensitive("src/environment.ts", ".env")).toBe(false);
  });

  it("a pattern with a slash is a path from the root, or below a folder", () => {
    expect(isSensitive("infra/main.tf", "infra/main.tf")).toBe(true);
    expect(isSensitive("deploy/infra/main.tf", "infra/main.tf")).toBe(true);
    expect(isSensitive("infra/main.tfvars", "infra/main.tf")).toBe(false);
  });

  it("lists the matching files only, and an empty pattern matches nothing", () => {
    expect(sensitiveOf(["docs/a.md", "payments/charge.ts", ".github/workflows/ci.yml"], ["payments/", ".github/", ""])).toEqual(["payments/charge.ts", ".github/workflows/ci.yml"]);
  });
});

describe("tiers", () => {
  it("bands: below auto_below auto, at human_above human, between ai", () => {
    expect(tierOf(0.34, 0, S)).toBe("auto");
    expect(tierOf(0.35, 0, S)).toBe("ai");
    expect(tierOf(0.69, 0, S)).toBe("ai");
    expect(tierOf(0.7, 0, S)).toBe("human");
    expect(levelOf(0.1, S)).toBe("low");
    expect(levelOf(0.5, S)).toBe("medium");
    expect(levelOf(0.9, S)).toBe("high");
  });

  it("unknown is never auto, and a sensitive path asks a person unless turned off", () => {
    expect(tierOf(null, 0, S)).toBe("human");
    expect(levelOf(null, S)).toBe("unknown");
    expect(tierOf(0.05, 1, S)).toBe("human");
    expect(tierOf(0.05, 1, { ...S, human_for_sensitive: false })).toBe("auto");
  });

  it("thresholds move the bands", () => {
    expect(tierOf(0.5, 0, { ...S, auto_below: 0.6 })).toBe("auto");
    expect(tierOf(0.5, 0, { ...S, human_above: 0.5 })).toBe("human");
  });
});

describe("settings", () => {
  it("takes a partial change, rounds to hundredths, keeps the rest", () => {
    expect(settingsPatch({ auto_below: 0.2049 }, S)).toEqual({ ok: true, settings: { ...S, auto_below: 0.2 } });
    expect(settingsPatch({ enabled: false }, S)).toEqual({ ok: true, settings: { ...S, enabled: false } });
  });

  it("refuses unknown keys, numbers out of range, and crossed thresholds", () => {
    expect(settingsPatch({ colour: "red" }, S).ok).toBe(false);
    expect(settingsPatch({ human_above: 1.5 }, S).ok).toBe(false);
    expect(settingsPatch({ auto_below: 0.8, human_above: 0.7 }, S).ok).toBe(false);
    expect(settingsPatch({ enabled: "yes" }, S).ok).toBe(false);
    expect(settingsPatch(null, S).ok).toBe(false);
  });
});

describe("the gate's review part", () => {
  const r = (label: string, state: "running" | "posted" | "failed", verdict: "comment" | "request_changes" | "approve" | null = null) => ({ label, state, verdict });

  it("auto passes; classifying and human wait; a person's approval passes any tier", () => {
    expect(gateOf({ tier: "auto", reviewers: [], approvedBy: null }).passes).toBe(true);
    expect(gateOf({ tier: null, reviewers: [], approvedBy: null }).passes).toBe(false);
    expect(gateOf({ tier: "human", reviewers: [r("Security", "posted", "comment")], approvedBy: null }).passes).toBe(false);
    expect(gateOf({ tier: "human", reviewers: [], approvedBy: "dee" }).passes).toBe(true);
    expect(gateOf({ tier: "ai", reviewers: [r("Security", "posted", "request_changes")], approvedBy: "dee" }).passes).toBe(true);
  });

  it("ai passes when every reviewer posted and none asked for changes", () => {
    expect(gateOf({ tier: "ai", reviewers: [r("Correctness", "posted", "comment"), r("Security", "posted", "comment")], approvedBy: null }).passes).toBe(true);
    const waiting = gateOf({ tier: "ai", reviewers: [r("Correctness", "posted", "comment"), r("Security", "running")], approvedBy: null });
    expect(waiting).toEqual({ passes: false, why: "waiting for the Security review" });
    const asked = gateOf({ tier: "ai", reviewers: [r("Correctness", "posted", "request_changes"), r("Security", "running")], approvedBy: null });
    expect(asked.why).toMatch(/^Correctness asked for changes/);
  });

  it("ai with a reviewer that never ran, or none launched, needs a person", () => {
    expect(gateOf({ tier: "ai", reviewers: [r("Correctness", "failed")], approvedBy: null }).why).toMatch(/Correctness did not review/);
    expect(gateOf({ tier: "ai", reviewers: [], approvedBy: null }).passes).toBe(false);
  });
});

describe("clef's answer", () => {
  it("reads the score as 0 to 1, the levels, the path, the nouls and the tokens", () => {
    const out = {
      model: "@cf/cloudflare/clef",
      answers: {
        risk: { type: "score", score: 1.5, probabilities: { "0": 0.1, "1": 0.3, "2": 0.6 }, confidence: 0.7 },
        review_path: { type: "choice", choice: "human", probabilities: { auto: 0.1, ai: 0.2, human: 0.7 }, confidence: 0.6 },
        sensitive: { type: "noul", noul: 0.9 },
        destructive: 0.2,
      },
      usage: { prompt_tokens: 1000 },
    };

    const a = readAnswer(out, 4000, 50);
    expect(a.ok && a.c).toMatchObject({ score: 0.75, levels: { low: 0.1, medium: 0.3, high: 0.6 }, path: { choice: "human" }, sensitive: 0.9, destructive: 0.2, tokens: 1000 });
    expect(a.ok && a.c.cost_usd).toBeCloseTo(0.00024, 8);
  });

  it("no score is no answer; no usage counts 4 characters a token", () => {
    expect(readAnswer({ answers: {} }, 10, 0).ok).toBe(false);
    expect(readAnswer(null, 10, 0).ok).toBe(false);
    const a = readAnswer({ answers: { risk: { score: 0 } } }, 4001, 0);
    expect(a.ok && a.c.tokens).toBe(1001);
  });
});

describe("the state", () => {
  it("stays under its cap, hunks cut first, and says how many files' changes it left out", () => {
    const big = Array.from({ length: 400 }, (_, i) => ({ path: `src/f${i}.ts`, status: "modified", additions: 300, deletions: 0, binary: false, hunks: [Array.from({ length: 40 }, () => `+${"x".repeat(300)}`)] }));
    const s = stateOf({ repo: "web", branch: "b", title: "t", description: null, author: "a person, ramos", commits: ["one"], files: big, files_total: 400, sensitive_patterns: ["auth/"], sensitive_hits: [] });
    expect(s.length).toBeLessThanOrEqual(STATE_MAX_CHARS);
    expect(s).toMatch(/and 100 more files/);
    expect(s).toMatch(/more files' changes not shown/);
    expect(s).not.toMatch(/x{201}/);
  });
});
