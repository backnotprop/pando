package session

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

// State is how far this machine got, per Pando folder (.pando/local/sessions.json): offsets and ids, never text.
type State struct {
	// Sessions by Pando session id.
	Sessions map[string]*Tail `json:"sessions"`
	// Skip: session files whose folder is outside this Pando folder; never opened again.
	Skip map[string]bool `json:"skip"`

	path string
}

// Tail is one session's place: its file (or OpenCode's database), the cursor sent up to, and why it stopped.
type Tail struct {
	Program string `json:"program"`
	File    string `json:"file"`
	AgentID string `json:"agent_id"`
	// Offset: the byte offset (the last seq read, for OpenCode) the server's end is at.
	Offset      int64     `json:"offset"`
	Fingerprint string    `json:"fingerprint,omitempty"`
	Sent        time.Time `json:"sent"`
	// Deleted: the session was deleted on the server; nothing more is sent for it.
	Deleted bool `json:"deleted,omitempty"`
	// Rewritten: the agent wrote the file again from the start; its offsets mean nothing now.
	Rewritten bool `json:"rewritten,omitempty"`
}

func statePath(root string) string { return filepath.Join(root, ".pando", "local", "sessions.json") }

// LoadState reads a Pando folder's session state (missing: empty).
func LoadState(root string) (*State, error) {
	s := &State{Sessions: map[string]*Tail{}, Skip: map[string]bool{}, path: statePath(root)}
	b, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, s); err != nil {
		return nil, err
	}
	if s.Sessions == nil {
		s.Sessions = map[string]*Tail{}
	}
	if s.Skip == nil {
		s.Skip = map[string]bool{}
	}
	return s, nil
}

// Save writes the state whole, through a temporary file.
func (s *State) Save() error {
	b, err := json.MarshalIndent(s, "", " ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}
