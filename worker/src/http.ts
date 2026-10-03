// Errors and credentials shared by the API and the git door.

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function errorJson(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error: { code, message, ...extra } }, { status });
}

export function toErrorResponse(err: unknown): Response {
  if (err instanceof HttpError) return errorJson(err.status, err.code, err.message, err.extra);
  const message = err instanceof Error ? err.message : String(err);
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
    .replace(/\/\/[^/@\s]+@/g, "//<credentials>@");
}

export function now(): string {
  return new Date().toISOString();
}
