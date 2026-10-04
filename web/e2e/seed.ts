// Making real data for the e2e run: a monorepo and a project through the API,
// root files through the meta layer's socket, commits through the git door.
// A machine credential acts as the signed-in person, as `pando login` would.
// No secret is printed; git gets it from a credential helper reading the
// environment, with the system config and inherited helpers cleared (keychain
// safety, AGENTS.md).
import { execFileSync, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import { STANDIN_PORT, WORKER_PORT } from "./ports.ts";

export const BASE = `http://localhost:${WORKER_PORT}`;

/**
 * The first visible step after page.goto: the page waits on its server reads
 * (a tree, then a file, each about 1 s in wrangler dev against the real
 * Artifacts, retried after 1 s and 2 s on a 5xx), so it gets 30 s rather than
 * expect's 15. The run's slowest read is named at the end (e2e/reads.ts).
 */
export const HARD_LOAD = { timeout: 30_000 };

const STANDIN = `http://127.0.0.1:${STANDIN_PORT}`;

export interface Person {
  id: string;
  email: string;
  email_verified: boolean;
  first_name: string;
  last_name: string | null;
}

/** Tells the stand-in WorkOS who signs in next. */
export async function nextSignIn(person: Person): Promise<void> {
  await fetch(`${STANDIN}/_next`, { method: "POST", body: JSON.stringify(person) });
}

/** A write as the browser session (the cookie, Pando's own Origin). */
export async function browserPost(page: Page, path: string, data: Record<string, string>) {
  const res = await page.request.post(path, { data, headers: { origin: BASE } });

  if (!res.ok()) throw new Error(`${path}: ${res.status()} ${await res.text()}`);

  return res.json();
}

/**
 * Saves root files as a machine would, over the meta layer's socket, from the
 * signed-in page (its cookie and Origin): hello, then one save each, waiting
 * for every answer.
 */
export async function saveRootFiles(page: Page, full: string, machine: string, files: Record<string, string> | [string, string][]): Promise<void> {
  const saves = Array.isArray(files) ? files : Object.entries(files);

  const problem = await page.evaluate(
    async ({ full, machine, saves }) => {
      const ws = new WebSocket(`${location.origin.replace("http", "ws")}/v1/monorepos/${full}/meta/socket`);
      const frames: { type: string; id?: string; version?: number }[] = [];
      const versions = new Map<string, number>();
      ws.onmessage = (m) => frames.push(JSON.parse(String(m.data)));

      const until = async (done: () => boolean) => {
        for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 50));

        return done();
      };

      if (!(await until(() => ws.readyState === WebSocket.OPEN))) return "the socket did not open";
      ws.send(JSON.stringify({ type: "hello", since: 0, machine }));

      if (!(await until(() => frames.some((f) => f.type === "caught_up")))) return "no caught_up";

      for (const [i, [path, text]] of saves.entries()) {
        const bytes = new TextEncoder().encode(text);
        const head = new TextEncoder().encode(`blob ${bytes.length}\0`);
        const all = new Uint8Array(head.length + bytes.length);
        all.set(head);
        all.set(bytes, head.length);
        const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-1", all))].map((b) => b.toString(16).padStart(2, "0")).join("");
        ws.send(JSON.stringify({ type: "save", id: `s${i}`, path, base_version: versions.get(path) ?? 0, sha, bytes: btoa(String.fromCharCode(...bytes)) }));

        if (!(await until(() => frames.some((f) => f.id === `s${i}`)))) return `no answer for ${path}`;
        const answer = frames.find((f) => f.id === `s${i}`);

        if (answer?.type !== "accepted") return `${path}: ${JSON.stringify(answer)}`;
        versions.set(path, answer.version ?? 0);
      }

      ws.close();

      return null;
    },
    { full, machine, saves },
  );

  if (problem) throw new Error(`meta save: ${problem}`);
}

/**
 * A status as a CI service posts it: with a status token signed by the
 * Worker's PANDO_STATUS_SECRET (read from worker/.dev.vars, never printed), so
 * Pando stamps the service on it, as worker/test/ci.mjs does.
 */
export async function ciStatus(member: Machine, full: string, repo: string, sha: string, context: string, state: "pending" | "success" | "failure") {
  const vars = readFileSync(new URL("../../worker/.dev.vars", import.meta.url), "utf8");
  const secret = /^PANDO_STATUS_SECRET=(.*)$/m.exec(vars)?.[1];

  if (!secret) throw new Error("worker/.dev.vars has no PANDO_STATUS_SECRET");

  const info = await (await member.api("GET", `/v1/monorepos/${full}`)).json();
  const claims = { m: info.id, r: repo, s: sha, a: "buildkite", h: "e2e", x: Math.floor(Date.now() / 1000) + 3600 };
  const signed = `pst1.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  const token = `${signed}.${createHmac("sha256", secret).update(signed).digest("base64url")}`;

  const res = await fetch(`${BASE}/v1/monorepos/${full}/repos/${repo}/statuses/${sha}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ state, context, target_url: `https://buildkite.com/pando/e2e/builds/1` }),
  });

  if (!res.ok) throw new Error(`status ${context}: ${res.status} ${await res.text()}`);
}

/** Node's WebSocket (undici) also takes `{ headers }`; the DOM types this project loads leave that form out. */
type NodeWebSocket = new (url: string, init: string[] | { headers: { authorization: string } }) => WebSocket;

/** A JSON request body. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonBody;

export interface JsonBody {
  readonly [key: string]: JsonValue;
}

export class Machine {
  private readonly work = mkdtempSync(join(tmpdir(), "pando-web-e2e-"));

  /** `author` is the git author name its commits carry. */
  constructor(
    private readonly secret: string,
    readonly name: string,
    readonly author = "Web Lane",
  ) {}

  /** A machine credential for the signed-in person (POST /v1/user/credentials); `kind` sandbox for a cloud sandbox. */
  static async make(page: Page, name: string, author?: string, kind: "machine" | "sandbox" = "machine"): Promise<Machine> {
    const made = await browserPost(page, "/v1/user/credentials", { name, kind });

    return new Machine(made.secret, name, author);
  }

  async api(method: string, path: string, body?: JsonBody): Promise<Response> {
    const headers = { authorization: `Bearer ${this.secret}`, "content-type": "application/json" };
    const send = () => fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });

    // wrangler dev sometimes resets a kept-alive connection; a reset request never reached the Worker, so it is sent again.
    return send().catch((error: Error) => {
      if (!String(error.cause).includes("ECONNRESET")) throw new Error(`${method} ${path}: ${error.message}`, { cause: error });

      return send();
    });
  }

  /**
   * Follows the monorepo as `pando` does: its event socket, then hello with
   * this machine's worktrees, so the machine counts as connected until the
   * socket closes.
   */
  async follow(full: string, worktrees: string[]): Promise<WebSocket> {
    // SAFETY: the e2e runs in Node 24, whose global WebSocket is undici's, which sends init.headers.
    const Socket = WebSocket as NodeWebSocket;
    const ws = new Socket(`${BASE.replace("http", "ws")}/v1/monorepos/${full}/events`, { headers: { authorization: `Bearer ${this.secret}` } });

    await new Promise<void>((ok, fail) => {
      ws.onopen = () => ws.send(JSON.stringify({ type: "hello", machine: this.name, worktrees }));

      ws.onmessage = (m) => {
        if (String(m.data).includes('"hello_ok"')) ok();
      };

      ws.onerror = () => fail(new Error("the event socket failed"));
    });

    return ws;
  }

  /** Where this machine keeps its clone of `repo`. */
  dir(repo: string): string {
    return join(this.work, repo);
  }

  /** git, keychain-safe: no system config, helpers cleared, then one that reads the secret from the environment. */
  git(cwd: string, ...args: string[]): string {
    const helper = '!f() { echo username=pando; echo "password=$PANDO_E2E_SECRET"; }; f';

    return execFileSync("git", ["-c", "credential.helper=", "-c", `credential.helper=${helper}`, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: this.work, GIT_TERMINAL_PROMPT: "0", PANDO_E2E_SECRET: this.secret },
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  /**
   * Files committed on `branch`, which starts from main: a new repo starts
   * main itself; a machine that has not seen the repo clones it first.
   */
  commit(repo: string, url: string, branch: string, files: Record<string, string | Uint8Array>, message: string): string {
    const dir = join(this.work, repo);

    if (!existsSync(join(dir, ".git"))) {
      if (branch === "main") {
        mkdirSync(dir, { recursive: true });
        this.git(dir, "init", "-q", "-b", "main");
      } else {
        this.git(this.work, "clone", "-q", url, repo);
      }
    }

    if (branch !== "main") {
      const exists = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: dir }).status === 0;
      const from = existsSync(join(dir, ".git/refs/remotes/origin/main")) ? "origin/main" : "main";

      // A branch seen before takes more commits; a new one starts from main.
      this.git(dir, "checkout", "-q", ...(exists ? [branch] : ["-b", branch, from]));
    } else if (existsSync(join(dir, ".git/refs/heads/main"))) {
      this.git(dir, "checkout", "-q", "main");
    }

    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }

    this.git(dir, "add", "-A");
    this.git(dir, "-c", `user.name=${this.author}`, "-c", `user.email=${this.name}@pando.invalid`, "commit", "-qm", message);

    return dir;
  }

  push(dir: string, url: string, branch: string): void {
    this.git(dir, "push", "-q", url, branch);
  }
}

/** What one frame showed: the top bar's height, the code's (the coloured view, else the plain lines) and its top, and the rows playing their arrival. */
export interface Frame {
  bar: number;
  code: number;
  top: number;
  arrived: string[];
}

declare global {
  interface Window {
    /** The frames watchFrames saw, in the page under test. */
    pandoFrames?: Frame[];
    /** The long tasks watchLongTasks saw (their lengths in ms). */
    pandoLongTasks?: number[];
  }
}

/**
 * Records what the page shows at every animation frame from now on (in the
 * page, by requestAnimationFrame), each change once: a flash of one frame is
 * caught here, where an assertion that polls would miss it. The returned
 * function reads the frames seen so far.
 */
export async function watchFrames(page: Page): Promise<() => Promise<Frame[]>> {
  await page.evaluate(() => {
    const frames: Frame[] = [];
    const height = (el: Element | null) => (el ? Math.round(el.getBoundingClientRect().height) : 0);
    const code = () => document.querySelector("diffs-container") ?? document.querySelector("main pre");
    let last = "";

    window.pandoFrames = frames;

    const tick = () => {
      const frame = {
        bar: height(document.querySelector("header")),
        code: height(code()),
        top: Math.round(code()?.getBoundingClientRect().top ?? 0),
        arrived: [...document.querySelectorAll(".arrived")].map((e) => e.textContent ?? ""),
      };

      const key = JSON.stringify(frame);

      if (key !== last) frames.push(frame);

      last = key;
      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  });

  return () => page.evaluate(() => window.pandoFrames ?? []);
}

/** Records the page's long tasks (over 50 ms) from now on; the returned function reads their lengths, in ms. */
export async function watchLongTasks(page: Page): Promise<() => Promise<number[]>> {
  await page.evaluate(() => {
    const seen: number[] = [];

    window.pandoLongTasks = seen;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) seen.push(Math.round(e.duration));
    }).observe({ type: "longtask" });
  });

  return () => page.evaluate(() => window.pandoLongTasks ?? []);
}
