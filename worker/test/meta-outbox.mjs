// meta.saved through the meta layer object's outbox (audit M3): each save's
// event is a row written with the save, sent to the monorepo object's event
// log in order, and kept there once by its version. Sends that fail are tried
// again on the alarm; a batch whose answer was lost is sent again and doubles
// nothing; events left when the object stopped go out on its next wake.
//
//   npx wrangler dev --port 8797 --persist-to <dir> --var META_TEST:1
//   PANDO_URL=http://localhost:8797 node test/meta-outbox.mjs
//
// Credentials stay in memory and are never printed. It deletes its monorepo.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describeError, retryResetFetch, throwaways } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8797").replace(/\/$/, "");

const WS_ = URL_.replace(/^http/, "ws");

const BOOT = process.env.PANDO_BOOTSTRAP ?? /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`.replace(/pando_[a-f0-9]{20,}/g, "<credential>"));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let S = null;

const call = (method, path, body, secret = S) => request(URL_, method, path, { secret, body });

const blobSha = (bytes) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest("hex");

async function waitFor(pred, ms) {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const v = await pred();

    if (v) return v;
    await sleep(200);
  }

  return null;
}

const id = Date.now().toString(36);

const O = `mo-${id}`;

const M = `mo-${id}`;

let made = false;

const tw = throwaways(async (full) => (await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`)).status);

try {
  S = (await call("POST", "/v1/users", { login: O }, BOOT)).json?.credential?.secret;
  const r = await call("POST", "/v1/monorepos", { name: M });
  made = r.status === 201;

  if (made) tw.add(`${O}/${M}`);
  const MID = r.json?.monorepo?.id;
  check("a user and a monorepo", !!S && made && !!MID, `${r.status}`);

  if (!MID) throw new Error("no monorepo to test with");

  // The meta.saved events in the monorepo's own log (read from the monorepo object only).
  const saved = async (path) => {
    const page = await call("GET", `/v1/monorepos/${O}/${M}/events?since=0&limit=500`);

    return (page.json?.events ?? []).filter((e) => e.kind === "meta.saved" && e.key === path);
  };

  const outbox = async (set = null) => (set ? call("POST", "/v1/_meta/test", { monorepo: MID, ...set }, BOOT) : call("GET", `/v1/_meta/test?monorepo=${MID}`, null, BOOT));

  // One meta layer socket, a machine on it.
  const frames = [];
  const ws = new WebSocket(`${WS_}/v1/monorepos/${O}/${M}/meta/socket`, { headers: { authorization: `Bearer ${S}` } });
  ws.onmessage = (m) => frames.push(JSON.parse(m.data));
  ws.onerror = () => {}; // the crash check closes it

  await waitFor(() => ws.readyState === 1, 10_000);
  ws.send(JSON.stringify({ type: "hello", since: 0, machine: "mo-mbp", agent: null, client: "meta-outbox-test/1" }));
  await waitFor(() => frames.find((f) => f.type === "caught_up"), 10_000);

  const save = async (path, text) => {
    const bytes = Buffer.from(text);
    const sid = `s-${path}`;
    ws.send(JSON.stringify({ type: "save", id: sid, path, base_version: 0, sha: blobSha(bytes), bytes: bytes.toString("base64") }));

    return (await waitFor(() => frames.find((f) => f.type === "accepted" && f.id === sid), 10_000))?.version ?? null;
  };

  const first = await outbox();

  if (first.status === 404) throw new Error("start wrangler dev with --var META_TEST:1");
  await waitFor(async () => (await outbox()).json?.waiting === 0, 10_000);

  // 1. Sends fail twice: the saves are accepted at once; their events wait, then arrive after the retries (1 s, 5 s), once each, in order.
  let t = await outbox({ fail: 2 });
  check("the test switch is on (META_TEST)", t.status === 200 && t.json?.fail === 2, JSON.stringify(t.json));
  const paths = ["notes/a.md", "notes/b.md", "notes/c.md"];
  const versions = [];

  for (const p of paths) versions.push(await save(p, `${p}\n`));
  check("three saves are accepted while the sends fail", versions.every((v) => Number.isInteger(v)), versions.join(", "));
  await sleep(700);
  t = await outbox();
  const early = (await Promise.all(paths.map(saved))).flat();
  check("their events wait in the outbox after a failed send, none in the log yet", t.json?.waiting >= 3 && t.json?.tries >= 1 && early.length === 0, `${JSON.stringify(t.json)}, ${early.length} in the log`);
  const t0 = Date.now();

  const all = await waitFor(async () => {
    const got = (await Promise.all(paths.map(saved))).flat();

    return got.length >= 3 ? got : null;
  }, 20_000);

  const ms = Date.now() - t0;
  await sleep(1_500); // a double would come with the next send
  const settled = (await Promise.all(paths.map(saved))).flat().sort((a, b) => a.seq - b.seq);
  check(
    "after the retries each arrives once, in the order saved, with its version",
    !!all && settled.length === 3 && settled.every((e, i) => e.key === paths[i] && e.row?.version === versions[i]),
    `${settled.map((e) => `${e.key}@${e.row?.version}`).join(", ")} after ${ms} ms more`,
  );
  t = await outbox();
  check("then the outbox is empty", t.json?.waiting === 0 && t.json?.tries === 0, JSON.stringify(t.json));

  // 2. The answer is lost: the batch is sent again, and the log keeps the event once (its version is the key).
  await outbox({ lose: 1 });
  const vd = await save("notes/d.md", "d\n");

  const sentTwice = await waitFor(async () => {
    const s = (await outbox()).json;

    return s?.lose === 0 && s?.waiting === 0 ? s : null;
  }, 15_000);

  await sleep(500);
  const d = await saved("notes/d.md");
  check("a batch sent again after a lost answer leaves the event in the log once", !!sentTwice && d.length === 1 && d[0].row?.version === vd, `${d.length} in the log, version ${d[0]?.row?.version} vs ${vd}`);

  // 3. The object stops after the save, before its event is sent: the event goes out on its next wake (the save's commit alarm), once.
  await outbox({ crash: true });
  const ve = await save("notes/e.md", "e\n");
  check("a save is accepted, then the object stops before sending its event", Number.isInteger(ve));

  const t1 = Date.now();

  const e = await waitFor(async () => {
    const got = await saved("notes/e.md");

    return got.length ? got : null;
  }, 40_000);

  const wake = Date.now() - t1;

  await sleep(1_500);
  const eAfter = await saved("notes/e.md");
  check("its event reaches the log on the object's next wake, once, with no request to it", !!e && eAfter.length === 1 && eAfter[0].row?.version === ve, `${eAfter.length} after ${wake} ms`);
  ws.close();
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  if (made) check(`delete ${O}/${M}`, await tw.cleanup());
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
