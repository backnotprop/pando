// Making real data for the e2e run: a monorepo and a project through the API,
// root files through the meta layer's socket, commits through the git door.
// A machine credential acts as the signed-in person, as `pando login` would.
// No secret is printed; git gets it from a credential helper reading the
// environment, with the system config and inherited helpers cleared (keychain
// safety, AGENTS.md).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";

export const BASE = "http://localhost:8813";

const STANDIN = "http://127.0.0.1:8814";

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

export class Machine {
  private readonly work = mkdtempSync(join(tmpdir(), "pando-web-e2e-"));

  constructor(
    private readonly secret: string,
    readonly name: string,
  ) {}

  /** A machine credential for the signed-in person (POST /v1/user/credentials). */
  static async make(page: Page, name: string): Promise<Machine> {
    const made = await browserPost(page, "/v1/user/credentials", { name });

    return new Machine(made.secret, name);
  }

  async api(method: string, path: string, body?: Record<string, string>): Promise<Response> {
    const headers = { authorization: `Bearer ${this.secret}`, "content-type": "application/json" };
    const send = () => fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });

    // wrangler dev sometimes resets a kept-alive connection; a reset request never reached the Worker, so it is sent again.
    return send().catch((error: Error) => {
      if (!String(error.cause).includes("ECONNRESET")) throw new Error(`${method} ${path}: ${error.message}`, { cause: error });

      return send();
    });
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
  commit(repo: string, url: string, branch: string, files: Record<string, string>, message: string): string {
    const dir = join(this.work, repo);

    if (!existsSync(join(dir, ".git"))) {
      if (branch === "main") {
        mkdirSync(dir, { recursive: true });
        this.git(dir, "init", "-q", "-b", "main");
      } else {
        this.git(this.work, "clone", "-q", url, repo);
      }
    }

    if (branch !== "main") this.git(dir, "checkout", "-q", "-B", branch, existsSync(join(dir, ".git/refs/remotes/origin/main")) ? "origin/main" : "main");

    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }

    this.git(dir, "add", "-A");
    this.git(dir, "-c", "user.name=Web Lane", "-c", `user.email=${this.name}@pando.invalid`, "commit", "-qm", message);

    return dir;
  }

  push(dir: string, url: string, branch: string): void {
    this.git(dir, "push", "-q", url, branch);
  }
}
