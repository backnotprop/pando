// What pando-agents calls (its REPORTS binding): each change of a session's
// state, kept in the monorepo object and sent out as an agent.updated event.
// RPC only, reachable only over a service binding.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../env";
import { monorepoStub } from "../monorepo/session";
import type { ReportsRpc, SessionState } from "../../../agents/src/protocol";

export class AgentReports extends WorkerEntrypoint<Env> implements ReportsRpc {
  async report(monorepoId: string, state: SessionState): Promise<void> {
    await monorepoStub(this.env, monorepoId).agentReport(state);
  }
}
