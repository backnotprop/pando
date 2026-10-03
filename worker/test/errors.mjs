// What went wrong, for a suite's "no exception" check: the stack plus every
// cause in the chain (Node's fetch says only "fetch failed"; the reason is in
// err.cause). Names an undici keep-alive reset when it sees one: the server
// closed a connection the client reused. Credentials are scrubbed.

const RESET_CODES = new Set(["ECONNRESET", "UND_ERR_SOCKET", "EPIPE", "UND_ERR_CLOSED"]);

export function isConnectionReset(err) {
  for (let e = err, i = 0; e && i < 5; e = e.cause, i++) {
    if (RESET_CODES.has(e.code) || /other side closed|socket hang up/i.test(e.message ?? "")) return true;
  }
  return false;
}

export function describeError(err) {
  const parts = [String(err?.stack ?? err)];
  for (let e = err?.cause, i = 0; e && i < 5; e = e.cause, i++) {
    const bits = [e.code && `code ${e.code}`, e.syscall && `syscall ${e.syscall}`, e.errno !== undefined && `errno ${e.errno}`].filter(Boolean).join(", ");
    parts.push(`cause: ${e.name ?? "Error"}: ${e.message ?? String(e)}${bits ? ` (${bits})` : ""}`);
  }
  if (isConnectionReset(err)) parts.push("(an undici keep-alive reset: the server closed a connection the client reused)");
  return parts.join("\n  ").replace(/pando_[a-f0-9]{20,}/g, "<credential>");
}

/**
 * Retry an idempotent request (GET, HEAD, PUT, DELETE) once when the
 * connection was reset before an answer came back. Other methods are never
 * retried: a POST may have run. Call once at the top of a suite.
 */
export function retryResetFetch() {
  const plain = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    try {
      return await plain(input, init);
    } catch (err) {
      if (!["GET", "HEAD", "PUT", "DELETE"].includes(method) || !isConnectionReset(err)) throw err;
      console.log(`  (retried ${method} once after a connection reset: ${err.cause?.code ?? err.cause?.message ?? err.message})`);
      return plain(input, init);
    }
  };
}
