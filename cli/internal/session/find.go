package session

import (
	"bufio"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Header is what Pando reads of a session file before deciding to record it: whose session it is and where it ran.
// Nothing past these fields is read for a session outside a Pando folder.
type Header struct {
	Program string
	File    string
	AgentID string
	Folder  string
	// ParentAgentID: a Claude Code subagent's session (its file sits under <session>/subagents/).
	ParentAgentID string
}

// headerMax: how far into a file its header may be (Claude Code's first rows can carry no folder).
const headerMax = 64 << 10

// claudeDir is how Claude Code names a folder's project directory: every character not a letter or digit as "-".
func claudeDir(folder string) string {
	return strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			return r
		}
		return '-'
	}, folder)
}

// Files lists a JSONL store's session files that may belong under root. Claude Code's are filtered by their
// project directory's name first, so other projects' files are never opened.
func Files(st Store, roots []string) []string {
	var out []string
	if st.Program == ClaudeCode {
		dirs, _ := os.ReadDir(st.Path)
		for _, d := range dirs {
			if !d.IsDir() || !matchesAny(d.Name(), roots) {
				continue
			}
			dir := filepath.Join(st.Path, d.Name())
			main, _ := filepath.Glob(filepath.Join(dir, "*.jsonl"))
			subs, _ := filepath.Glob(filepath.Join(dir, "*", "subagents", "*.jsonl"))
			out = append(append(out, main...), subs...)
		}
		return out
	}
	_ = filepath.WalkDir(st.Path, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(p, ".jsonl") {
			out = append(out, p)
		}
		return nil
	})
	return out
}

func matchesAny(dirName string, roots []string) bool {
	for _, r := range roots {
		if strings.HasPrefix(dirName, claudeDir(r)) {
			return true
		}
	}
	return false
}

// ReadHeader reads a session file's header; ok is false while it is not written yet.
func ReadHeader(program, path string) (Header, bool) {
	h := Header{Program: program, File: path}
	f, err := os.Open(path)
	if err != nil {
		return h, false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), headerMax)
	read := 0
	for sc.Scan() && read < headerMax {
		read += len(sc.Bytes()) + 1
		var row struct {
			Type      string `json:"type"`
			ID        string `json:"id"`
			Cwd       string `json:"cwd"`
			SessionID string `json:"sessionId"`
			AgentID   string `json:"agentId"`
			Payload   struct {
				ID  string `json:"id"`
				Cwd string `json:"cwd"`
			} `json:"payload"`
		}
		if json.Unmarshal(sc.Bytes(), &row) != nil {
			continue
		}
		switch program {
		case ClaudeCode:
			if row.Cwd == "" || row.SessionID == "" {
				continue
			}
			h.Folder, h.AgentID = row.Cwd, row.SessionID
			if filepath.Base(filepath.Dir(path)) == "subagents" {
				h.ParentAgentID = row.SessionID
				h.AgentID = row.AgentID
				if h.AgentID == "" {
					h.AgentID = strings.TrimPrefix(strings.TrimSuffix(filepath.Base(path), ".jsonl"), "agent-")
				}
			}
			return h, true
		case Codex:
			if row.Type == "session_meta" && row.Payload.ID != "" && row.Payload.Cwd != "" {
				h.AgentID, h.Folder = row.Payload.ID, row.Payload.Cwd
				return h, true
			}
			return h, false
		case Pi:
			if row.Type == "session" && row.ID != "" && row.Cwd != "" {
				h.AgentID, h.Folder = row.ID, row.Cwd
				return h, true
			}
			return h, false
		}
	}
	return h, false
}

// Inside reports whether folder is root or inside it, symbolic links resolved (/tmp is /private/tmp on a Mac).
func Inside(folder, root string) bool {
	for _, f := range []string{folder, real(folder)} {
		for _, r := range []string{root, real(root)} {
			if rel, err := filepath.Rel(r, f); err == nil && rel != ".." && !strings.HasPrefix(rel, "../") {
				return true
			}
		}
	}
	return false
}

func real(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	return p
}
