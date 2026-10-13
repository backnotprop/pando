// Reviewer profiles: data, not code. A profile is a name and what the review
// session is told to look at, added to "Review with agent"'s prompt. The ai
// and human tiers launch AUTO_PROFILES, one session each, in parallel; a
// person can pick any profile for "Review with agent". Per-project lists and
// a coordinator that merges the profiles' reviews into one come later.

export interface Profile {
  name: string;
  label: string;
  instructions: string;
}

export const PROFILES: readonly Profile[] = [
  {
    name: "correctness",
    label: "Correctness",
    instructions: "Look for bugs: wrong logic, edge cases (empty, null, very large, concurrent), error paths that are swallowed, and behaviour that changed without the callers changing. Run the tests that cover the changed code.",
  },
  {
    name: "security",
    label: "Security",
    instructions: "Look for security problems: authentication and permission checks skipped or weakened, secrets in code or logs, input used unchecked in queries, paths, shell commands or HTML, and data exposed to people who should not see it.",
  },
  {
    name: "tests",
    label: "Tests",
    instructions: "Check the tests: does each changed behaviour have a test that would fail without the change, do the tests pass in the sandbox, and are any tests removed or weakened.",
  },
  {
    name: "docs",
    label: "Docs",
    instructions: "Check the documentation: do the README, docs and comments still say what the code now does, and is anything new that people use left undocumented.",
  },
];

/** The profiles the ai and human tiers launch for each head (each is a container: two per head). */
export const AUTO_PROFILES: readonly string[] = ["correctness", "security"];

export function profileOf(name: string): Profile | null {
  return PROFILES.find((p) => p.name === name) ?? null;
}

/** What a reviewer session is told after reviewPrompt(): its focus, and to post one review. */
export function profileBrief(p: Profile): string {
  return [`You are the ${p.label} reviewer. ${p.instructions}`, `Start your review's summary with "${p.label}:". Ask for changes only for a real problem in this branch's changes.`].join("\n");
}
