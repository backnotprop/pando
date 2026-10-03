// The e2e run's ports: PANDO_E2E_PORT for the Worker (default 8871), the next
// one for the stand-in WorkOS, and 500 above for the inspector. Each worktree
// takes its own (other lanes use 8797, 8799 and 8811 to 8814). worker/.dev.vars
// must point WORKOS_API_BASE at the stand-in, http://127.0.0.1:<port + 1>.
export const WORKER_PORT = Number(process.env.PANDO_E2E_PORT ?? 8871);

export const STANDIN_PORT = WORKER_PORT + 1;

export const INSPECTOR_PORT = WORKER_PORT + 500;
