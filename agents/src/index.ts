// The pando-agents Worker. It has no public address: Pando's Worker reaches
// it over a service binding to the AgentsApi entrypoint, after checking who
// is asking. The Gateway entrypoint is what a session's container reaches
// as http://pando.internal.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import type { AgentsRpc, SessionSpec, SessionState, TranscriptMessage } from "./protocol";

export { AgentSession } from "./session";

export { Gateway } from "./gateway";

/** A session object's name: one per session, under its repository. */
export function sessionName(monorepoId: string, number: number): string {
  return `${monorepoId}:${number}`;
}

/** What Pando's Worker calls. Every check of who may do what is Pando's. */
export class AgentsApi extends WorkerEntrypoint<Env> implements AgentsRpc {
  #session(monorepoId: string, number: number) {
    return this.env.SESSIONS.getByName(sessionName(monorepoId, number));
  }

  start(spec: SessionSpec, prompt: string): Promise<SessionState> {
    return this.#session(spec.monorepo.id, spec.number).start(spec, prompt);
  }

  send(monorepoId: string, number: number, prompt: string): Promise<SessionState> {
    return this.#session(monorepoId, number).send(prompt);
  }

  stop(monorepoId: string, number: number, reason: string): Promise<SessionState> {
    return this.#session(monorepoId, number).stop(reason);
  }

  state(monorepoId: string, number: number): Promise<SessionState> {
    return this.#session(monorepoId, number).state();
  }

  transcript(monorepoId: string, number: number): Promise<TranscriptMessage[]> {
    return this.#session(monorepoId, number).transcript();
  }

  /** Waits until the session's runs settle. The tests' driver uses it. */
  settled(monorepoId: string, number: number): Promise<SessionState> {
    return this.#session(monorepoId, number).settled();
  }
}

export default {
  fetch(): Response {
    return new Response("not found\n", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
