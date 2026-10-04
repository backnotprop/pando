// A stand-in for github.com's git, for the mirror's tests: real git (`git
// http-backend`) serving bare repositories over smart HTTP on this machine.
// Any Basic login is accepted; a repository is made the first time it is
// named. Pushes are counted per repository, so a test can see how many runs
// reached it.
//
//   node test/git-standin.mjs [port]        (default 8835; ctrl-C to stop)
//
// or, from a test: `const s = await startGitStandin(8835)`, then s.root (the
// bare repositories), s.pushes(fullName), s.git(fullName, ...args), s.close().
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

/** Start the stand-in. Paths: /<owner>/<name>.git/(info/refs|git-upload-pack|git-receive-pack). */
export async function startGitStandin(port = 8835, { root = mkdtempSync(join(tmpdir(), "pando-git-standin-")) } = {}) {
  const pushes = new Map();
  const bare = (full) => join(root, `${full}.git`);

  const ensure = (full) => {
    const dir = bare(full);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      spawnSync("git", ["init", "-q", "--bare", "-b", "main", dir], { env: GIT_ENV });
      spawnSync("git", ["-C", dir, "config", "http.receivepack", "true"], { env: GIT_ENV });
    }

    return dir;
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const m = /^\/([^/]+)\/([^/]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);

    if (!m) return res.writeHead(404).end("not a git path\n");
    const full = `${m[1]}/${m[2]}`;
    ensure(full);

    if (m[3] === "git-receive-pack") pushes.set(full, (pushes.get(full) ?? 0) + 1);

    const cgiEnv = {
      ...GIT_ENV,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/${full}.git/${m[3]}`,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      REMOTE_USER: "mirror",
      REMOTE_ADDR: "127.0.0.1",
    };

    // A chunked body has no length: git http-backend then reads to the end.
    if (req.headers["content-length"]) cgiEnv.CONTENT_LENGTH = req.headers["content-length"];
    const cgi = spawn("git", ["http-backend"], { env: cgiEnv });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let headersDone = false;

    cgi.stdout.on("data", (chunk) => {
      if (headersDone) return res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");

      if (end < 0) return;
      headersDone = true;
      let status = 200;
      const headers = {};

      for (const line of head.subarray(0, end).toString().split("\r\n")) {
        const i = line.indexOf(":");
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();

        if (k.toLowerCase() === "status") status = parseInt(v, 10);
        else headers[k] = v;
      }

      res.writeHead(status, headers);
      res.write(head.subarray(end + 4));
    });
    cgi.stdout.on("end", () => res.end());
    cgi.stderr.on("data", (d) => process.env.STANDIN_DEBUG && process.stderr.write(d));
  });

  await new Promise((r) => server.listen(port, "127.0.0.1", r));

  return {
    root,
    port,
    url: (full) => `http://127.0.0.1:${port}/${full}.git`,
    pushes: (full) => pushes.get(full) ?? 0,
    bare,
    /** Run git in a bare repository (rev-parse, fsck, log...). */
    git: (full, ...args) => spawnSync("git", ["-C", bare(full), ...args], { env: GIT_ENV, encoding: "utf8" }),
    close: async () => {
      await new Promise((r) => server.close(r));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startGitStandin(Number(process.argv[2] ?? 8835));
  console.log(`git stand-in on http://127.0.0.1:${s.port}/<owner>/<name>.git, repositories in ${s.root}`);
}
