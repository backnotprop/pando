// Errors and credentials shared by the API and the git door.
import type { RefusalExtra } from "./monorepo/types";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: RefusalExtra = {},
  ) {
    super(message);
  }
}

export function errorJson(status: number, code: string, message: string, extra: RefusalExtra = {}): Response {
  return Response.json({ error: { code, message, ...extra } }, { status });
}

export function toErrorResponse(cause: unknown): Response {
  if (cause instanceof HttpError) return errorJson(cause.status, cause.code, cause.message, cause.extra);
  const message = cause instanceof Error ? cause.message : String(cause);
  console.error("internal error:", redact(message));

  return errorJson(500, "internal", redact(message));
}

/** The secret from `Authorization: Bearer x` or Basic `user:x`; null if absent. */
export function credential(req: Request): string | null {
  const h = req.headers.get("authorization");

  if (!h) return null;
  const [scheme, value] = h.split(/\s+/, 2);

  if (!value) return null;

  if (/^bearer$/i.test(scheme)) return value.trim();

  if (/^basic$/i.test(scheme)) {
    try {
      const decoded = atob(value.trim());
      const i = decoded.indexOf(":");

      return i >= 0 ? decoded.slice(i + 1) : null;
    } catch {
      return null;
    }
  }

  return null;
}

/** Never let a token reach a log line or an error body. */
export function redact(s: string): string {
  return s
    .replace(/art_v\d+_[A-Za-z0-9]+(\?expires=\d+)?/g, "<artifacts-token>")
    .replace(/pando_[a-f0-9]{20,}/g, "<pando-token>")
    .replace(/pst1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<status-token>")
    .replace(/\/\/[^/@\s]+@/g, "//<credentials>@");
}

export function now(): string {
  return new Date().toISOString();
}

/** A control character: below U+0020, or U+007F. */
function isControl(code: number): boolean {
  return code < 0x20 || code === 0x7f;
}

/** Whether a string holds a control character. */
export function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (isControl(s.charCodeAt(i))) return true;

  return false;
}

/** The string with its control characters taken out. */
export function withoutControl(s: string): string {
  let out = "";

  for (let i = 0; i < s.length; i++) if (!isControl(s.charCodeAt(i))) out += s[i];

  return out;
}

/** The agent acting, from X-Pando-Agent (optional; agents act as their user). */
export function agentHeader(req: Request): string | null {
  const v = withoutControl(req.headers.get("x-pando-agent") ?? "").trim();

  return v ? v.slice(0, 100) : null;
}
