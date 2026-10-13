// The pages a person sees during an MCP host's sign-in: the consent page ("Connect Claude Code to
// Pando") and the page for a request that cannot go on. Server-rendered, no script, Pando's dark look
// (web/src/theme.css). Every value from the request or the client is escaped.

import { isLoopback, type OAuthClient } from "./clients";

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "private, no-store",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  // form-action is left out on purpose: browsers apply it to the redirect after the submit, which leaves for the app.
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'",
};

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const STYLE = `
:root { color-scheme: dark; }
body { margin: 0; background: #0c0f0c; color: #e6e0d1; font: 14px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif; }
main { max-width: 440px; margin: 12vh auto 0; padding: 0 20px; }
.brand { display: flex; align-items: center; gap: 8px; color: #ada899; font-size: 13px; }
.brand img { width: 18px; height: 18px; }
h1 { font-size: 20px; font-weight: 600; margin: 22px 0 6px; color: #f4efe3; }
.who { color: #ada899; margin: 0 0 18px; }
.box { background: #1a1f18; border: 1px solid #262a24; border-radius: 8px; padding: 14px 16px; margin: 14px 0; }
.box p { margin: 0 0 8px; } .box p:last-child { margin: 0; }
.dim { color: #7e8476; font-size: 12.5px; }
code { font: 12.5px "SF Mono", ui-monospace, Menlo, monospace; color: #e6e0d1; }
.warn { color: #e07a5f; }
form { display: flex; gap: 10px; margin-top: 20px; }
button { font: inherit; font-weight: 500; border-radius: 6px; padding: 8px 18px; cursor: pointer; border: 1px solid #3a4136; background: transparent; color: #e6e0d1; }
button.allow { background: #c4e86f; color: #0c0f0c; border-color: #c4e86f; }
`;

function page(title: string, body: string, status = 200, headers: HeadersInit = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main><div class="brand"><img src="/mark.svg" alt="">Pando</div>${body}</main></body></html>`;
  const h = new Headers(PAGE_HEADERS);

  for (const [k, v] of new Headers(headers)) h.append(k, v);

  return new Response(html, { status, headers: h });
}

/** A request that cannot go on and cannot be sent back to the app (an unknown client, an unproven redirect URI). */
export function problemPage(message: string, status = 400): Response {
  return page("Sign-in stopped", `<h1>This sign-in cannot go on</h1><p class="who">${escapeHtml(message)}</p><p class="dim">Start the connection again from your app.</p>`, status);
}

/** Where the browser goes after Allow, and what that means. */
function destination(uri: string): string {
  const u = new URL(uri);

  if (isLoopback(uri)) {
    const port = u.port ? ` (port ${escapeHtml(u.port)})` : "";

    return `<p>After you answer, your browser goes back to <code>${escapeHtml(u.hostname)}</code>${port}, a program on this computer.</p>
<p class="dim warn">Any program on this computer could have started this. Allow it only if you just connected an app here.</p>`;
  }

  if (u.protocol === "https:") return `<p>After you answer, your browser goes back to <code>${escapeHtml(u.host)}</code>.</p>`;

  return `<p>After you answer, your browser hands the result to the app that opens <code>${escapeHtml(u.protocol)}//</code> links on this computer.</p>`;
}

/** What the consent page shows. */
export interface ConsentView {
  client: OAuthClient;
  login: string;
  person: string | null;
  redirectUri: string;
  consentId: string;
}

/** "Connect <client> to Pando": who asks, how sure Pando is of the name, who signs in, what it may do, where the answer goes. */
export function consentPage(v: ConsentView, setCookie: string): Response {
  const name = escapeHtml(v.client.name);
  const origin = v.client.kind === "cimd" ? `Name verified by <code>${escapeHtml(new URL(v.client.id).host)}</code>.` : "Name given by the app itself, not verified.";
  const person = v.person ? `${escapeHtml(v.person)} (${escapeHtml(v.login)})` : escapeHtml(v.login);

  const body = `<h1>Connect ${name} to Pando</h1>
<p class="who">Signed in as ${person}</p>
<div class="box">
<p><b>${name}</b> asks to act as you. ${origin}</p>
<p>It can do what you can in every repository you can open: read code, branches, checks and sessions, open and comment on issues, comment on artifacts, merge branches and launch agents.</p>
</div>
<div class="box">${destination(v.redirectUri)}</div>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="consent" value="${escapeHtml(v.consentId)}">
<button class="allow" type="submit" name="decision" value="allow">Allow</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>
<p class="dim">It shows in Settings, Your machines, as ${name}. Revoke it there to disconnect it.</p>`;

  return page(`Connect ${v.client.name} to Pando`, body, 200, { "set-cookie": setCookie });
}
