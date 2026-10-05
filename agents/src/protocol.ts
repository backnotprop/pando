// The calls between Pando's Worker and pando-agents, both ways, over service
// bindings. Types and one constant, no imports: Pando's Worker imports this file too.
//
//   Pando's Worker  -> pando-agents  AgentsApi entrypoint (AgentsRpc)
//   pando-agents    -> Pando's Worker AgentReports entrypoint (ReportsRpc)

/** The model a session uses unless it names another: GLM-5.3 Flash on Workers AI (the owner's choice, 2026-10-04). */
export const DEFAULT_MODEL = "@cf/zai-org/glm-5.3-flash";

/** What started the session: a person's prompt, an issue, a branch to review, or the assistant's chat. */
export type SessionKind = "task" | "issue" | "review" | "chat";

/** What can be known exactly about a session at a moment. */
export type Status = "working" | "waiting" | "failed" | "stopped";

export interface SessionSpec {
  /** The session's number in its repository (#3). */
  number: number;
  kind: SessionKind;
  monorepo: { id: string; full: string; kind: "repo" | "monorepo" };
  /** The project the agent works in: its name and folder ("." in a plain repository). */
  repo: { name: string; path: string };
  /** The branch it works on; "" for a chat until the person names one (start_branch). */
  branch: string;
  /** The model's id, such as @cf/zai-org/glm-5.3-flash. */
  model: string;
  /** The person who launched it. The agent acts as them. */
  launcher: { login: string; name: string; email: string };
  /** The sandbox credential minted for this session; its name is the session's machine (cloud-3). */
  credential: { id: string; name: string; secret: string };
  /** The issue it addresses, when it was started from one. */
  issue: number | null;
}

export interface SessionState {
  number: number;
  status: Status;
  /** Why it failed, in Pi's words, or what stopped it. */
  reason?: string;
  model: string;
  branch: string;
  repo: string;
  /** How the sandbox holds the branch, once it has started: mount (pando and ArtifactFS) or clone. */
  workspace?: "mount" | "clone";
  sandbox: "running" | "stopped";
  updated_at: string;
}

export type Part =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  /** arguments: the call's JSON, as the model wrote it. */
  | { type: "tool-call"; id: string; name: string; arguments: string }
  | { type: "tool-result"; id: string; name: string; text: string; error: boolean };

export interface TranscriptMessage {
  /** Pi's entry id. */
  id: string;
  role: "user" | "assistant" | "tool";
  parts: Part[];
  /** Unix milliseconds, as Pi recorded it. */
  at: number;
  stop_reason?: string;
  error?: string;
  /** An answer's tokens, as the model's provider counted them: input (cache reads included), cache reads, output. */
  usage?: { input: number; cache_read: number; output: number };
}

/**
 * The live view's frames (GET .../agents/{n}/live): the transcript from
 * message `from` on. The first frame starts at 0; later ones append.
 */
export type LiveFrame = { type: "messages"; from: number; messages: TranscriptMessage[] };

export interface AgentsRpc {
  /** Starts the session with its first prompt; starting it again changes nothing. */
  start(spec: SessionSpec, prompt: string): Promise<SessionState>;
  /** A follow-up; it waits for the current run when one is going. */
  send(monorepoId: string, number: number, prompt: string): Promise<SessionState>;
  /** Aborts the run and stops the sandbox; the transcript stays. */
  stop(monorepoId: string, number: number, reason: string): Promise<SessionState>;
  state(monorepoId: string, number: number): Promise<SessionState>;
  transcript(monorepoId: string, number: number): Promise<TranscriptMessage[]>;
  /** The models a session may use here, by id and name. */
  models(): ModelInfo[];
}

export interface ModelInfo {
  id: string;
  name: string;
}

export interface ReportsRpc {
  /** A session's state changed. Older reports than the one kept are ignored. */
  report(monorepoId: string, state: SessionState): Promise<void>;
}
