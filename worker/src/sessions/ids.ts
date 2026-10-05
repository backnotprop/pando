// A session's id: `s_` and 26 Crockford base32 characters, the first 128 bits of
// SHA-256("<program>:<the agent's own id>"). The commit hook and `pando sync` (Go,
// cli/internal/session) compute the same one, so a commit's `Pando-Session` line and
// the uploaded session meet without any agent name going into git.

/** The agents Pando reads, named as trajectory names its sources. */
export const PROGRAMS = ["claude-code", "codex", "pi", "opencode"] as const;

export type Program = (typeof PROGRAMS)[number];

export const SESSION_ID_RE = /^s_[0-9A-HJKMNP-TV-Z]{26}$/;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 16 bytes as 26 base32 characters, most significant first (the top two bits of the first are zero). */
function base32(bytes: Uint8Array): string {
  let n = 0n;

  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";

  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(n & 31n)] + out;
    n >>= 5n;
  }

  return out;
}

export async function sessionIdFor(program: Program, agentId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${program}:${agentId}`)));

  return `s_${base32(digest.slice(0, 16))}`;
}
