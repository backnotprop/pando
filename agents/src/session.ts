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
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { PiHarness, type PiOperationResult } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { ContainerEnv } from "./container-env";
import type { Env } from "./env";
import type { GatewayProps } from "./gateway";
import { DEFAULT_MODEL, knownModel, openModels } from "./models";
import { Sandbox, worktreeDir } from "./sandbox";
import type { SessionSpec, SessionState, Status, TranscriptMessage } from "./protocol";
import { projectEntries } from "./transcript";

interface StoredStatus {
  status: Status;
  reason?: string;
  at: string;
}

type PublicSpec = Omit<SessionSpec, "credential"> & { credential: Omit<SessionSpec["credential"], "secret"> };

function preamble(s: PublicSpec): string {
  const dir = worktreeDir(s.repo.path, s.branch);

  return [
    `You are a coding agent working in Pando, a git platform, on the repository ${s.monorepo.full}, for ${s.launcher.name} (${s.launcher.login}), who started you. You act as them.`,
    `Your working folder is ${dir}: branch ${s.branch} of ${s.repo.name}, a Linux sandbox. Use bash, read, write and edit there.`,
    `Commit with git as you go and push the branch after each working step (git push origin ${s.branch}). Main is protected: never push to it.`,
    "The sandbox has no internet. It reaches only this repository, through git and the pando command.",
  ].join("\n");
}

export class AgentSession extends DurableObject<Env> {
  readonly registry = createRegistry();
  readonly #models = openModels(this.env);
  readonly sandbox = new Sandbox(
    this.ctx,
    () => this.#gateway(),
    () => {
      const s = this.#spec();

      return { monorepo: s.monorepo.full, repoPath: s.repo.path, branch: s.branch, machine: s.credential.name, author: { name: s.launcher.name, email: s.launcher.email } };
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
          env: async () => {
            const ws = await this.sandbox.workspace();

            return new ContainerEnv(this.sandbox, `container:${this.ctx.id.toString()}`, ws.dir);
          },
          onReport: (error) => console.warn("pi report", error),
        },
        context,
      ),
    defaults: { model: this.#models.model(DEFAULT_MODEL) },
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  /** Host startup, after Pi is open: follow runs that an eviction cut off. */
  async onStart(): Promise<void> {
    const spec = this.ctx.storage.kv.get<SessionSpec>("spec");

    if (!spec) return;
    this.#install(spec);

    for (const op of await this.harness.pending()) this.#follow(op.operationId);
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
    await this.#submit(prompt);

    return this.state();
  }

  /** Stop: abort the run and stop the sandbox. The transcript stays. */
  async stop(reason: string): Promise<SessionState> {
    await this.lifecycle.start();
    this.#setStatus("stopped", reason);
    await this.harness.abort();
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
      repo: spec.repo.name,
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

  /** The system prompt and the tools; once per isolate. */
  #install(spec: SessionSpec): void {
    if (this.#installed) return;
    this.#installed = true;
    const pub: PublicSpec = { ...spec, credential: { id: spec.credential.id, name: spec.credential.name } };
    this.registry.install({ name: "pando", sections: [{ key: "preamble", render: () => preamble(pub), tag: false }], tools: [] });
    this.registry.install(CodingTools);
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
    }

    if (result.status === "done") this.#setStatus("waiting");
    else this.#setStatus("failed", result.reason ?? "the run ended without an answer");
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
