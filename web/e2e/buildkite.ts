// A stand-in Buildkite for the e2e run and the fidelity shots, on this machine
// only (the Worker sends a connection's REST calls to its api_url only when it
// is localhost; worker/test/ci.mjs does the same). It answers the REST calls
// the CI pages make (logs, annotations, artifacts, the pipeline's YAML,
// Rebuild, Cancel, Retry, New build) and the hook's create-build, and it
// sends Buildkite's webhooks to the Worker with the connection's token.
// Objects are shaped as Buildkite's REST API and webhooks shape them.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { BASE, type JsonValue, type Machine } from "./seed";

export interface BuildOptions {
  state?: string;
  commit: string;
  branch: string;
  message: string;
  created_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface JobOptions {
  state: string;
  name?: string;
  exit_status?: number | null;
  created_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  retried?: boolean;
}

const pipeline = (org: string, slug: string) => ({
  id: `pl-${slug}`,
  url: `https://api.buildkite.com/v2/organizations/${org}/pipelines/${slug}`,
  web_url: `https://buildkite.com/${org}/${slug}`,
  name: slug,
  slug,
  repository: "https://example.invalid/repo.git",
  default_branch: "main",
  visibility: "private",
});

const build = (org: string, slug: string, n: number, o: BuildOptions) => ({
  id: `bld-${slug}-${n}`,
  graphql_id: "x",
  url: `https://api.buildkite.com/v2/organizations/${org}/pipelines/${slug}/builds/${n}`,
  web_url: `https://buildkite.com/${org}/${slug}/builds/${n}`,
  number: n,
  state: o.state ?? "scheduled",
  blocked: false,
  message: o.message,
  commit: o.commit,
  branch: o.branch,
  env: {},
  source: "webhook",
  creator: null,
  meta_data: {},
  created_at: o.created_at ?? new Date().toISOString(),
  scheduled_at: o.created_at ?? new Date().toISOString(),
  started_at: o.started_at ?? null,
  finished_at: o.finished_at ?? null,
});

const job = (org: string, id: string, key: string, o: JobOptions) => ({
  id,
  graphql_id: "x",
  type: "script",
  name: o.name ?? key,
  step_key: key,
  state: o.state,
  web_url: `https://buildkite.com/${org}/p/builds/1#${id}`,
  log_url: "x",
  raw_log_url: "x",
  command: "npm test",
  soft_failed: false,
  exit_status: o.exit_status ?? null,
  created_at: o.created_at ?? new Date().toISOString(),
  started_at: o.started_at ?? null,
  finished_at: o.finished_at ?? null,
  retried: o.retried ?? false,
});

/** What the stand-in answers, and what it was asked. */
export class Buildkite {
  readonly calls: string[] = [];
  /** Create-build requests from Pando: the hook on a push, Rebuild, New build. */
  readonly created: { commit: string; branch: string }[] = [];
  /** A job's log, by job id. */
  logs = new Map<string, string>();
  /** A build's annotations and artifacts, by build number. */
  annotations = new Map<number, { id: string; context: string; style: string; body_html: string }[]>();
  artifacts = new Map<number, { id: string; job_id: string; path: string; filename: string; file_size: number }[]>();
  /** A pipeline's YAML, by slug. */
  yaml = new Map<string, string>();
  private nextNumber = 100;
  private connection = "";
  private webhookToken = "";

  /** `org`: the Buildkite organization's slug the connection names. */
  private constructor(
    private readonly server: Server,
    readonly org: string,
  ) {}

  static async start(org = "o"): Promise<Buildkite> {
    const server = createServer();
    const bk = new Buildkite(server, org);

    server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (d: Buffer) => {
        raw += d.toString();
      });
      req.on("end", () => bk.answer(req, raw, res));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

    return bk;
  }

  get url(): string {
    // SAFETY: a server listening on a TCP port reports an AddressInfo.
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  close(): Promise<void> {
    return new Promise((done) => this.server.close(() => done()));
  }

  /** Connects Buildkite organization `o` to the monorepo, as its owner, with REST calls coming here. */
  async connect(owner: Machine, full: string): Promise<void> {
    const res = await owner.api("POST", `/v1/monorepos/${full}/ci/connections`, { service: "buildkite", organization: this.org, api_url: this.url });
    const out = await res.json();

    if (res.status !== 201) throw new Error(`connect: ${res.status} ${JSON.stringify(out)}`);
    this.connection = out.connection.id;
    this.webhookToken = out.webhook_token;
  }

  /** A pipeline that builds a repo: the repo's buildkite hook (each push asks here for a build). */
  async pipeline(owner: Machine, full: string, repo: string, slug: string): Promise<void> {
    const res = await owner.api("POST", `/v1/monorepos/${full}/repos/${repo}/hooks`, { type: "buildkite", buildkite: { organization: this.org, pipeline: slug, api_url: `${this.url}/buildkite` } });

    if (!res.ok) throw new Error(`hook: ${res.status} ${await res.text()}`);
  }

  /** A webhook, as Buildkite sends it, with the connection's token. */
  async send(event: string, slug: string, n: number, b: BuildOptions, j?: { id: string; key: string } & JobOptions): Promise<void> {
    const body = { event, build: build(this.org, slug, n, b), pipeline: pipeline(this.org, slug), ...(j ? { job: job(this.org, j.id, j.key, j) } : null) };

    const res = await fetch(`${BASE}/v1/integrations/buildkite/${this.connection}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-buildkite-event": event, "x-buildkite-token": this.webhookToken },
      body: JSON.stringify(body),
    });

    const out = await res.json();

    if (out.result !== "recorded") throw new Error(`${event}: ${res.status} ${JSON.stringify(out)}`);
  }

  private answer(req: IncomingMessage, raw: string, res: ServerResponse): void {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const json = (code: number, v: JsonValue) => res.writeHead(code, { "content-type": "application/json", "ratelimit-remaining": "40", "ratelimit-reset": "20" }).end(JSON.stringify(v));
    this.calls.push(`${req.method} ${path}`);

    // The hook's create-build on a push.
    if (path === "/buildkite") {
      this.created.push(JSON.parse(raw));

      return void json(201, {});
    }

    const at = `/v2/organizations/${this.org}/pipelines/`;

    if (!path.startsWith(at)) return void json(404, { message: "Not Found" });
    const [slug = "", ...rest] = path.slice(at.length).split("/");
    const tail = rest.join("/");
    let m: RegExpExecArray | null;

    if (tail === "" && req.method === "GET") return void json(200, { ...pipeline(this.org, slug), configuration: this.yaml.get(slug) ?? "steps:\n  - key: ci\n    command: npm test\n" });

    if (tail === "builds" && req.method === "POST") {
      const asked = JSON.parse(raw);
      this.created.push(asked);

      return void json(201, { ...build(this.org, slug, this.nextNumber++, { commit: asked.commit, branch: asked.branch, message: asked.message }), pipeline: pipeline(this.org, slug) });
    }

    if ((m = /^builds\/(\d+)\/cancel$/.exec(tail)) && req.method === "PUT") {
      return void json(200, { ...build(this.org, slug, Number(m[1]), { state: "canceling", commit: "HEAD", branch: "main", message: "" }), pipeline: pipeline(this.org, slug) });
    }

    if ((m = /^builds\/\d+\/jobs\/([^/]+)\/retry$/.exec(tail)) && req.method === "PUT") return void json(200, job(this.org, `${m[1]}-retry`, "ci", { state: "scheduled" }));

    if ((m = /^builds\/\d+\/jobs\/([^/]+)\/log$/.exec(tail))) return void res.writeHead(200, { "content-type": "text/plain" }).end(this.logs.get(m[1] ?? "") ?? "");

    if ((m = /^builds\/(\d+)\/annotations$/.exec(tail))) return void json(200, this.annotations.get(Number(m[1])) ?? []);

    if ((m = /^builds\/(\d+)\/artifacts$/.exec(tail))) return void json(200, this.artifacts.get(Number(m[1])) ?? []);

    if ((m = /^builds\/\d+\/jobs\/[^/]+\/artifacts\/([^/]+)\/download$/.exec(tail))) return void res.writeHead(302, { location: `https://artifacts.example/${m[1]}` }).end();

    json(404, { message: "Not Found" });
  }
}
