// One run with a real model, GLM-5.3 Flash on Workers AI (the default).
// It costs real money (cents), so it is not in the gate: run it by hand,
// rarely. The server must run without the scripted model forced; launches
// name no model, so they use the default.
//
//   agents/test/serve.sh start && node agents/test/real-model.mjs
//
// It prints the transcript in short, the tokens Workers AI counted, and their
// price at the list prices ($0.15 per million input, $0.03 cached, $0.50
// output, research/external/.../workers-ai/platform-pricing.md).

import { call, check, done, makeRepo, say, scrub, sleep } from "./lib.mjs";

const t = await makeRepo("agents-real", { "README.md": "# Real model\n\nThis repository has one file. Its last line has a spelling mistake: recieve.\n" });

try {
  const prompt = "README.md has a spelling mistake on its last line. Fix it, commit with a short message, push your branch, then merge it with the merge tool. Then say in one sentence what you did.";
  let r = await call("POST", `/v1/monorepos/${t.full}/agents`, t.secret, { prompt });
  check("launched with the default model", r.status === 201 && r.json?.model === "@cf/zai-org/glm-5.3-flash", scrub(JSON.stringify(r.json)));
  const t0 = Date.now();

  do {
    await sleep(2000);
    r = await call("GET", `/v1/monorepos/${t.full}/agents/1`, t.secret);
  } while (r.json?.status === "working" && Date.now() - t0 < 600_000);

  check("the run ends", r.json?.status === "waiting", `${Math.round((Date.now() - t0) / 1000)} s, ${JSON.stringify(r.json)}`);

  const tr = (await call("GET", `/v1/monorepos/${t.full}/agents/1/transcript`, t.secret)).json;
  const usage = { input: 0, cache_read: 0, output: 0, calls: 0 };

  for (const m of tr.messages) {
    if (m.usage) {
      usage.input += m.usage.input;
      usage.cache_read += m.usage.cache_read;
      usage.output += m.usage.output;
      usage.calls += 1;
    }

    for (const p of m.parts) {
      if (p.type === "text" && m.role === "assistant") say(`  model: ${p.text.slice(0, 300)}`);

      if (p.type === "tool-call") say(`  call:  ${p.name} ${p.arguments.slice(0, 200)}`);

      if (p.type === "tool-result") say(`  ${p.error ? "error" : "ok   "}  ${p.text.replace(/\n/g, " | ").slice(0, 200)}`);
    }
  }

  const dollars = ((usage.input - usage.cache_read) * 0.15 + usage.cache_read * 0.03 + usage.output * 0.5) / 1e6;
  say(`  ${usage.calls} model calls; ${usage.input} input tokens (${usage.cache_read} cached), ${usage.output} output; about $${dollars.toFixed(4)}`);

  r = await call("GET", `/v1/monorepos/${t.full}/repos/${t.name}/files/README.md`, t.secret);
  check("main's README is fixed", /receive/.test(r.text) && !/recieve/.test(r.text), r.text);
} finally {
  const r = await call("DELETE", `/v1/monorepos/${t.full}?confirm=${t.full}`, t.secret);
  check(`cleanup: ${t.full} is deleted`, r.status === 204, r.status);
}

done();
