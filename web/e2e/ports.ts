// This worktree's ports for the e2e run (other lanes use 8797, 8799 and 8811 to 8814).
// worker/.dev.vars must point WORKOS_API_BASE at the stand-in: http://127.0.0.1:8872.
export const WORKER_PORT = 8871;

export const STANDIN_PORT = 8872;

export const INSPECTOR_PORT = 9371;
