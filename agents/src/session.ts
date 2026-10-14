// One agent session: one Durable Object. Pi Durable runs the loop through the
// Agents SDK's PiHarness, so the transcript lives in this object's SQLite and
// a crash or eviction resumes where it stopped. The model is a per-session
// setting (models.ts). The container attached to this object is the agent's
// sandbox (sandbox.ts), started on its first command.
//
// Pando's Worker owns the session's record, its credential and who may see
// it; this object holds what the run needs: the spec, the credential's
// secret (never inside the container), the transcript and the status.

import { DurableObject } from "cloudflare:workers";
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineTool, Harness, type ToolRegistration } from "@earendil-works/pi-durable";
import { PiHarness, type PiOperationResult } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { ContainerEnv } from "./container-env";
import type { Env } from "./env";
import type { GatewayProps } from "./gateway";
import { preamble, toolsFor, type PublicSpec } from "./kinds";
import { LiveSockets } from "./live";
import { DEFAULT_MODEL, knownModel, openModels } from "./models";
import { PandoApi, pandoTools } from "./pando-tools";
import { Sandbox, workDir } from "./sandbox";
import { understandTools } from "./understand-tools";
import type { SessionSpec, SessionState, Status, TranscriptMessage } from "./protocol";
import { projectEntries } from "./transcript";

interface StoredStatus {
  status: Status;
  reason?: string;
  at: string;
}

/** A branch name a person may give: git's characters, not main, no "..", no leading or trailing slash. */
const BRANCH_NAME = /^(?!main$)(?!.*\.\.)(?!.*\/\/)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;

export class AgentSession extends DurableObject<Env> {
  readonly registry = createRegistry();
  readonly #models = openModels(this.env);
  readonly sandbox = new Sandbox(
    this.ctx,
    () => this.#gateway(),
    () => {
      const s = this.#spec();

      return { monorepo: s.monorepo.full, repoPath: s.repo?.path ?? ".", branch: s.branch, machine: s.credential.name, author: { name: s.launcher.name, email: s.launcher.email } };
    },
  );
  readonly harness = new PiHarness({
    harness: ({ storage, context }) =>
      Harness.open(
        storage,
        {
          models: this.#models.models,
          registry: this.registry,
          // A model that is rate-limited gets about 30 s to recover: 1, 2, 4, 8, 16 s.
          settings: { retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 } },
          // The sandbox starts on the first operation that needs it (container-env.ts).
          env: () => {
            const spec = this.#spec();

            return new ContainerEnv(this.sandbox, `container:${this.ctx.id.toString()}`, workDir(spec));
          },
          onReport: (error) => console.warn("pi report", error),
        },
        context,
      ),
    defaults: { model: this.#models.model(DEFAULT_MODEL) },
  });
  /** The live view's sockets (live.ts). */
  readonly live = new LiveSockets(this.harness, () => this.ctx.getWebSockets());
  readonly lifecycle = Lifecycle.install(this).use(this.live.capability()).use(this.harness);

  /** Host startup, after Pi is open: follow runs that an eviction cut off, and give live sockets a full frame. */
  async onStart(): Promise<void> {
    const spec = this.ctx.storage.kv.get<SessionSpec>("spec");

    if (!spec) return;
    this.#install(spec);

    for (const op of await this.harness.pending()) this.#follow(op.operationId);
    await this.live.reattach();
  }

  // ── RPC, from the AgentsApi entrypoint ──

  /** Starts the session with its first prompt. Starting it again changes nothing. */
  async start(spec: SessionSpec, prompt: string): Promise<SessionState> {
    await this.lifecycle.start();

    if (!this.ctx.storage.kv.get("spec")) {
      if (!knownModel(this.env, spec.model)) throw new Error(`unknown model ${spec.model}`);
      this.ctx.storage.kv.put("spec", spec);
      this.#install(spec);
      await this.harness.session().setModel(this.#models.model(spec.model));
      await this.#submit(prompt, "start");
    }

    return this.state();
  }

  /** A person's follow-up. It waits for the current run when one is going. */
  async send(prompt: string): Promise<SessionState> {
    await this.lifecycle.start();
    this.#spec();
    const note = this.#restoreNote();

    await this.#submit(note ? `${note}\n\n${prompt}` : prompt);

    return this.state();
  }

  /** Stop: abort the run and stop the sandbox. The transcript stays. */
  async stop(reason: string): Promise<SessionState> {
    await this.lifecycle.start();
    this.#setStatus("stopped", reason);
    await this.harness.abort();
    await this.#flushSync();
    // Its files are kept for a later message: unpushed work included.
    await this.#saveSandbox();
    await this.sandbox.destroy();

    return this.state();
  }

  async state(): Promise<SessionState> {
    const spec = this.#spec();
    const st = this.ctx.storage.kv.get<StoredStatus>("status") ?? { status: "working", at: new Date().toISOString() };

    const state: SessionState = {
      number: spec.number,
      status: st.status,
      model: spec.model,
      branch: spec.branch,
      repo: spec.repo?.name ?? "",
      sandbox: this.sandbox.running ? "running" : "stopped",
      updated_at: st.at,
    };

    const workspace = this.ctx.storage.kv.get<"mount" | "clone">("workspace");

    if (st.reason) state.reason = st.reason;

    if (workspace) state.workspace = workspace;

    return state;
  }

  async transcript(): Promise<TranscriptMessage[]> {
    await this.lifecycle.start();

    return projectEntries(await this.harness.messages());
  }

  /** Waits until the current runs settle (tests and callers that must). */
  async settled(): Promise<SessionState> {
    await this.lifecycle.start();

    for (const op of await this.harness.pending()) await this.harness.wait(op.operationId);
    await Promise.all(this.#following.values());

    return this.state();
  }

  // ── Inside ──

  #spec(): SessionSpec {
    const spec = this.ctx.storage.kv.get<SessionSpec>("spec");

    if (!spec) throw new Error("this session has not started");

    return spec;
  }

  #installed = false;

  /** The system prompt and the tools; once per isolate, and again when a chat starts its branch. */
  #install(spec: SessionSpec): void {
    if (this.#installed) return;
    this.#installed = true;
    this.#installTools(spec);
  }

  #installTools(spec: SessionSpec): void {
    const pub: PublicSpec = { ...spec, credential: { id: spec.credential.id, name: spec.credential.name } };
    const api = new PandoApi(this.env.PANDO, () => this.#spec());
    // A chat works like a task once the person has named its branch.
    const working = spec.branch !== "";
    const tools = toolsFor(spec.kind, pandoTools(api, () => this.#spec()), working, this.#startBranch(), spec.kind === "understand" && spec.page ? understandTools(api, spec.page) : []);

    // Installing under the same name replaces the extension; Pi reads the registry at each model call.
    this.registry.install({ name: "pando", sections: [{ key: "preamble", render: () => preamble(pub, working), tag: false }], tools });
  }

  /**
   * The chat's start_branch(name) (owner, 2026-10-05: a person names the
   * branch): it takes only a name the person wrote in their latest message,
   * so the model can suggest one but never choose it. From its next step the
   * chat has a task's tools on that branch (an existing one is used as it is).
   */
  #startBranch(): ToolRegistration {
    return defineTool({
      name: "start_branch",
      description:
        "Start making a change the person asked for, on a branch they named: gives you a Linux sandbox on it with bash, read, write and edit, and merge. The name must be one the person wrote in their latest message; if they have not named one, ask them (you may suggest a short name for the change) and wait.",
      parameters: Type.Object({
        name: Type.String({ description: "The branch name, exactly as the person wrote it" }),
        repo: Type.Optional(Type.String({ description: "The project the change belongs in, by name; the chat's own when left out" })),
      }),
      execute: async ({ name, repo }) => {
        const said = await this.#lastPersonText();

        if (!BRANCH_NAME.test(name)) throw new Error(`"${name}" is not a branch name: letters, digits and . _ / -, not main`);

        if (!said.split(/[\s`'",.;:!?()]+/).includes(name)) throw new Error(`The person has not named "${name}" in their latest message. Ask them for the branch's name, and wait for their answer.`);
        const current = this.#spec();
        const projects = current.projects ?? [];
        const project = repo === undefined ? current.repo : (projects.find((p) => p.name === repo) ?? null);

        if (!project) throw new Error(`${repo === undefined ? "Give repo, the project the change belongs in" : `There is no project ${repo}`}: ${projects.map((p) => p.name).join(", ")}.`);
        const spec = { ...current, repo: project, branch: name };

        this.ctx.storage.kv.put("spec", spec);
        this.#installTools(spec);
        // Pando's record learns the branch and its project before the agent can merge it.
        await this.#report();

        return { content: [{ type: "text", text: `Your branch is ${name}${repo === undefined ? "" : ` of ${project.name}`}. Commit and push there, then merge it.` }] };
      },
    });
  }

  /** The text of the person's latest message in this conversation. */
  async #lastPersonText(): Promise<string> {
    const last = projectEntries(await this.harness.messages()).findLast((m) => m.role === "user");

    return last?.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n") ?? "";
  }

  #gateway(): Fetcher {
    const spec = this.#spec();
    const props: GatewayProps = { monorepo: spec.monorepo.full, authorization: `Basic ${btoa(`${spec.launcher.login}:${spec.credential.secret}`)}` };

    return this.ctx.exports.Gateway({ props });
  }

  async #submit(prompt: string, operationId?: string): Promise<void> {
    this.#setStatus("working");
    const receipt = await this.harness.submit(prompt, operationId ? { operationId } : {});
    this.#follow(receipt.operationId);
  }

  /** Runs being followed in this isolate, by operation id. */
  readonly #following = new Map<string, Promise<void>>();

  /** Keeps the object alive until the run settles, then records how it ended. */
  #follow(operationId: string): void {
    if (this.#following.has(operationId)) return;

    const settled = this.harness
      .wait(operationId)
      .then((result) => this.#settled(result))
      .catch((error: Error) => console.warn("session wait", error.message))
      .finally(() => this.#following.delete(operationId));

    this.#following.set(operationId, settled);
    this.ctx.waitUntil(settled);
  }

  async #settled(result: PiOperationResult): Promise<void> {
    if (this.ctx.storage.kv.get<StoredStatus>("status")?.status === "stopped") return;

    if ((await this.harness.pending()).length > 0) return;

    if (this.sandbox.running) {
      const ws = await this.sandbox.workspace().catch(() => undefined);

      if (ws) this.ctx.storage.kv.put("workspace", ws.kind);
      await this.#flushSync();
      await this.#saveSandbox();
    }

    // A stop that came while the run's files were being saved wins: the session stays stopped, never back to waiting.
    if (this.ctx.storage.kv.get<StoredStatus>("status")?.status === "stopped") return;

    if (result.status === "done") this.#setStatus("waiting");
    else this.#setStatus("failed", result.reason ?? "the run ended without an answer");
  }

  /** The run's last saves to the shared files reach Pando; a conflict copy goes to the Worker's log. */
  async #flushSync(): Promise<void> {
    try {
      for (const line of await this.sandbox.flushSync()) console.warn(`session ${this.#spec().number}: ${line}`);
    } catch (error) {
      console.warn("shared files", String(error));
    }
  }

  /** A snapshot of the sandbox's files, for the next start; the sandbox keeps running. */
  async #saveSandbox(): Promise<void> {
    if (!this.sandbox.running) return;

    try {
      await this.sandbox.snapshot();
    } catch (error) {
      console.warn("snapshot", String(error));
    }
  }

  /**
   * One line for the agent when its sandbox stopped since its last run: how
   * its workspace comes back on its next command. Exact: a snapshot the
   * image can restore, or else the branch as pushed.
   */
  #restoreNote(): string | null {
    if (this.sandbox.running || !this.ctx.storage.kv.get("workspace")) return null;
    const spec = this.#spec();
    const saved = this.sandbox.restorable();

    return saved
      ? `[Pando] Your sandbox stopped since your last message. On your next command it comes back from a snapshot of its files taken at ${saved.at}: the files as they were, unpushed changes included. No processes are running.`
      : `[Pando] Your sandbox stopped since your last message. On your next command it is made again from branch ${spec.branch} as pushed: changes that were not pushed are gone, and no processes are running.`;
  }

  /** Tells Pando's Worker the session's state; it keeps the newest. */
  async #report(): Promise<void> {
    const spec = this.ctx.storage.kv.get<SessionSpec>("spec");

    if (!spec || !this.env.REPORTS) return;

    try {
      await this.env.REPORTS.report(spec.monorepo.id, await this.state());
    } catch (error) {
      console.warn("session report", String(error));
    }
  }

  #setStatus(status: Status, reason?: string): void {
    const stored: StoredStatus = { status, at: new Date().toISOString() };

    if (reason) stored.reason = reason;
    this.ctx.storage.kv.put("status", stored);
    this.ctx.waitUntil(this.#report());
  }
}
