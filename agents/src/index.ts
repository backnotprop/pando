// The pando-agents Worker. It has no public address: Pando's Worker reaches
// it over a service binding to the AgentsApi entrypoint, after checking who
// is asking. The Gateway entrypoint is what a session's container reaches
// as http://pando.internal.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import type { SessionSpec, SessionState } from "./session";
import type { TranscriptMessage } from "./transcript";

export { AgentSession } from "./session";

export { Gateway } from "./gateway";

/** A session object's name: one per session, under its repository. */
export function sessionName(monorepoId: string, sessionId: string): string {
  return `${monorepoId}:${sessionId}`;
}

/** What Pando's Worker calls. Every check of who may do what is Pando's. */
export class AgentsApi extends WorkerEntrypoint<Env> {
  #session(monorepoId: string, sessionId: string) {
    return this.env.SESSIONS.getByName(sessionName(monorepoId, sessionId));
  }

  start(spec: SessionSpec, prompt: string): Promise<SessionState> {
    return this.#session(spec.monorepo.id, spec.id).start(spec, prompt);
  }

  send(monorepoId: string, sessionId: string, prompt: string, operationId?: string): Promise<SessionState> {
    return this.#session(monorepoId, sessionId).send(prompt, operationId);
  }

  stop(monorepoId: string, sessionId: string, reason?: string): Promise<SessionState> {
    return this.#session(monorepoId, sessionId).stop(reason);
  }

  state(monorepoId: string, sessionId: string): Promise<SessionState> {
    return this.#session(monorepoId, sessionId).state();
  }

  transcript(monorepoId: string, sessionId: string): Promise<TranscriptMessage[]> {
    return this.#session(monorepoId, sessionId).transcript();
  }

  settled(monorepoId: string, sessionId: string): Promise<SessionState> {
    return this.#session(monorepoId, sessionId).settled();
  }
}

export default {
  fetch(): Response {
    return new Response("not found\n", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
