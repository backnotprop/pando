// The pando-agents Worker's bindings (wrangler.jsonc).

import type { AgentSession } from "./session";

declare global {
  namespace Cloudflare {
    // Types ctx.exports from this Worker's own exports (the Gateway entrypoint).
    interface GlobalProps {
      mainModule: typeof import("./index");
      durableNamespaces: "AgentSession";
    }
  }
}

export interface Env {
  /** One object per agent session, named <monorepo id>:<session id>. */
  SESSIONS: DurableObjectNamespace<AgentSession>;
  /** Workers AI: the sessions' models. */
  AI: Ai;
  /** Pando's Worker: the git door and the API, for the sandbox's gateway. */
  PANDO: Fetcher;
  /** "1" only under wrangler dev for the end-to-end tests (models.ts). */
  SCRIPTED_MODEL?: string;
}
