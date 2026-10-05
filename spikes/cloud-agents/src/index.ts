// Cloud-agents spike. Throwaway; not product code.
//
// One Durable Object per agent session (SessionAgent). It runs Pi Durable
// through the Agents SDK's PiHarness, so the transcript lives in the object's
// SQLite. A scripted model (pi-ai's faux provider) stands in for a real one:
// no model key, no cost. The script reads the transcript it is given, so it
// can show what the model would remember after a restart.
//
// The object also owns a Linux container (ctx.container). The model's one
// tool, `sh`, runs a command there. The container reaches Pando only through
// http://pando.internal, which the object intercepts: GitGateway adds the
// session's Pando credential and forwards to the Pando Worker over a service
// binding. The credential never enters the container.

import { Agent } from "agents";
import { PiHarness } from "agents/harness/pi";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type ToolRegistration } from "@earendil-works/pi-durable";
import { WorkerEntrypoint } from "cloudflare:workers";

interface Env {
  SessionAgent: DurableObjectNamespace<SessionAgent>;
  PANDO?: Fetcher;
}

const INTERNAL_HOST = "pando.internal";

// The scripted model. A real model gets the same context.
const brain: FauxResponseFactory = (context) => {
  // Pi writes its system entry after the user's first input, so skip it.
  const messages = context.messages.filter((m) => m.role !== "system");
  const last = messages.at(-1);
  if (last?.role === "toolResult") {
    const text = last.content.map((part) => ("text" in part ? part.text : "")).join("");
    return fauxAssistantMessage(fauxText(`tool finished:\n${text.slice(-1500)}`));
  }
  const prompt = last?.role === "user" ? (typeof last.content === "string" ? last.content : last.content.map((p) => ("text" in p ? p.text : "")).join("")) : "";
  if (prompt.startsWith("run: ")) {
    return fauxAssistantMessage(fauxToolCall("sh", { command: prompt.slice(5) }), { stopReason: "toolUse" });
  }
  if (prompt === "recall") {
    const earlier = messages
      .filter((m) => m.role === "user")
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .slice(0, -1);
    return fauxAssistantMessage(fauxText(`I see ${earlier.length} earlier prompts in my context: ${JSON.stringify(earlier.map((p) => p.slice(0, 60)))}`));
  }
  return fauxAssistantMessage(fauxText(`ok: ${prompt}`));
};

export class SessionAgent extends Agent<Env> {
  faux = fauxProvider({ provider: "faux", models: [{ id: "scripted" }] });
  registry = createRegistry();
  harness = new PiHarness({
    harness: ({ storage, context }) => {
      this.registry.install({
        name: "pando",
        sections: [{ key: "preamble", render: () => "You are a Pando cloud agent. Work in the sandbox with sh.", tag: false }],
        tools: [this.shTool()],
      });
      const models = createModels();
      models.setProvider(this.faux.provider);
      // One queued step per model call; each step is the same pure function.
      this.faux.setResponses(Array.from({ length: 200 }, () => brain));
      return Harness.open(storage, { models, registry: this.registry }, context);
    },
    defaults: { model: this.faux.getModel() },
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.harness);
  }

  // ── RPC used by the spike's routes ──

  async ask(prompt: string) {
    const result = await this.harness.prompt(prompt);
    return { text: result.text, status: result.status, entries: result.messages.length };
  }

  async transcript() {
    const entries = await this.harness.messages();
    return entries.map((e) => {
      const r = e as unknown as { kind?: string; type?: string; id?: unknown };
      return { kind: r.kind ?? r.type, id: String(r.id) };
    });
  }

  async rawTranscript(): Promise<string> {
    return JSON.stringify(await this.harness.messages());
  }

  async setup(auth: string, monorepoPath: string) {
    // In the product this is the credential minted for the session at launch.
    this.ctx.storage.kv.put("auth", auth);
    this.ctx.storage.kv.put("monorepo", monorepoPath);
    return { ok: true };
  }

  async containerState() {
    return { running: this.ctx.container?.running ?? false };
  }

  async destroyContainer() {
    const c = this.ctx.container;
    if (c?.running) await c.destroy();
    return { running: c?.running ?? false };
  }

  // ── The sandbox ──

  private async sandbox(): Promise<Container> {
    const c = this.ctx.container;
    if (!c) throw new Error("no container binding");
    if (!c.running) {
      c.start({ image: c.images.git, entrypoint: ["sleep", "infinity"], enableInternet: false });
      await c.setInactivityTimeout(10 * 60 * 1000);
    }
    const auth = this.ctx.storage.kv.get<string>("auth");
    if (auth) {
      await c.interceptOutboundHttp(INTERNAL_HOST, (this.ctx.exports as unknown as { GitGateway: (o: { props: { auth: string; monorepo: string } }) => Fetcher }).GitGateway({ props: { auth, monorepo: this.ctx.storage.kv.get<string>("monorepo") ?? "" } }));
    }
    return c;
  }

  private shTool(): ToolRegistration {
    const Params = Type.Object({ command: Type.String() });
    const tool: ToolRegistration<typeof Params> = {
      name: "sh",
      description: "Run a shell command in this session's Linux sandbox.",
      parameters: Params,
      async execute({ command }) {
        return { content: [{ type: "text", text: "unbound" + command }] };
      },
    };
    tool.execute = async ({ command }) => {
      const c = await this.sandbox();
      const proc = await c.exec(["timeout", "--kill-after=5", "120", "bash", "-lc", command], {
        env: { GIT_TERMINAL_PROMPT: "0", HOME: "/root" },
      });
      const out = await proc.output();
      const dec = new TextDecoder();
      const text = `exit ${out.exitCode}\n${dec.decode(out.stdout).slice(-4000)}${dec.decode(out.stderr).slice(-4000)}`;
      return { content: [{ type: "text", text }] };
    };
    return tool as unknown as ToolRegistration;
  }
}

// Outbound HTTP from the sandbox to pando.internal lands here. It allows only
// git smart-HTTP for the session's own monorepo, adds the credential, and
// forwards to the Pando Worker. Everything else is refused.
export class GitGateway extends WorkerEntrypoint<Env, { auth: string; monorepo: string }> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { auth, monorepo } = this.ctx.props;
    const gitPath = /\/(info\/refs|git-upload-pack|git-receive-pack)$/.test(url.pathname);
    if (url.hostname !== INTERNAL_HOST || !gitPath || !url.pathname.startsWith(`/${monorepo}/`)) {
      return new Response("refused by the session gateway\n", { status: 403 });
    }
    if (!this.env.PANDO) return new Response("no PANDO binding\n", { status: 502 });
    const headers = new Headers(request.headers);
    headers.set("Authorization", auth);
    const target = new URL(url.pathname + url.search, "http://pando.local");
    return this.env.PANDO.fetch(new Request(target, { method: request.method, headers, body: request.body, duplex: "half" } as RequestInit));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const m = /^\/s\/([a-z0-9-]{1,63})\/(ask|transcript|raw|setup|container|destroy)$/.exec(url.pathname);
    // Everything else goes to the Pando Worker, so one port serves both.
    if (!m) return env.PANDO ? env.PANDO.fetch(request) : new Response("not found\n", { status: 404 });
    const [, name, action] = m;
    const agent = env.SessionAgent.getByName(name);
    switch (action) {
      case "ask":
        return Response.json(await agent.ask(await request.text()));
      case "transcript":
        return Response.json(await agent.transcript());
      case "raw":
        return new Response(await agent.rawTranscript(), { headers: { "content-type": "application/json" } });
      case "setup": {
        const body = (await request.json()) as { auth: string; monorepo: string };
        return Response.json(await agent.setup(body.auth, body.monorepo));
      }
      case "container":
        return Response.json(await agent.containerState());
      case "destroy":
        return Response.json(await agent.destroyContainer());
    }
    return new Response("not found\n", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
