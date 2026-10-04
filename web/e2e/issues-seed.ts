// Issues for the fidelity shots, shaped like the issues mocks
// (research/design/pando-ui-2026-10-03/issues/mocks.html): ramos/pando's
// labels, open and closed issues, one closed by merging fix-login (comments,
// a label and an assignment, the commit link, the close), and one open with
// toml-error-line ready to merge. ramos acts from ramos-mbp and sandbox-1,
// ana from ana-mbp, each as their own credential.
import { ciStatus, type JsonBody, type Machine } from "./seed";

const FULL = "ramos/pando";

const BASE = `/v1/monorepos/${FULL}`;

/** The people's credentials, and the project's clone URL. */
export interface IssueCast {
  ramos: Machine;
  sandbox: Machine;
  ana: Machine;
  pandoUrl: string;
}

async function call(m: Machine, method: string, path: string, body?: JsonBody) {
  const res = await m.api(method, `${BASE}${path}`, body);

  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);

  return res.status === 204 ? null : res.json();
}

const open = async (m: Machine, issue: JsonBody): Promise<number> => (await call(m, "POST", "/issues", issue)).number;

const comment = (m: Machine, n: number, body: string) => call(m, "POST", `/issues/${n}/comments`, { body });

const patch = (m: Machine, n: number, body: JsonBody) => call(m, "PATCH", `/issues/${n}`, body);

/** One commit on a branch, pushed; its sha. */
function push(m: Machine, url: string, branch: string, files: Record<string, string>, message: string): string {
  const dir = m.commit("pando", url, branch, files, message);

  m.push(dir, url, branch);

  return m.git(dir, "rev-parse", "HEAD").trim();
}

/** Until `n` is closed (a merge's close lands about a second after it). */
async function closed(m: Machine, n: number) {
  for (let i = 0; i < 60; i++) {
    if ((await call(m, "GET", `/issues/${n}`)).state === "closed") return;
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(`#${n} did not close`);
}

const LOGIN_BODY = `After the browser session renews, the next API call answers 401 and the page shows the sign-in button. It happens about one time in five after 15 minutes idle.

### Steps

1. Sign in and leave the tab for 15 minutes.
2. Open a branch page.

The renewed \`__Host-pando_session\` cookie never reaches the browser.

- [x] Reproduce on pando-dev
- [x] Find where the cookie is renewed
- [ ] Add an end-to-end test for the renewal
`;

const TOML_BODY = `A merge of \`web-api\` answered \`checks_unknown\` with "Pando couldn't read this monorepo's required checks". The cause was a trailing comma in \`.pando/pando.toml\`:

\`required_checks = ["ci", "typecheck",]\`

TOML refuses it, which is right, but the message should name the line so the fix is obvious.
`;

/** Makes the issues; answers the numbers the shots open: the one closed by merge, and the open one with a branch ready to merge. */
export async function seedIssues({ ramos, sandbox, ana, pandoUrl }: IssueCast): Promise<{ closedByMerge: number; open: number }> {
  for (const label of [
    { name: "auth", color: "yellow", description: "Sign-in, sessions and credentials" },
    { name: "performance", color: "green", description: "Speed, load and cost" },
    { name: "mac", color: "gray", description: "Pando.app and the FSKit mount" },
    { name: "needs-repro", color: "pink", description: "Not reproduced yet" },
  ]) {
    await call(ramos, "POST", "/labels", label);
  }

  // Older issues, closed: by a person, and as not planned.
  const raw = await open(ramos, { title: "Raw link opens without signing in", labels: ["bug", "auth"], project: "projects-pando", assignees: ["ramos"] });

  await patch(ramos, raw, { state: "closed", state_reason: "completed" });
  const lost = await open(ramos, { title: "Root file save lost when two machines delete it", labels: ["bug", "needs-repro"] });

  await comment(ana, lost, "I can't make it happen again on two machines.");
  await patch(ana, lost, { state: "closed", state_reason: "not_planned" });

  await open(ramos, { title: "Cloning a 20-project monorepo takes over a minute", labels: ["performance"], project: "projects-pando", assignees: ["ramos"] });
  await open(ana, { title: "CI tab: show required checks beside each pipeline", labels: ["enhancement"], project: "projects-pando" });
  await open(ramos, { title: "Plan the 1,000-agent load test", body: "- [x] Pick the agents\n- [x] Write the driver\n- [x] Book the account\n- [ ] Run it\n- [ ] Read the numbers\n- [ ] Write it up\n- [ ] Tell the owner\n", labels: ["question"], assignees: ["ramos", "ana"] });
  await open(ana, { title: "Home misses a push line after the socket reconnects", labels: ["bug", "needs-repro"], project: "projects-pando" });
  await open(ramos, { title: "Explain pando sync in Get started", labels: ["documentation"] });
  await open(ana, { title: "FSKit mount shows old bytes for 30 s after main moves", labels: ["bug", "mac"], project: "projects-artifact-fs", assignees: ["ramos"] });

  // The issue a merge closed (the mock's #34).
  const login = await open(ana, { title: "Login fails after token refresh", body: LOGIN_BODY, labels: ["bug"], project: "projects-pando" });

  await patch(ana, login, { add_assignees: ["ramos"] });
  await comment(sandbox, login, "The renewal writes the new cookie after the answer is sent, so the browser keeps the old one. Setting it before the body fixes it in my test: 20 of 20 renewals kept the session.");
  const fix = push(sandbox, pandoUrl, "fix-login", { "worker/src/session.ts": "export const early = true;\n" }, `Set the session cookie before the body (fixes #${login})`);

  await patch(ramos, login, { add_labels: ["auth"] });
  await comment(ana, login, "Checked on pando-dev with the branch. Renewal keeps the session; the 401 is gone.");
  await ciStatus(ramos, FULL, "projects-pando", fix, "ci", "success");
  await call(ramos, "POST", "/repos/projects-pando/branches/fix-login/merge");
  await closed(ramos, login);
  await comment(ramos, login, "Merged. The renewal test is in `browser.mjs`, so the last task is done too.");

  await open(ramos, { title: "Show who saved each version on a file's history page", body: "- [x] Name\n- [x] Machine\n- [ ] Time\n- [ ] Link\n- [ ] Copy\n", labels: ["enhancement"], project: "projects-pando", assignees: ["ana"] });

  // The open issue with its branch ready to merge (the mock's #41).
  const toml = await open(ana, { title: "Merge refuses when pando.toml has a trailing comma", body: TOML_BODY, labels: ["bug"], project: "projects-pando" });

  await patch(ana, toml, { add_assignees: ["ramos"] });
  await comment(sandbox, toml, "The parser stops at the comma and the merge only says checks unknown. I will put the line and column in the reason: `pando.toml line 3: expected a value after the comma`.");
  push(sandbox, pandoUrl, "toml-error-line", { "worker/src/toml.test.ts": "export {};\n" }, "Test the reason for a trailing comma in required_checks");
  const named = push(sandbox, pandoUrl, "toml-error-line", { "worker/src/toml.ts": "export const line = 3;\n" }, `Name the line in the pando.toml error (fixes #${toml})`);

  await call(ramos, "PATCH", "/repos/projects-pando/branches/toml-error-line", { title: "Name the line in the pando.toml error" });
  await ciStatus(ramos, FULL, "projects-pando", named, "ci", "success");
  await comment(ana, toml, "Works on pando-dev: the merge box now says line 3. Good to merge.");
  await open(ana, { title: "Activity tab: filter by person", labels: ["enhancement"], project: "projects-pando" });

  return { closedByMerge: login, open: toml };
}
