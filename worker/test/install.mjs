// The one-line install (worker/src/install.ts), end to end against `wrangler dev`: a release made here with
// `pando` built for this machine and a SHA256SUMS file, then `curl -fsSL <server>/install | sh` run in a temp HOME.
//   1. GET /install and /install.sh answer the script, for this server; HEAD answers no body; install is a reserved name;
//   2. a release whose SHA256SUMS does not match is refused, and nothing is installed;
//   3. the latest release installs at ~/.local/bin/pando, it runs, and the script says to sign in next;
//   4. another machine (uname faked: Linux, x86_64) gets pando-linux-amd64; an unknown system is refused;
//   5. with the project's releases members-only, the download is refused.
//
//   PANDO_URL=http://localhost:8887 node test/install.mjs
//
// Reads PANDO_BOOTSTRAP from worker/.dev.vars. Git runs with a temp HOME, no system config and an empty credential
// helper list before its own. Credentials are never printed. The repository it makes is deleted at the end.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeError, retryResetFetch, throwaways } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8887").replace(/\/$/, "");

const BOOT = /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];

const scrub = (s) => String(s).replace(/pando_[a-f0-9]{20,}/g, "<credential>");

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(scrub(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`));
};

const call = (method, path, secret, body) => request(URL_, method, path, { secret, body, redirect: "manual" });

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const id = Date.now().toString(36);

const work = mkdtempSync(join(tmpdir(), "pando-install-"));

const home = join(work, "home");

mkdirSync(home);

let S = null;

const tw = throwaways(async (full) => (await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`, S)).status);

const env = {
  PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Inst", GIT_AUTHOR_EMAIL: "inst@pando.invalid", GIT_COMMITTER_NAME: "Inst", GIT_COMMITTER_EMAIL: "inst@pando.invalid",
};

// The keychain rule (AGENTS.md): no system config, the helper list emptied, then this one helper.
const git = (args, cwd) =>
  spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...args], {
    cwd, env: { ...env, PANDO_SECRET: S }, encoding: "utf8",
  });

/** The one-line install as the docs give it, with the release address pointed at this run's repository. */
const install = (extra = {}) =>
  spawnSync("sh", ["-c", `curl -fsSL "${URL_}/install" | sh`], { cwd: work, env: { ...env, ...extra }, encoding: "utf8" });

const said = (x) => scrub(`${x.stdout}${x.stderr}`).trim().slice(0, 300);

/** A folder holding a fake `uname` that answers these names, put first on PATH. */
function fakeUname(name, s, m) {
  const dir = join(work, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "uname"), `#!/bin/sh\ncase "$1" in -s) echo ${s} ;; -m) echo ${m} ;; *) echo ${s} ;; esac\n`);
  chmodSync(join(dir, "uname"), 0o755);

  return `${dir}:${process.env.PATH}`;
}

const hostOs = process.platform === "darwin" ? "darwin" : "linux";

const hostArch = process.arch === "arm64" ? "arm64" : "amd64";

const hostFile = `pando-${hostOs}-${hostArch}`;

try {
  // ── 1. The script ──
  let r = await fetch(`${URL_}/install`);
  const script = await r.text();
  check("GET /install answers a shell script as plain text", r.status === 200 && r.headers.get("content-type")?.startsWith("text/plain") && script.startsWith("#!/bin/sh\n"));
  check("it is written for this server, and names the latest release of Pando's own code", script.includes(`server='${URL_}'`) && script.includes("/v1/monorepos/ramos/pando/repos/projects-pando/releases/latest/files"));
  r = await fetch(`${URL_}/install.sh`);
  check("GET /install.sh answers the same script", r.status === 200 && (await r.text()) === script);
  r = await fetch(`${URL_}/install`, { method: "HEAD" });
  check("HEAD /install answers no body", r.status === 200 && (await r.text()) === "");

  r = await call("POST", "/v1/users", BOOT, { login: "install" });
  check("install is a reserved name: no person or org can take /install", r.status === 400 && r.json?.error?.code === "reserved_name", `${r.status}`);

  // ── a plain repository with a main, and Pando built for this machine ──
  S = (await call("POST", "/v1/users", BOOT, { login: `inst-${id}` })).json?.credential?.secret;
  const M = `inst-${id}`;
  r = await call("POST", "/v1/monorepos", S, { name: M, kind: "repo" });
  const O = r.json?.monorepo?.owner;

  if (r.status === 201) tw.add(`${O}/${M}`);
  const url = r.json?.repos?.[0]?.clone_url;
  const base = `/v1/monorepos/${O}/${M}/repos/${M}`;
  check("a plain repository made", r.status === 201 && !!url);
  const src = join(work, "src");
  mkdirSync(src);
  git(["init", "-q"], src);
  writeFileSync(join(src, "README.md"), "# inst\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  check("main pushed", git(["push", "-q", url, "main"], src).status === 0);

  const bin = join(work, "built-pando");
  const built = spawnSync("go", ["build", "-buildvcs=false", "-o", bin, "./cmd/pando"], { cwd: fileURLToPath(new URL("../../cli", import.meta.url)), encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
  check(`pando builds for this machine (${hostFile})`, built.status === 0, built.stderr?.slice(0, 200));
  const pandoBytes = readFileSync(bin);
  const linuxBytes = Buffer.from("#!/bin/sh\necho linux amd64\n");

  const put = (tag, name, bytes) =>
    fetch(`${URL_}${base}/releases/${tag}/files/${name}`, { method: "PUT", headers: { authorization: `Bearer ${S}`, "content-type": "application/octet-stream", "x-pando-sha256": sha256(bytes) }, body: bytes }).then((x) => x.status);

  /** A release with this machine's pando, pando-linux-amd64 and SHA256SUMS (as tools/release.sh writes it), published. */
  async function release(tag, sums) {
    const made = await call("POST", `${base}/releases`, S, { tag, draft: true });
    const ups = [await put(tag, hostFile, pandoBytes), await put(tag, "pando-linux-amd64", linuxBytes), await put(tag, "SHA256SUMS", Buffer.from(sums))];
    const pub = await call("POST", `${base}/releases/${tag}/publish`, S, { force: true });

    return made.status === 201 && ups.every((s) => s === 201) && pub.status === 200;
  }

  const goodSums = `${sha256(linuxBytes)}  pando-linux-amd64\n${sha256(pandoBytes)}  ${hostFile}\n`;
  r = await call("PATCH", base, S, { releases_public: true });
  check("the project's releases download without signing in", r.status === 200 && r.json?.releases_public === true);
  const from = { PANDO_INSTALL_FROM: `${URL_}${base}/releases/latest/files` };
  const installed = join(home, ".local", "bin", "pando");

  // ── 2. A file that does not match SHA256SUMS ──
  check("v0.1.0 published, its SHA256SUMS wrong for this machine's file", await release("v0.1.0", `${"0".repeat(64)}  ${hostFile}\n${sha256(linuxBytes)}  pando-linux-amd64\n`));
  let run = install(from);
  check("the install refuses a file that does not match its SHA-256, and installs nothing", run.status !== 0 && run.stderr.includes(`${hostFile} does not match its SHA-256 in SHA256SUMS`) && !existsSync(installed), said(run));

  // ── 3. The latest release installs ──
  check("v0.2.0 published, with a matching SHA256SUMS", await release("v0.2.0", goodSums));
  run = install(from);
  check("curl -fsSL <server>/install | sh installs the latest release's pando at ~/.local/bin/pando", run.status === 0 && existsSync(installed) && sha256(readFileSync(installed)) === sha256(pandoBytes), said(run));
  check("it is executable", existsSync(installed) && (statSync(installed).mode & 0o111) === 0o111);
  check("it says which file it fetched and where it put it", run.stdout.includes(`Downloading ${hostFile} from the latest release`) && run.stdout.includes(`Installed pando at ${installed}`));
  check("it says ~/.local/bin is not on PATH, and how to add it", run.stdout.includes(`${join(home, ".local", "bin")} is not on your PATH`) && run.stdout.includes("export PATH="));
  check("it prints the next step: pando login --server <this server>", run.stdout.trimEnd().endsWith(`pando login --server ${URL_}`), run.stdout.trimEnd().split("\n").pop());
  const help = spawnSync(installed, ["help"], { env, encoding: "utf8" });
  check("the installed pando runs", help.status === 0 && /pando login/.test(`${help.stdout}${help.stderr}`), said(help));
  run = install({ ...from, PATH: `${join(home, ".local", "bin")}:${process.env.PATH}` });
  check("run again, it replaces the file in place, and says nothing about PATH when it is on it", run.status === 0 && !run.stdout.includes("not on your PATH") && sha256(readFileSync(installed)) === sha256(pandoBytes), said(run));

  // ── 4. Other machines ──
  const other = join(work, "other-bin");
  run = install({ ...from, PATH: fakeUname("linux-x86", "Linux", "x86_64"), PANDO_INSTALL_DIR: other });
  check("on Linux x86_64 it fetches pando-linux-amd64 (PANDO_INSTALL_DIR honoured)", run.status === 0 && run.stdout.includes("Downloading pando-linux-amd64") && readFileSync(join(other, "pando")).equals(linuxBytes), said(run));
  run = install({ ...from, PATH: fakeUname("freebsd", "FreeBSD", "amd64"), PANDO_INSTALL_DIR: join(work, "none") });
  check("an unknown system is refused with a plain message", run.status !== 0 && run.stderr.includes("there is no pando build for FreeBSD") && !existsSync(join(work, "none")), said(run));
  run = install({ ...from, PATH: fakeUname("riscv", "Linux", "riscv64"), PANDO_INSTALL_DIR: join(work, "none") });
  check("so is an unknown processor", run.status !== 0 && run.stderr.includes("there is no pando build for riscv64"), said(run));

  // ── 5. Members only ──
  await call("PATCH", base, S, { releases_public: false });
  run = install({ ...from, PANDO_INSTALL_DIR: join(work, "none") });
  check("with releases members-only, the download is refused and nothing installed", run.status !== 0 && run.stderr.includes("could not download") && !existsSync(join(work, "none", "pando")), said(run));
} catch (err) {
  check("no unexpected error", false, describeError(err));
} finally {
  check("this run's repository is deleted", await tw.cleanup());
  spawnSync("chmod", ["-R", "u+w", work]);
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((x) => !x).length;

console.log(`\n${results.length - failed}/${results.length} checks passed`);

process.exit(failed ? 1 : 0);
