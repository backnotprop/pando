// The tests' way in to pando-agents (wrangler.jsonc beside this file).

import type { AgentsApi } from "../../src/index";
import type { SessionSpec } from "../../src/protocol";

interface Env {
  AGENTS: Service<AgentsApi>;
  PANDO: Fetcher;
}

/** POST /_agents/<method> with this JSON. */
interface Call {
  spec: SessionSpec;
  prompt: string;
  monorepo: string;
  session: number;
}

function dispatch(api: Service<AgentsApi>, method: string, c: Call) {
  switch (method) {
    case "start":
      return api.start(c.spec, c.prompt);
    case "send":
      return api.send(c.monorepo, c.session, c.prompt);
    case "stop":
      return api.stop(c.monorepo, c.session, "stopped by a person");
    case "state":
      return api.state(c.monorepo, c.session);
    case "transcript":
      return api.transcript(c.monorepo, c.session);
    case "settled":
      return api.settled(c.monorepo, c.session);
    default:
      return undefined;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const m = /^\/_agents\/([a-z]+)$/.exec(new URL(request.url).pathname);

    if (!m) return env.PANDO.fetch(request);

    try {
      // SAFETY: the body is the test suite's own JSON, in the Call shape.
      const c = (await request.json()) as Call;
      const out = dispatch(env.AGENTS, m[1], c);

      return out ? Response.json(await out) : new Response("not found\n", { status: 404 });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};
