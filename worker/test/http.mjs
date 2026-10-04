// One HTTP call to the Worker under test, for every suite. Each suite keeps
// its own small `call` with the argument order it always had, and goes
// through here.
//
// - A body is sent only when there is one (undefined or null: none), so a GET
//   never carries a body: fetch refuses one.
// - `body` is JSON-encoded; `raw` is sent exactly as given (a signed webhook
//   body must keep its bytes). Either one sets content-type application/json.
// - Authorization is sent only with a secret. Headers given by the caller come
//   last and win.
// - It uses the global fetch at call time, so errors.mjs retryResetFetch()
//   applies.

/** The Response itself. */
export function send(base, method, path, options = {}) {
  const headers = new Headers();
  const init = { method, headers, redirect: options.redirect ?? "follow" };

  if (options.secret) headers.set("authorization", `Bearer ${options.secret}`);

  if (options.raw !== undefined) {
    headers.set("content-type", "application/json");
    init.body = options.raw;
  } else if (options.body !== undefined && options.body !== null) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(options.body);
  }

  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);

  return fetch(base + path, init);
}

/** The answer read: status, the body as text and as JSON (null when it is not JSON), headers, and milliseconds taken. */
export async function request(base, method, path, options = {}) {
  const start = performance.now();
  const res = await send(base, method, path, options);
  const text = await res.text();
  let json = null;

  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  return { status: res.status, json, text, headers: res.headers, ms: performance.now() - start };
}
