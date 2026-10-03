// Git's pkt-line framing, as much as the door needs: read a receive-pack
// command list without buffering the pack, write a refusal git understands,
// read receive-pack's report, and read a ref advertisement.

import { HttpError } from "../http";

const enc = new TextEncoder();

const dec = new TextDecoder();

export const FLUSH = enc.encode("0000");

const MAX_COMMAND_SECTION = 1 << 20;

export interface RefCommand {
  old: string;
  new: string;
  ref: string;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;

  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;

  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }

  return out;
}

export function pkt(data: string | Uint8Array): Uint8Array {
  const body = data instanceof Uint8Array ? data : enc.encode(data);
  const len = (body.length + 4).toString(16).padStart(4, "0");

  return concat([enc.encode(len), body]);
}

/** Split bytes into pkt-lines. `null` is a flush (or delim) packet. */
export function* pktLines(buf: Uint8Array): Generator<Uint8Array | null> {
  let pos = 0;

  while (pos + 4 <= buf.length) {
    const len = parseInt(dec.decode(buf.subarray(pos, pos + 4)), 16);

    if (Number.isNaN(len)) return;

    if (len < 4) {
      pos += 4;
      yield null;
      continue;
    }

    if (pos + len > buf.length) return;
    yield buf.subarray(pos + 4, pos + len);
    pos += len;
  }
}

export interface CommandSection {
  commands: RefCommand[];
  caps: Set<string>;
  /** Every byte read so far: the command section and the start of the pack. */
  head: Uint8Array;
  /** The rest of the request body. */
  rest: ReadableStreamDefaultReader<Uint8Array>;
}

/**
 * Read receive-pack's command list (and push options) from the request body.
 * Reads only as far as the end of that section; the pack stays in the stream.
 */
export async function readCommandSection(body: ReadableStream<Uint8Array>): Promise<CommandSection> {
  const reader = body.getReader();
  let buf: Uint8Array = new Uint8Array(0);
  let pos = 0;
  const commands: RefCommand[] = [];
  let caps = new Set<string>();
  let phase: "commands" | "options" | "done" = "commands";

  const need = async (n: number) => {
    while (buf.length - pos < n) {
      const { done, value } = await reader.read();

      if (done) throw new HttpError(400, "bad_request", "the push ended inside its command list");
      buf = concat([buf, value]);

      if (buf.length > MAX_COMMAND_SECTION) throw new HttpError(400, "bad_request", "the push command list is too long");
    }
  };

  while (phase !== "done") {
    await need(4);
    const len = parseInt(dec.decode(buf.subarray(pos, pos + 4)), 16);

    if (Number.isNaN(len) || (len > 0 && len < 4)) throw new HttpError(400, "bad_request", "not a receive-pack request");

    if (len === 0) {
      pos += 4;
      phase = phase === "commands" && caps.has("push-options") ? "options" : "done";
      continue;
    }

    await need(len);
    const line = dec.decode(buf.subarray(pos + 4, pos + len)).replace(/\n$/, "");
    pos += len;

    if (phase !== "commands") continue; // push options: not used

    if (line.startsWith("shallow ")) continue;

    if (line.startsWith("push-cert")) throw new HttpError(400, "push_cert_unsupported", "signed pushes are not supported");
    const nul = line.indexOf("\0");
    const cmd = nul >= 0 ? line.slice(0, nul) : line;

    if (nul >= 0) caps = new Set(line.slice(nul + 1).trim().split(" ").filter(Boolean));
    const [oldSha, newSha, ref] = cmd.split(" ");

    if (!oldSha || !newSha || !ref) throw new HttpError(400, "bad_request", "bad receive-pack command");
    commands.push({ old: oldSha, new: newSha, ref });
  }

  return { commands, caps, head: buf, rest: reader };
}

/** A stream that yields `first`, then the rest of `reader`. */
export function prepend(first: Uint8Array, reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  let sentFirst = first.length === 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentFirst) {
        sentFirst = true;
        controller.enqueue(first);

        return;
      }

      const { done, value } = await reader.read();

      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  for (;;) {
    const { done } = await reader.read();

    if (done) return;
  }
}

function sideband(caps: Set<string>): number {
  if (caps.has("side-band-64k")) return 65515;

  if (caps.has("side-band")) return 999;

  return 0;
}

/**
 * The response to a refused push: `unpack ok`, then `ng <ref> <reason>` for
 * every command, so git prints `! [remote rejected] <ref> (<reason>)`.
 */
export function refusal(commands: RefCommand[], reasons: Map<string, string>, caps: Set<string>, message: string): Uint8Array {
  const report: Uint8Array[] = [pkt("unpack ok\n")];

  for (const c of commands) {
    const reason = reasons.get(c.ref) ?? "refused with the rest of this push";
    report.push(pkt(`ng ${c.ref} ${reason}\n`));
  }

  report.push(FLUSH);
  const reportBytes = concat(report);
  const max = sideband(caps);

  if (!max) return reportBytes;
  const out: Uint8Array[] = [];

  if (message) out.push(pkt(concat([Uint8Array.of(2), enc.encode(message.endsWith("\n") ? message : message + "\n")])));

  for (let i = 0; i < reportBytes.length; i += max) {
    out.push(pkt(concat([Uint8Array.of(1), reportBytes.subarray(i, i + max)])));
  }

  out.push(FLUSH);

  return concat(out);
}

export interface PushReport {
  /** An `ERR <message>` pkt-line instead of a report (for example artifacts_git_receive_pack_busy). */
  error: string | null;
  unpack: string | null;
  /** ref -> null when updated, else the reason it was refused. */
  refs: Map<string, string | null>;
}

/** Read receive-pack's report-status (demultiplexing side-band if used). */
export function parseReport(bytes: Uint8Array, caps: Set<string>): PushReport {
  let data = bytes;
  const first = pktLines(bytes).next().value;

  if (first) {
    const t = dec.decode(first).replace(/\n$/, "");

    if (t.startsWith("ERR ")) return { error: t.slice(4), unpack: null, refs: new Map() };
  }

  if (sideband(caps)) {
    const band1: Uint8Array[] = [];

    for (const line of pktLines(bytes)) {
      if (line && line.length > 0 && line[0] === 1) band1.push(line.subarray(1));
    }

    data = concat(band1);
  }

  const report: PushReport = { error: null, unpack: null, refs: new Map() };

  for (const line of pktLines(data)) {
    if (!line) continue;
    const text = dec.decode(line).replace(/\n$/, "");

    if (text.startsWith("unpack ")) report.unpack = text.slice(7);
    else if (text.startsWith("ok ")) report.refs.set(text.slice(3), null);
    else if (text.startsWith("ng ")) {
      const rest = text.slice(3);
      const sp = rest.indexOf(" ");
      report.refs.set(sp >= 0 ? rest.slice(0, sp) : rest, sp >= 0 ? rest.slice(sp + 1) : "refused");
    }
  }

  return report;
}

/** Refs from a smart HTTP v0 advertisement (`info/refs?service=...`). */
export function parseAdvertisement(bytes: Uint8Array): Map<string, string> {
  const refs = new Map<string, string>();
  let section = 0;
  let first = true;

  for (const line of pktLines(bytes)) {
    if (line === null) {
      section++;
      continue;
    }

    const text = dec.decode(line).replace(/\n$/, "");

    if (first && text.startsWith("# service=")) {
      first = false;
      continue;
    }

    first = false;
    const nul = text.indexOf("\0");
    const entry = nul >= 0 ? text.slice(0, nul) : text;
    const sp = entry.indexOf(" ");

    if (sp < 0) continue;
    const sha = entry.slice(0, sp);
    const ref = entry.slice(sp + 1);

    if (ref === "capabilities^{}" || ref.endsWith("^{}")) continue;
    refs.set(ref, sha);
  }

  void section;

  return refs;
}

/** A receive-pack request body: commands and a pack with no objects. */
export async function updateRefsRequest(commands: RefCommand[], caps: string[]): Promise<Uint8Array> {
  const lines = commands.map((c, i) => pkt(`${c.old} ${c.new} ${c.ref}${i === 0 ? "\0" + caps.join(" ") : ""}\n`));
  const parts = [...lines, FLUSH];

  if (commands.some((c) => !/^0{40}$/.test(c.new))) {
    const header = concat([enc.encode("PACK"), Uint8Array.of(0, 0, 0, 2, 0, 0, 0, 0)]);
    const sum = new Uint8Array(await crypto.subtle.digest("SHA-1", header));
    parts.push(header, sum);
  }

  return concat(parts);
}
