// The e2e run's ports, each from the environment when set: the Worker
// (PANDO_E2E_WORKER_PORT, or PANDO_E2E_PORT; default 8871), the stand-in
// WorkOS (PANDO_E2E_STANDIN_PORT; default the next port) and the inspector
// (PANDO_E2E_INSPECTOR_PORT; default 500 above), and GitHub's stand-in for the
// mirror spec (PANDO_E2E_GITHUB_PORT; none by default). Each worktree takes its own
// (other lanes use 8797, 8799 and 8811 to 8814). worker/.dev.vars must point
// WORKOS_API_BASE at the stand-in.
export const WORKER_PORT = Number(process.env.PANDO_E2E_WORKER_PORT ?? process.env.PANDO_E2E_PORT ?? 8871);

export const STANDIN_PORT = Number(process.env.PANDO_E2E_STANDIN_PORT ?? WORKER_PORT + 1);

export const INSPECTOR_PORT = Number(process.env.PANDO_E2E_INSPECTOR_PORT ?? WORKER_PORT + 500);

/** GitHub's stand-in for the mirror spec (PANDO_E2E_GITHUB_PORT); null when the run has none. */
export const GITHUB_PORT = process.env.PANDO_E2E_GITHUB_PORT ? Number(process.env.PANDO_E2E_GITHUB_PORT) : null;
