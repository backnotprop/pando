// The Co-authored-by trailers of a commit message, as git reads trailers
// (git interpret-trailers): only the message's last paragraph, and only when
// it is not the title's own paragraph and every line in it is a trailer
// (`Key: value`) or a continuation of one (a line that starts with
// whitespace). A Co-authored-by line in the body is text, not a trailer.
// The profile credits a commit to these emails as well as its author's.

const TRAILER = /^([A-Za-z0-9][A-Za-z0-9-]*)\s*:\s*(.*)$/;

/** The email in a trailer's value: inside angle brackets (however many), else the word with an @. Lower case; null when none. */
function emailOf(value: string): string | null {
  const bracketed = /<+\s*([^<>\s]*)\s*>+/.exec(value);
  const raw = bracketed ? bracketed[1] : value.split(/\s+/).find((w) => w.includes("@"));
  const email = raw?.trim().toLowerCase() ?? "";

  return /^[^@\s]+@[^@\s]+$/.test(email) ? email : null;
}

/** The emails a message's Co-authored-by trailers name, lower case, each once, in order. */
export function coAuthorEmails(message: string): string[] {
  if (!/co-authored-by/i.test(message)) return [];
  const lines = message.replace(/\r\n?/g, "\n").split("\n");

  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  const blank = lines.findLastIndex((l) => l.trim() === "");

  // One paragraph is the title's: git reads no trailers there.
  if (blank < 0) return [];
  const block = lines.slice(blank + 1);
  const trailers: { key: string; value: string }[] = [];

  for (const line of block) {
    const folded = /^\s/.test(line);
    const last = trailers[trailers.length - 1];

    if (folded && last) {
      last.value += ` ${line.trim()}`;
      continue;
    }

    const m = TRAILER.exec(line);

    if (!m) return [];
    trailers.push({ key: m[1].toLowerCase(), value: m[2] });
  }

  const out: string[] = [];

  for (const t of trailers) {
    const email = t.key === "co-authored-by" ? emailOf(t.value) : null;

    if (email && !out.includes(email)) out.push(email);
  }

  return out;
}
