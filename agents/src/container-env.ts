// Pi Durable's ExecutionEnv over the session's container: the file system and
// shell its read, write, edit and bash tools use. Each operation is one
// command in the container; files move as raw bytes on stdin and stdout.
// Pi builds an environment for every model call and tool call, so this one
// starts the sandbox only when an operation needs it: a session that never
// runs a sandbox tool never starts a container.

import type { Context } from "@earendil-works/chord";
import {
  ExecutionError,
  FileError,
  err,
  ok,
  type ExecutionEnv,
  type FileErrorCode,
  type FileInfo,
  type FileKind,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLine,
  type TextLineReader,
} from "@earendil-works/pi-durable/env";
import type { Sandbox } from "./sandbox";

interface Ran {
  exitCode: number;
  stdout: Uint8Array;
  stderr: string;
}

const text = new TextDecoder();

/** Maps coreutils' messages to Pi's file error codes. */
function fileCode(stderr: string): FileErrorCode {
  if (/No such file or directory/.test(stderr)) return "not_found";

  if (/Permission denied|Read-only file system/.test(stderr)) return "permission_denied";

  if (/Not a directory/.test(stderr)) return "not_directory";

  if (/Is a directory/.test(stderr)) return "is_directory";

  return "unknown";
}

/** A POSIX path with "." and ".." folded away. */
export function normalize(path: string): string {
  const parts: string[] = [];

  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;

    if (part === "..") parts.pop();
    else parts.push(part);
  }

  return `/${parts.join("/")}`;
}

/** find's %y letter as Pi's file kind. */
function kindOf(letter: string): FileKind {
  if (letter === "d") return "directory";

  if (letter === "l") return "symlink";

  return "file";
}

function bytesOf(content: string | Uint8Array): Uint8Array {
  return content instanceof Uint8Array ? content : new TextEncoder().encode(content);
}

export class ContainerEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;

  constructor(
    private readonly sandbox: Sandbox,
    id: string,
    cwd: string,
  ) {
    this.id = id;
    this.cwd = cwd;
  }

  /** Runs a bash script with arguments ($1, $2 ...), optionally with bytes on stdin. */
  private async run(script: string, args: string[], context: Context, stdin?: Uint8Array): Promise<Ran> {
    await this.sandbox.workspace();
    const options: ContainerExecOptions = { cwd: this.cwd, signal: context.abortSignal };

    if (stdin) options.stdin = "pipe";
    const proc = await this.sandbox.spawn(["bash", "-c", script, "_", ...args], options);

    if (stdin && proc.stdin) {
      const writer = proc.stdin.getWriter();
      await writer.write(stdin);
      await writer.close();
    }

    const out = await proc.output();

    return { exitCode: out.exitCode, stdout: new Uint8Array(out.stdout), stderr: text.decode(out.stderr) };
  }

  private async file<T>(script: string, path: string, context: Context, done: (r: Ran) => T, stdin?: Uint8Array): Promise<Result<T, FileError>> {
    if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted", path));

    try {
      const r = await this.run(script, [path], context, stdin);

      if (r.exitCode !== 0) return err(new FileError(fileCode(r.stderr), r.stderr.trim() || `exit ${r.exitCode}`, path));

      return ok(done(r));
    } catch (error) {
      return err(new FileError("unknown", String(error), path));
    }
  }

  async absolutePath(path: string): Promise<Result<string, FileError>> {
    const home = path === "~" || path.startsWith("~/") ? `/root${path.slice(1)}` : path;

    return ok(normalize(home.startsWith("/") ? home : `${this.cwd}/${home}`));
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    const joined = parts.join("/");

    return ok(joined.startsWith("/") ? normalize(joined) : normalize(joined).slice(1));
  }

  readTextFile(path: string, context: Context) {
    return this.file('cat -- "$1"', path, context, (r) => text.decode(r.stdout));
  }

  async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const content = await this.readTextFile(path, context);

    if (!content.ok) return content;
    const lines = content.value.split("\n");
    const last = lines.length - 1;
    let i = 0;

    return ok({
      async readLine(): Promise<Result<TextLine | undefined, FileError>> {
        if (i > last || (i === last && lines[last] === "")) return ok(undefined);
        const line = { text: lines[i], terminated: i < last };
        i += 1;

        return ok(line);
      },
      async close() {},
    });
  }

  async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    const max = options?.maxLines;
    const script = max === undefined ? 'cat -- "$1"' : `head -n ${Math.max(0, Math.floor(max))} -- "$1"`;

    return this.file(script, path, context, (r) => {
      const lines = text.decode(r.stdout).split("\n");

      if (lines.at(-1) === "") lines.pop();

      return lines;
    });
  }

  readBinaryFile(path: string, context: Context) {
    return this.file('cat -- "$1"', path, context, (r) => r.stdout);
  }

  writeFile(path: string, content: string | Uint8Array, context: Context) {
    return this.file('mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', path, context, () => undefined, bytesOf(content));
  }

  appendFile(path: string, content: string | Uint8Array, context: Context) {
    return this.file('cat >> "$1"', path, context, () => undefined, bytesOf(content));
  }

  truncateFile(path: string, size: number, context: Context) {
    return this.file(`truncate -s ${Math.max(0, Math.floor(size))} -- "$1"`, path, context, () => undefined);
  }

  flushFile(path: string, context: Context) {
    return this.file('sync -- "$1"', path, context, () => undefined);
  }

  async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    const r = await this.run('mv -f -- "$1" "$2"', [sourcePath, destinationPath], context);

    return r.exitCode === 0 ? ok(undefined) : err(new FileError(fileCode(r.stderr), r.stderr.trim(), sourcePath));
  }

  fileInfo(path: string, context: Context) {
    return this.file('find "$1" -maxdepth 0 -printf "%y\\t%s\\t%T@\\n"', path, context, (r): FileInfo => {
      const [kind, size, mtime] = text.decode(r.stdout).trim().split("\t");

      return { name: path.split("/").at(-1) ?? path, path, kind: kindOf(kind), size: Number(size), mtimeMs: Math.round(Number(mtime) * 1000) };
    });
  }

  listDir(path: string, context: Context) {
    const script = '[ -d "$1" ] || { [ -e "$1" ] && echo "$1: Not a directory" >&2 || echo "$1: No such file or directory" >&2; exit 1; }; find "$1" -mindepth 1 -maxdepth 1 -printf "%f\\0%y\\0%s\\0%T@\\0"';

    return this.file(script, path, context, (r) => {
      const fields = text.decode(r.stdout).split("\0");
      const out: FileInfo[] = [];

      for (let i = 0; i + 3 < fields.length; i += 4) {
        const name = fields[i];
        out.push({ name, path: normalize(`${path}/${name}`), kind: kindOf(fields[i + 1]), size: Number(fields[i + 2]), mtimeMs: Math.round(Number(fields[i + 3]) * 1000) });
      }

      return out;
    });
  }

  canonicalPath(path: string, context: Context) {
    return this.file('realpath -e -- "$1"', path, context, (r) => text.decode(r.stdout).trim());
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const r = await this.run('test -e "$1" || test -L "$1"', [path], context);

    return ok(r.exitCode === 0);
  }

  createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) {
    return this.file(options?.recursive ? 'mkdir -p -- "$1"' : 'mkdir -- "$1"', path, context, () => undefined);
  }

  remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context) {
    const flags = `${options?.recursive ? "r" : ""}${options?.force ? "f" : ""}`;

    return this.file(flags ? `rm -${flags} -- "$1"` : 'rm -- "$1"', path, context, () => undefined);
  }

  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.file('mktemp -d "/tmp/${1}XXXXXX"', prefix ?? "pi-", context, (r) => text.decode(r.stdout).trim());
  }

  async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
    const r = await this.run('mktemp "/tmp/${1}XXXXXX${2}"', [options?.prefix ?? "pi-", options?.suffix ?? ""], context);

    return r.exitCode === 0 ? ok(text.decode(r.stdout).trim()) : err(new FileError(fileCode(r.stderr), r.stderr.trim()));
  }

  async cleanup(): Promise<void> {}

  /**
   * Runs a command with bash in the container. Combined stdout and stderr
   * stream to onOutput; the complete output is also written to a file in
   * the container, kept and reported only when it passes the spill limits.
   */
  async exec(command: string, options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    const timeout = options?.timeout;

    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
      return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
    }

    if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
    const spill = `/tmp/pi-output-${crypto.randomUUID()}.log`;
    const bytesLimit = options?.spill?.afterBytes ?? Number.MAX_SAFE_INTEGER;
    const linesLimit = options?.spill?.afterLines ?? Number.MAX_SAFE_INTEGER;

    // Output goes through tee into the spill file. Afterwards the file is
    // removed unless it passed a limit, and "spilled" on stderr says so.
    const script = [
      'bash -c "$1" 2>&1 | tee "$2"',
      "status=${PIPESTATUS[0]}",
      'if [ "$(wc -c < "$2")" -gt "$3" ] || [ "$(wc -l < "$2")" -gt "$4" ]; then echo spilled >&2; else rm -f "$2"; fi',
      'exit "$status"',
    ].join("\n");

    const argv = ["bash", "-c", script, "_", command, spill, String(bytesLimit), String(linesLimit)];
    const timed = timeout === undefined ? argv : ["timeout", "--kill-after=5", String(timeout), ...argv];

    try {
      await this.sandbox.workspace();
      const proc = await this.sandbox.spawn(timed, { cwd: options?.cwd ?? this.cwd, env: options?.env, signal: context.abortSignal, stderr: "pipe" });
      const stderr = proc.stderr ? new Response(proc.stderr).text() : Promise.resolve("");

      if (proc.stdout) {
        const decoder = new TextDecoder();

        const reader = proc.stdout.getReader();

        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          options?.onOutput?.(decoder.decode(chunk.value, { stream: true }), context);
        }

        const rest = decoder.decode();

        if (rest) options?.onOutput?.(rest, context);
      }

      const exitCode = await proc.exitCode;
      const spilled = /spilled/.test(await stderr) ? spill : undefined;

      if (context.abortSignal?.aborted) {
        const e = new ExecutionError("aborted", "Command aborted");
        e.spillPath = spilled;

        return err(e);
      }

      if (timeout !== undefined && (exitCode === 124 || exitCode === 137)) {
        const e = new ExecutionError("timeout", `Command timed out after ${timeout} seconds`);
        e.spillPath = spilled;

        return err(e);
      }

      return ok(spilled ? { exitCode, spillPath: spilled } : { exitCode });
    } catch (error) {
      if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "Command aborted"));

      return err(new ExecutionError("spawn_error", String(error)));
    }
  }
}
