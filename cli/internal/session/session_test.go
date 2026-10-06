package session

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pando/internal/config"
)

// The same vectors are in worker/test/units.test.ts: the hook, pando sync and the Worker derive one id.
func TestIDMatchesTheWorker(t *testing.T) {
	for _, c := range []struct{ program, agent, want string }{
		{Codex, "019a0b1c-0000-7000-8000-000000000001", "s_2XDAN0ND9PZ9304DQBZ3FDWHKH"},
		{ClaudeCode, "3f1d2c4b-aaaa-bbbb-cccc-0123456789ab", "s_62XXQZZEZRSF4V9PFXHFN2JBQA"},
	} {
		if got := ID(c.program, c.agent); got != c.want {
			t.Errorf("ID(%s, %s) = %s, want %s", c.program, c.agent, got, c.want)
		}
	}
}

func keepAll(b []byte) ([]byte, bool, error) { return b, true, nil }

func writeFile(t *testing.T, text string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "s.jsonl")
	if err := os.WriteFile(p, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

// The offset protocol: whole lines only, a piece never over its cap, and the next piece starts exactly where this
// one's Next says, so pieces sent in turn add up to the file.
func TestReadPieceOffsets(t *testing.T) {
	p := writeFile(t, "{\"a\":1}\n{\"b\":22}\n{\"c\":3")
	got, err := ReadPiece(p, 0, PieceMax, keepAll)
	if err != nil {
		t.Fatal(err)
	}
	if string(got.Lines) != "{\"a\":1}\n{\"b\":22}\n" || got.At != 0 || got.Next != 17 {
		t.Fatalf("whole lines only, the partial last one waits: %+v %q", got, got.Lines)
	}
	again, _ := ReadPiece(p, got.Next, PieceMax, keepAll)
	if again.Next != again.At || len(again.Lines) != 0 {
		t.Fatalf("nothing new while the last line is partial: %+v", again)
	}
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString("}\n")
	f.Close()
	rest, _ := ReadPiece(p, got.Next, PieceMax, keepAll)
	if string(rest.Lines) != "{\"c\":3}\n" || rest.At != 17 || rest.Next != 25 {
		t.Fatalf("the rest from where the first stopped: %+v %q", rest, rest.Lines)
	}
}

func TestReadPieceCap(t *testing.T) {
	p := writeFile(t, "{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n")
	first, _ := ReadPiece(p, 0, 17, keepAll) // room for two lines of 8
	if string(first.Lines) != "{\"a\":1}\n{\"b\":2}\n" || first.Next != 16 {
		t.Fatalf("stops before the line that would pass the cap: %+v %q", first, first.Lines)
	}
	big := writeFile(t, "{\"x\":\""+strings.Repeat("y", 100)+"\"}\n{\"b\":2}\n")
	one, _ := ReadPiece(big, 0, 80, keepAll)
	if !strings.Contains(string(one.Lines), "was not kept") || !strings.HasSuffix(string(one.Lines), "{\"b\":2}\n") {
		t.Fatalf("a line alone over the cap becomes a marker, and reading goes on: %q", one.Lines)
	}
}

func TestReadPieceDroppedLinesStillMoveOn(t *testing.T) {
	p := writeFile(t, "{\"type\":\"response_item\",\"payload\":{\"type\":\"reasoning\"}}\n")
	got, _ := ReadPiece(p, 0, PieceMax, func(b []byte) ([]byte, bool, error) { return Trim(Codex, b, noRedact) })
	if len(got.Lines) != 0 || got.Next != int64(len("{\"type\":\"response_item\",\"payload\":{\"type\":\"reasoning\"}}\n")) {
		t.Fatalf("a reasoning line is read and not sent; the end still moves: %+v", got)
	}
}

func noRedact(s string) (string, error) { return s, nil }

func TestTrim(t *testing.T) {
	img := "data:image/png;base64," + strings.Repeat("QUJD", 100)
	sig := strings.Repeat("aB3+", 60)
	long := strings.Repeat("é", 40000) // 80,000 bytes
	line := `{"type":"assistant","n":12345678901234567890,"message":{"content":[{"type":"thinking","thinking":"hidden","signature":"` + sig + `"},{"type":"text","text":"shown <b>"},{"type":"image","source":"` + img + `"}],"big":"` + long + `"}}`
	out, keep, err := Trim(ClaudeCode, []byte(line), noRedact)
	if err != nil || !keep {
		t.Fatal(keep, err)
	}
	s := string(out)
	switch {
	case strings.Contains(s, "hidden") || strings.Contains(s, "thinking"):
		t.Error("reasoning is not kept")
	case !strings.Contains(s, "[opaque 422]"):
		t.Error("a data: URL becomes a marker")
	case !strings.Contains(s, "shown <b>"):
		t.Error("text stays, with no HTML escaping")
	case !strings.Contains(s, "12345678901234567890"):
		t.Error("big numbers keep every digit")
	case len(s) > 70000:
		t.Errorf("a string over 64 KB is cut (%d bytes)", len(s))
	}
	if _, keep, _ := Trim(ClaudeCode, []byte("not json"), noRedact); keep {
		t.Error("a line that is not JSON is not sent")
	}
}

// An agent's own ids are kept as written: they pair a tool call with its result. A token anywhere else still goes.
func TestIdsAreNotSecrets(t *testing.T) {
	r, err := NewRedactor("", nil)
	if err != nil {
		t.Fatal(err)
	}
	tok := "toolu_01Xq7RbT9kLmN3pVw2ZcYd8F"
	line := `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"` + tok + `","content":"key ` + tok + `"}]}}`
	out, _, err := Trim(ClaudeCode, []byte(line), r.Redact)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), `"tool_use_id":"`+tok+`"`) || strings.Count(string(out), tok) != 1 {
		t.Errorf("the id stays, the same run in text goes: %s", out)
	}
}

// Only the conversation leaves the machine: each agent's own bookkeeping (the signed-in email, the system prompt, the
// skills, the instructions, account ids) stays home, and so does a record kind not listed.
func TestOnlyTheConversationIsSent(t *testing.T) {
	cases := []struct {
		program, line string
		sent          bool
		has, lost     []string
	}{
		{ClaudeCode, `{"type":"user","cwd":"/w","message":{"role":"user","content":"Placeholder"}}`, true, []string{"Placeholder", `"cwd":"/w"`}, nil},
		{ClaudeCode, `{"type":"assistant","message":{"model":"m","content":[{"type":"text","text":"ok"}]}}`, true, []string{`"model":"m"`}, nil},
		{ClaudeCode, `{"type":"attachment","attachment":{"type":"session_context","context":{"email":"a@b.c"}}}`, false, nil, nil},
		{ClaudeCode, `{"type":"attachment","attachment":{"type":"prompt_snapshot","systemPrompt":["You are"]}}`, false, nil, nil},
		{ClaudeCode, `{"type":"cost-state","totalCostUSD":1}`, false, nil, nil},
		{ClaudeCode, `{"type":"some-new-kind"}`, false, nil, nil},
		{Codex, `{"type":"session_meta","payload":{"id":"t1","cwd":"/w","timestamp":"x","creator_account_id":"acct","base_instructions":{"text":"You are"},"source":{"subagent":{"thread_spawn":{"parent_thread_id":"p1"}}},"git":{"branch":"b","repository_url":"git@x:y"}}}`, true, []string{`"id":"t1"`, `"cwd":"/w"`, `"parent_thread_id":"p1"`, `"branch":"b"`}, []string{"acct", "You are", "repository_url"}},
		{Codex, `{"type":"turn_context","payload":{"turn_id":"u","cwd":"/w","model":"gpt-6","timezone":"Z","workspace_roots":["/Users/x"]}}`, true, []string{`"model":"gpt-6"`}, []string{"timezone", "/Users/x"}},
		{Codex, `{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"skills"}]}}`, false, nil, nil},
		{Codex, `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>
<cwd>/w</cwd>"}]}}`, false, nil, nil},
		{Codex, `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /w"},{"type":"input_text","text":"Placeholder"}]}}`, true, []string{"Placeholder"}, []string{"AGENTS.md"}},
		{Codex, `{"type":"response_item","payload":{"type":"function_call","name":"exec","arguments":"{}"}}`, true, []string{`"name":"exec"`}, nil},
		{Codex, `{"type":"world_state","payload":{"state":{}}}`, false, nil, nil},
		{Codex, `{"type":"event_msg","payload":{"type":"token_count"}}`, false, nil, nil},
		{Pi, `{"type":"session","id":"p","cwd":"/w"}`, true, nil, nil},
		{Pi, `{"type":"thinking_level_change","thinkingLevel":"high"}`, false, nil, nil},
		{OpenCode, `{"type":"assistant","id":"m","seq":2,"data":{}}`, true, nil, nil},
		{OpenCode, `{"type":"idle","id":"m","seq":3,"data":{}}`, false, nil, nil},
	}
	for _, c := range cases {
		out, keep, err := Trim(c.program, []byte(c.line), noRedact)
		if err != nil || keep != c.sent {
			t.Errorf("%s %s: sent %v, want %v (%v)", c.program, c.line[:40], keep, c.sent, err)
			continue
		}
		for _, w := range c.has {
			if !strings.Contains(string(out), w) {
				t.Errorf("%s: %q is kept: %s", c.program, w, out)
			}
		}
		for _, w := range c.lost {
			if strings.Contains(string(out), w) {
				t.Errorf("%s: %q stays home: %s", c.program, w, out)
			}
		}
	}
}

func TestTrailerFor(t *testing.T) {
	env := func(k string) string {
		return map[string]string{"CODEX_THREAD_ID": "t-1", "CLAUDE_CODE_SESSION_ID": "c-1"}[k]
	}
	dir := t.TempDir()
	if got := TrailerFor(dir, env, Codex, true); got != ID(Codex, "t-1") {
		t.Errorf("Codex inside Claude Code: the nearest agent's own variable names it, got %q", got)
	}
	if got := TrailerFor(dir, env, ClaudeCode, true); got != ID(ClaudeCode, "c-1") {
		t.Errorf("Claude Code: %q", got)
	}
	if TrailerFor(dir, env, Pi, true) != "" {
		t.Error("the nearest agent set no variable (Pi's setting turns it off): no line")
	}
	if TrailerFor(dir, env, "", true) != "" {
		t.Error("no agent above the hook (a terminal, an editor that outlived the agent): no line")
	}
	if TrailerFor(dir, env, Codex, false) != "" {
		t.Error("recording off: no line")
	}
	for _, busy := range []string{"rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD"} {
		d := t.TempDir()
		os.Mkdir(filepath.Join(d, busy), 0o755)
		if TrailerFor(d, env, Codex, true) != "" {
			t.Errorf("during %s git replays old commits: no line", busy)
		}
	}
}

func TestAgentOf(t *testing.T) {
	for args, want := range map[string]string{
		"/Users/x/.local/bin/claude --resume":                                         ClaudeCode,
		"node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js":                 ClaudeCode,
		"/opt/homebrew/bin/codex exec hi":                                             Codex,
		"node /x/lib/node_modules/@openai/codex/bin/codex.js":                         Codex,
		"node /x/bin/pi -p hello":                                                     Pi,
		"node /x/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js": Pi,
		"/Users/x/.opencode/bin/opencode run":                                         OpenCode,
		"/bin/zsh -c git commit":                                                      "",
		"node /x/server.js":                                                           "",
		"/usr/bin/git commit -m pi":                                                   "",
		"/bin/sh /tmp/agents/codex exec":                                              Codex,
		"/bin/zsh -c codex":                                                           "",
	} {
		if got := AgentOf(args); got != want {
			t.Errorf("AgentOf(%q) = %q, want %q", args, got, want)
		}
	}
}

func TestRedact(t *testing.T) {
	r, err := NewRedactor("pando_0123456789abcdef0123456789abcdef01234567", nil)
	if err != nil {
		t.Fatal("betterleaks must load:", err)
	}
	for in, gone := range map[string]string{
		"token ghp_" + strings.Repeat("A1b2C3d4", 5) + " here":             "ghp_",
		"export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYzz":    "wJalrXUtnFEMI",
		"git clone https://ana:hunter2hunter2@example.com/r.git":           "hunter2hunter2",
		"the credential is pando_0123456789abcdef0123456789abcdef01234567": "pando_0123",
		"key Zq7Xv2Lp9Rt4Wm8Ks3Hd6Fj1Nb5Gc0Yh":                             "Zq7Xv2Lp9Rt4",
	} {
		out, err := r.Redact(in)
		if err != nil || strings.Contains(out, gone) || !strings.Contains(out, Redacted) {
			t.Errorf("Redact(%q) = %q", in, out)
		}
	}
	for _, keep := range []string{
		"commit 4e1a9c2f0b6d8e3a1c5b7d9f2e4a6c8b0d1f3e5a",
		"id 3f1d2c4b-aaaa-bbbb-cccc-0123456789ab",
		"/Users/ana/pando/projects/web/worktrees/fix-login/src/app.ts",
		"Retry once after a 401 that follows a refresh",
	} {
		if out, _ := r.Redact(keep); out != keep {
			t.Errorf("not a secret, kept as is: %q became %q", keep, out)
		}
	}
}

func TestExcluded(t *testing.T) {
	root := &config.Root{Dir: "/r", Owner: "ana", Name: "mono", ID: "m_1"}
	web := Place{Project: "projects/web"}
	folder := Place{}
	p := func(s string) *string { return &s }
	switch {
	case !Excluded(root, web, []string{"projects/web"}, nil):
		t.Error("the repository's rule ([sessions] exclude) excludes its project")
	case Excluded(root, folder, []string{"projects/web"}, nil):
		t.Error("the repository's own folder is not that project")
	case !Excluded(root, folder, nil, []CachedExclusion{{MonorepoID: "m_1"}}):
		t.Error("the person's whole-repository exclusion covers its folder")
	case !Excluded(root, web, nil, []CachedExclusion{{Monorepo: "ana/mono", Project: p("projects/web")}}):
		t.Error("the person's project exclusion, by name")
	case Excluded(root, web, nil, []CachedExclusion{{MonorepoID: "m_2"}, {MonorepoID: "m_1", Project: p("projects/app")}}):
		t.Error("another repository's, or another project's, exclusion does not apply")
	}
}
