package session

import "strings"

// What leaves the machine of an agent's records (pando-ops, 2026-10-06): the conversation only, by record type, before
// the secret check. An agent also writes its own bookkeeping into a session (Claude Code the signed-in email, the
// system prompt and the skills list; Codex its instructions, the person's AGENTS.md and the account's ids), which is not
// the conversation and stays home. Each list holds what trajectory draws, what Pando's pass reads (a model, an image,
// a Codex subagent's task and parent) and the folder. A record kind an agent adds later stays home until it is listed.
// The user docs' "What is sent" says the same.
var sent = map[string]map[string]bool{
	// Claude Code: prompts, tool results and images ride in user records; answers and tool calls in assistant ones.
	ClaudeCode: {"user": true, "assistant": true},
	// Codex: its thread's own line and each turn's model, cut to what is read (codexKept), and the response items.
	Codex: {"session_meta": true, "turn_context": true, "response_item": true},
	// Pi: its header (id and folder), messages, and model changes.
	Pi: {"session": true, "message": true, "model_change": true},
	// OpenCode V2 rows as the machine sends them: the session's own line (opencode.go picks its columns), then
	// prompts, answers with their tool calls, and shell runs.
	OpenCode: {"session": true, "user": true, "assistant": true, "shell": true},
}

// codexKept: the fields kept of a Codex thread's own line and of a turn's line.
var codexKept = map[string][]string{
	"session_meta": {"id", "timestamp", "cwd", "cli_version", "source", "parent_thread_id", "git"},
	"turn_context": {"turn_id", "cwd", "model"},
}

// codexContext: text Codex adds to a turn as the person's (its environment, the instructions), not typed by them.
var codexContext = []string{"<environment_context>", "<user_instructions>", "# AGENTS.md instructions", "<INSTRUCTIONS>"}

// conversation returns the part of one record that may leave the machine; keep is false for a record that stays home.
func conversation(program string, top map[string]any) (map[string]any, bool) {
	kind, _ := top["type"].(string)
	if !sent[program][kind] {
		return nil, false
	}
	if program != Codex {
		return top, true
	}
	payload, _ := top["payload"].(map[string]any)
	if fields, ok := codexKept[kind]; ok {
		top["payload"] = only(payload, fields)
		if git, ok := payload["git"].(map[string]any); ok && kind == "session_meta" {
			top["payload"].(map[string]any)["git"] = only(git, []string{"branch"})
		}
		return top, true
	}
	if typeOf(payload) != "message" {
		return top, true
	}
	if role, _ := payload["role"].(string); role != "user" && role != "assistant" {
		return nil, false
	}
	blocks, _ := payload["content"].([]any)
	kept := blocks[:0]
	for _, b := range blocks {
		if text, _ := b.(map[string]any)["text"].(string); !isCodexContext(text) {
			kept = append(kept, b)
		}
	}
	if len(kept) == 0 {
		return nil, false
	}
	payload["content"] = kept
	return top, true
}

func only(m map[string]any, keys []string) map[string]any {
	out := map[string]any{}
	for _, k := range keys {
		if v, ok := m[k]; ok {
			out[k] = v
		}
	}
	return out
}

func isCodexContext(text string) bool {
	t := strings.TrimSpace(text)
	for _, p := range codexContext {
		if strings.HasPrefix(t, p) {
			return true
		}
	}
	return false
}
