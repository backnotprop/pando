// The session's Linux sandbox: the container attached to its Durable Object.
//
// It starts on the first command the agent runs, from the session's newest
// snapshot when there is one (the files, unpushed edits included), else from
// the image. Either way its workspace is the session's branch, mounted
// through pando and ArtifactFS where FUSE works, else a clone
// (container/workspace.sh). The container reaches only http://pando.internal,
// which the Gateway answers outside it; it has no internet.

export const INTERNAL_HOST = "pando.internal";

/** Where the session's repository is mounted in the container. */
export const ROOT = "/workspace/repo";

/** The container stops this long after its last command (Cloudflare's maximum is 6 hours). */
const IDLE_MS = 10 * 60 * 1000;

export interface WorkspaceSpec {
  /** owner/name */
  monorepo: string;
  /** The project folder, "." for a plain repository. */
  repoPath: string;
  branch: string;
  /** The machine name the session's credential carries, such as cloud-3. */
  machine: string;
  /** Commits are authored as the person who launched the session. */
  author: { name: string; email: string };
}

export interface Workspace {
  /** The branch worktree, the agent's working folder. */
  dir: string;
  /** mount: pando and ArtifactFS over FUSE; clone: pando's sparse clone. */
  kind: "mount" | "clone";
  /** How this start found the files. */
  from: "snapshot" | "nothing" | "running";
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SavedSnapshot {
  snapshot: ContainerSnapshot;
  /** A snapshot restores only into the image it was taken from. */
  image: string;
  at: string;
}

export function worktreeDir(repoPath: string, branch: string): string {
  const folder = branch.replaceAll("/", "-");

  return repoPath === "." ? `${ROOT}/worktrees/${folder}` : `${ROOT}/${repoPath}/worktrees/${folder}`;
}

export class Sandbox {
  #ready: Promise<Workspace> | undefined;
  /** Whether #ready has resolved: until then every caller waits on the one start in flight. */
  #readyDone = false;

  constructor(
    private readonly ctx: DurableObjectState,
    /** The gateway for this session, built with its credential. */
    private readonly gateway: () => Fetcher,
    private readonly spec: () => WorkspaceSpec,
  ) {}

  private get container(): Container {
    const c = this.ctx.container;

    if (!c) throw new Error("this Durable Object has no container");

    return c;
  }

  get running(): boolean {
    return this.ctx.container?.running ?? false;
  }

  /** Starts the container if needed and prepares the workspace, once per start. */
  workspace(): Promise<Workspace> {
    // One start at a time: a caller during a start waits for it, and a
    // finished start holds while the container runs.
    if (this.#ready && (!this.#readyDone || this.running)) return this.#ready;
    this.#readyDone = false;
    const ready = this.#start();
    this.#ready = ready;
    ready.then(
      () => {
        if (this.#ready === ready) this.#readyDone = true;
      },
      () => {
        // A start that failed is tried again by the next call.
        if (this.#ready === ready) this.#ready = undefined;
      },
    );

    return ready;
  }

  async #start(): Promise<Workspace> {
    const c = this.container;

    if (c.running) return this.#prepare("running");
    const saved = this.restorable();

    if (saved) {
      try {
        this.#boot(saved.snapshot);

        return await this.#prepare("snapshot");
      } catch (error) {
        // Past its 30 days, or its files did not come back: start from the branch instead.
        console.warn("snapshot restore", String(error));
        this.ctx.storage.kv.delete("sandbox.snapshot");
        await this.destroy();
      }
    }

    this.#boot(null);

    return this.#prepare("nothing");
  }

  #boot(snapshot: ContainerSnapshot | null): void {
    const image = this.container.images.workspace;
    const from = snapshot ? { containerSnapshot: snapshot } : { image };

    this.container.start({ ...from, entrypoint: ["sleep", "infinity"], enableInternet: false, instance: "standard-1" });
  }

  async #prepare(from: Workspace["from"]): Promise<Workspace> {
    const c = this.container;

    await c.setInactivityTimeout(IDLE_MS);
    await c.interceptOutboundHttp(INTERNAL_HOST, this.gateway());
    const s = this.spec();
    const out = await this.exec(["pando-agent-workspace", s.monorepo, s.repoPath, s.branch], { timeoutSeconds: 300 });
    const line = /^workspace (\S+) (mount|clone)$/m.exec(out.stdout);

    if (out.exitCode !== 0 || !line) {
      throw new Error(`the workspace did not start (exit ${out.exitCode}): ${(out.stderr || out.stdout).slice(-1500)}`);
    }

    const kind = line[2] === "mount" ? "mount" : "clone";

    // A fallback is never silent: why the mount did not hold goes to the Worker's logs.
    if (kind === "clone") console.warn(`workspace fell back to a clone: ${out.stderr.slice(-2000)}`);

    return { dir: line[1], kind, from };
  }

  /** The newest snapshot, when the current image can restore it. */
  restorable(): SavedSnapshot | undefined {
    const saved = this.ctx.storage.kv.get<SavedSnapshot>("sandbox.snapshot");

    return saved && saved.image === this.container.images.workspace ? saved : undefined;
  }


  /** The environment every command in the container gets. */
  env() {
    const s = this.spec();

    return {
      HOME: "/root",
      GIT_TERMINAL_PROMPT: "0",
      // pando reaches Pando only through the gateway, which replaces this
      // placeholder with the session's credential. The sandbox holds none.
      PANDO_SERVER: `http://${INTERNAL_HOST}`,
      PANDO_TOKEN: "sandbox",
      PANDO_MACHINE: s.machine,
      GIT_AUTHOR_NAME: s.author.name,
      GIT_AUTHOR_EMAIL: s.author.email,
      GIT_COMMITTER_NAME: s.author.name,
      GIT_COMMITTER_EMAIL: s.author.email,
    };
  }

  /** Runs argv in the container and collects its output. */
  async exec(argv: string[], options: { cwd?: string; timeoutSeconds?: number; signal?: AbortSignal } = {}): Promise<ExecResult> {
    const timed = options.timeoutSeconds ? ["timeout", "--kill-after=5", String(options.timeoutSeconds), ...argv] : argv;
    const proc = await this.container.exec(timed, { env: this.env(), cwd: options.cwd, signal: options.signal });
    const out = await proc.output();
    const text = new TextDecoder();

    return { exitCode: out.exitCode, stdout: text.decode(out.stdout), stderr: text.decode(out.stderr) };
  }

  /** Starts argv with the session's environment, for callers that stream. */
  spawn(argv: string[], options: ContainerExecOptions): Promise<ExecProcess> {
    return this.container.exec(argv, { ...options, env: { ...this.env(), ...options.env } });
  }

  /** Saves the container's files for the next start; the container keeps running. */
  async snapshot(): Promise<ContainerSnapshot | undefined> {
    if (!this.running) return undefined;
    const image = this.container.images.workspace;
    const snapshot = await this.container.snapshotContainer({ name: "workspace" });
    this.ctx.storage.kv.put<SavedSnapshot>("sandbox.snapshot", { snapshot, image, at: new Date().toISOString() });

    return snapshot;
  }

  /** Stops the container now. Files not in a snapshot or pushed are gone. */
  async destroy(): Promise<void> {
    this.#ready = undefined;

    if (this.running) await this.container.destroy();
  }
}
