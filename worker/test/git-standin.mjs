// A stand-in for GitHub, for the mirror's tests, on this machine:
//   /git/<owner>/<name>.git/...   real git (`git http-backend`) over bare repositories, any Basic login
//                                 (also at /<owner>/<name>.git/... for the spike); a repository is made the
//                                 first time it is named; …/info/lfs/objects/batch is a small LFS server
//   /api/...                      the GitHub REST calls Pando makes (token mint with the app's JWT checked,
//                                 /user, /user/installations, /installation/repositories, repository
//                                 creation, the token revoke)
//   /web/...                      github.com's pages: login/oauth/authorize (approves at once) and
//                                 apps/<slug>/installations/new (installs at once), both back to the callback
//
//   node test/git-standin.mjs [port]        (default 8835; ctrl-C to stop)
//
// From a test: `const s = await startGitStandin(8835, { publicKey, callback })`; then s.url(full),
// s.pushes(full), s.git(full, ...args), s.addInstallation(...), s.addRepo(...), s.fail(path regexp,
// status, times), s.lfs (oid -> bytes stored), s.close().
import { spawn, spawnSync } from "node:child_process";
import { createVerify, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

const b64urlJson = (s) => JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());

/** Start the stand-in. `publicKey`: the app's public key (PEM), to check its JWTs; `callback`: Pando's callback URL. */
export async function startGitStandin(port = 8835, { root = mkdtempSync(join(tmpdir(), "pando-git-standin-")), publicKey = null, callback = null, user = { id: 4242, login: "backnotprop" } } = {}) {
  const pushes = new Map();
  const lfs = new Map();
  const failures = [];
  const codes = new Map();
  let nextId = 1000;
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

  const s = {
    root,
    port,
    /** The person's GitHub user. */
    user,
    /** Installations the person reaches (filled by an install, or by a test). */
    installations: [],
    /** Every installation that exists, the person's or not. */
    allInstallations: [],
    /** Repositories each installation reaches: installation id -> [{id, full_name, private, html_url}]. */
    repos: new Map(),
    lfs,
    /** The JWT payloads the token mint received. */
    jwts: [],
    url: (full) => `http://127.0.0.1:${port}/git/${full}.git`,
    pushes: (full) => pushes.get(full) ?? 0,
    bare,
    /** Run git in a bare repository (rev-parse, fsck, log...). */
    git: (full, ...args) => spawnSync("git", ["-C", ensure(full), ...args], { env: GIT_ENV, encoding: "utf8" }),
    /** Answer `status` to the next `times` requests whose path matches. */
    fail: (re, status, times = 1) => failures.push({ re, status, times }),
    /** A repository the installation reaches (made empty now). */
    addRepo: (installation, full, priv = true) => {
      ensure(full);
      const repo = { id: nextId++, full_name: full, private: priv, html_url: `https://github.com/${full}` };
      s.repos.set(installation, [...(s.repos.get(installation) ?? []), repo]);

      return repo;
    },
    /** An installation that exists; `mine`: the person reaches it. */
    addInstallation: (id, login, mine = true, type = "User") => {
      const i = { id, account: { id: 9000 + id, login, type }, repository_selection: "selected", suspended_at: null };
      s.allInstallations.push(i);

      if (mine) s.installations.push(i);

      return i;
    },
    close: async () => {
      await new Promise((r) => server.close(r));
      rmSync(root, { recursive: true, force: true });
    },
  };

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(body === null ? "" : JSON.stringify(body));
  };

  const readBody = (req) =>
    new Promise((r) => {
      const parts = [];
      req.on("data", (d) => parts.push(d));
      req.on("end", () => r(Buffer.concat(parts)));
    });

  const jwtOk = (auth) => {
    const t = /^Bearer (.+)$/.exec(auth ?? "")?.[1];

    if (!t) return false;
    const [h, p, sig] = t.split(".");

    if (!h || !p || !sig) return false;
    const payload = b64urlJson(p);
    s.jwts.push(payload);

    if (!publicKey) return true;
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${p}`);

    return v.verify(publicKey, Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64")) && payload.exp > Date.now() / 1000;
  };

  const git = (req, res, full, service) => {
    ensure(full);

    if (service === "git-receive-pack") pushes.set(full, (pushes.get(full) ?? 0) + 1);
    const url = new URL(req.url, "http://x");

    const cgiEnv = {
      ...GIT_ENV,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/${full}.git/${service}`,
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
  };

  const back = (res, state, extra = "") => {
    const code = randomBytes(8).toString("hex");
    codes.set(code, true);
    res.writeHead(302, { location: `${callback}?code=${code}&state=${encodeURIComponent(state)}${extra}` }).end();
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    const f = failures.find((x) => x.times > 0 && x.re.test(path));

    if (f) {
      f.times--;

      return send(res, f.status, { message: `stand-in failure ${f.status}` });
    }

    // ── git, and its LFS ──
    const g = /^(?:\/git)?\/([^/]+)\/([^/]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack|info\/lfs\/objects\/batch)$/.exec(path);

    if (g) {
      const full = `${g[1]}/${g[2]}`;

      if (g[3] !== "info/lfs/objects/batch") return git(req, res, full, g[3]);
      const body = JSON.parse((await readBody(req)).toString());

      const objects = (body.objects ?? []).map((o) =>
        lfs.has(o.oid)
          ? { oid: o.oid, size: o.size }
          : { oid: o.oid, size: o.size, actions: { upload: { href: `http://127.0.0.1:${port}/lfs-upload/${o.oid}`, header: { "x-test": "1" } } } },
      );

      return send(res, 200, { transfer: "basic", objects }, { "content-type": "application/vnd.git-lfs+json" });
    }

    const up = /^\/lfs-upload\/([0-9a-f]{64})$/.exec(path);

    if (up && req.method === "PUT") {
      lfs.set(up[1], await readBody(req));

      return send(res, 200, null);
    }

    // ── github.com's pages ──
    if (path === "/web/login/oauth/authorize") return back(res, url.searchParams.get("state") ?? "");

    if (/^\/web\/apps\/[^/]+\/installations\/new$/.test(path)) {
      const i = s.addInstallation(100 + s.allInstallations.length, user.login, true);

      return back(res, url.searchParams.get("state") ?? "", `&installation_id=${i.id}&setup_action=install`);
    }

    if (path === "/web/login/oauth/access_token" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)).toString());

      if (!codes.delete(b.code) || b.client_secret !== "test-secret") return send(res, 200, { error: "bad_verification_code" });

      return send(res, 200, { access_token: `ghu_test_${randomBytes(6).toString("hex")}`, token_type: "bearer" });
    }

    // ── the REST API ──
    const auth = req.headers.authorization ?? "";
    const tokenFor = /^\/api\/app\/installations\/(\d+)\/access_tokens$/.exec(path);

    if (tokenFor && req.method === "POST") {
      if (!jwtOk(auth)) return send(res, 401, { message: "A JSON web token could not be decoded" });
      const id = Number(tokenFor[1]);

      if (!s.allInstallations.some((i) => i.id === id)) return send(res, 404, { message: "Not Found" });
      const b = JSON.parse((await readBody(req)).toString() || "{}");
      const reach = (s.repos.get(id) ?? []).map((r) => r.id);

      if ((b.repository_ids ?? []).some((r) => !reach.includes(r))) return send(res, 422, { message: "There is at least one repository that does not exist or is not accessible to the parent installation." });

      return send(res, 201, { token: `ghs_test_${id}_${randomBytes(4).toString("hex")}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }

    if (path === "/api/installation/repositories") {
      const id = Number(/^Bearer ghs_test_(\d+)_/.exec(auth)?.[1]);
      const repos = s.repos.get(id) ?? [];
      const page = Number(url.searchParams.get("page") ?? 1);

      return send(res, 200, { total_count: repos.length, repositories: page === 1 ? repos : [] });
    }

    const userAuth = auth.startsWith('Bearer ghu_test_');

    if (path === "/api/user" && userAuth) return send(res, 200, { id: user.id, login: user.login });

    if (path === "/api/user/installations" && userAuth) return send(res, 200, { total_count: s.installations.length, installations: s.installations });

    const owner = path === "/api/user/repos" ? user.login : /^\/api\/orgs\/([^/]+)\/repos$/.exec(path)?.[1];

    if (owner && req.method === "POST" && userAuth) {
      const b = JSON.parse((await readBody(req)).toString());
      const inst = s.installations.find((i) => i.account.login === owner);

      if (!inst) return send(res, 403, { message: "not allowed" });
      const full = `${owner}/${b.name}`;

      if ((s.repos.get(inst.id) ?? []).some((r) => r.full_name === full)) return send(res, 422, { message: "name already exists on this account" });

      return send(res, 201, s.addRepo(inst.id, full, b.private !== false));
    }

    if (/^\/api\/applications\/[^/]+\/token$/.test(path) && req.method === "DELETE") return send(res, 204, null);

    send(res, 404, { message: `the stand-in has no ${req.method} ${path}` });
  });

  await new Promise((r) => server.listen(port, "127.0.0.1", r));

  return s;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startGitStandin(Number(process.argv[2] ?? 8835));
  console.log(`GitHub stand-in on http://127.0.0.1:${s.port} (git /git, REST /api, pages /web), repositories in ${s.root}`);
}
