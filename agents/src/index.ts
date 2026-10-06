// The pando-agents Worker. It has no public address: Pando's Worker reaches
// it over a service binding to the AgentsApi entrypoint, after checking who
// is asking. The Gateway entrypoint is what a session's container reaches
// as http://pando.internal.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { listModels } from "./models";
import type { AgentsRpc, ModelInfo, SessionSpec, SessionState, TranscriptMessage } from "./protocol";

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

  /**
   * The live view's socket: /live/<monorepo id>/<n>, with Upgrade: websocket.
   * Pando's Worker forwards it here after checking that the caller is a member.
   */
  async fetch(request: Request): Promise<Response> {
    const m = /^\/live\/([^/]+)\/([1-9][0-9]{0,8})$/.exec(new URL(request.url).pathname);

    if (!m || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("not found\n", { status: 404 });

    return this.#session(decodeURIComponent(m[1]), Number(m[2])).fetch(request);
  }

  models(): ModelInfo[] {
    return listModels(this.env);
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
