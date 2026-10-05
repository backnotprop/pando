// A session's transcript as plain messages: Pi's entries folded into what a
// person reads (who said it, its text, the tool calls and their results).
// Adapted from Cloudflare's Pi harness example (examples/next/harnesses/pi).

import type { AssistantMessage, ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";

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
}

/** The text of a user message's or a tool result's content. */
export function contentText(content: string | (TextContent | ImageContent)[]): string {
  if (!Array.isArray(content)) return content;

  return content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
}

function assistantParts(content: AssistantMessage["content"]): Part[] {
  return content.map((part): Part => {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "thinking":
        return { type: "thinking", text: part.thinking };
      case "toolCall":
        return { type: "tool-call", id: part.id, name: part.name, arguments: JSON.stringify(part.arguments) };
    }
  });
}

function project(message: Message, id: string): TranscriptMessage | undefined {
  switch (message.role) {
    case "user":
      return { id, role: "user", parts: [{ type: "text", text: contentText(message.content) }], at: message.timestamp };
    case "assistant": {
      const m: TranscriptMessage = { id, role: "assistant", parts: assistantParts(message.content), at: message.timestamp, stop_reason: message.stopReason };

      if (message.errorMessage !== undefined) m.error = message.errorMessage;

      return m;
    }

    case "toolResult":
      return {
        id,
        role: "tool",
        parts: [{ type: "tool-result", id: message.toolCallId, name: message.toolName, text: contentText(message.content), error: message.isError }],
        at: message.timestamp,
      };
    default:
      // Pi records prompt changes as system entries; nobody reads them.
      return undefined;
  }
}

export function projectEntries(entries: readonly EntryRecord[]): TranscriptMessage[] {
  return entries.flatMap((entry) => {
    const message = entry.model?.[0];

    if (!message || entry.kind === "pi.system") return [];
    const m = project(message, String(entry.id));

    return m ? [m] : [];
  });
}
