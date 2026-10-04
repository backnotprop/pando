package meta

import (
	"encoding/json"
	"errors"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The engine's machine-only state lives in <root>/.pando/local/meta/
// (formats.md, section 3: never synced):
//
//	state.json        what this machine last synced, the cursor, the outbox
//	frozen/<path>.json one file per path frozen after a conflict;
//	                   pando resolve <path> deletes it
//	lock              held by the running engine
func stateDir(root string) string { return filepath.Join(root, ".pando", "local", "meta") }

// FileState is what this machine last synced for a path.
type FileState struct {
	Version int64  `json:"v"`
	SHA     string `json:"sha,omitempty"` // "" when the path is deleted
	Oid     string `json:"oid,omitempty"` // a large file's SHA-256: SHA is then its pointer's
	Size    int64  `json:"size,omitempty"`
	Mtime   int64  `json:"mtime,omitempty"` // of the local file, in ns, when synced
}

// Op is a local change waiting in the outbox, with the base version it was
// made on. A save's bytes are read when it is sent, so later edits ride along.
type Op struct {
	Seq    int64  `json:"seq"`
	Kind   string `json:"kind"` // save, delete, rename
	Path   string `json:"path"`
	From   string `json:"from,omitempty"` // rename
	Base   int64  `json:"base"`           // base version of Path (of From, for a rename)
	ToBase int64  `json:"to_base,omitempty"`
	SHA    string `json:"sha,omitempty"` // rename: the bytes moved

	// What a save or delete last sent, kept with the outbox: an answer lost
	// with a dropped socket is known by it when the change comes back in
	// the catch-up (meta-sync.md, "A lost answer"). Empty: never sent.
	SentSHA    string `json:"sent_sha,omitempty"`
	SentDelete bool   `json:"sent_delete,omitempty"`

	// In flight on the current connection (not saved).
	id       string
	sentOid  string
	sentSize int64
	sentMt   int64

	// A large file's upload to R2 (not saved; a restart uploads again, and the
	// server skips bytes it has).
	uploading bool
	uploaded  *uploadResult
	retryAt   time.Time
}

type state struct {
	Version  int                   `json:"version"`
	Monorepo string                `json:"monorepo"`
	Cursor   int64                 `json:"cursor"`
	Files    map[string]*FileState `json:"files"`
	Outbox   map[string]*Op        `json:"outbox"`  // by Path
	Refused  map[string]string     `json:"refused"` // path -> sha the server refused
	// path -> why the server refused it, for pando sync --once's report
	RefusedWhy map[string]string `json:"refused_why,omitempty"`
	NextSeq    int64             `json:"next_seq"`
	TextOnly   bool              `json:"text_only,omitempty"` // pando clone --text-only: large files stay pointers
}

func loadState(root, monorepo string) (*state, error) {
	st := &state{Version: 1, Monorepo: monorepo}
	b, err := os.ReadFile(filepath.Join(stateDir(root), "state.json"))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	if err == nil {
		if err := json.Unmarshal(b, st); err != nil {
			return nil, err
		}
		if st.Monorepo != monorepo {
			// A different monorepo: start over rather than mix versions.
			st = &state{Version: 1, Monorepo: monorepo}
		}
	}
	if st.Files == nil {
		st.Files = map[string]*FileState{}
	}
	if st.Outbox == nil {
		st.Outbox = map[string]*Op{}
	}
	if st.Refused == nil {
		st.Refused = map[string]string{}
	}
	if st.RefusedWhy == nil {
		st.RefusedWhy = map[string]string{}
	}
	return st, nil
}

func (st *state) save(root string) error {
	b, err := json.Marshal(st)
	if err != nil {
		return err
	}
	dir := stateDir(root)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp := filepath.Join(dir, "state.json.tmp")
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, "state.json"))
}

// Frozen paths.

// Frozen describes a path frozen after a lost race.
type Frozen struct {
	Path         string    `json:"path"`
	ConflictCopy string    `json:"conflict_copy,omitempty"`
	Version      int64     `json:"version"` // the version written to the path
	At           time.Time `json:"at"`
}

func frozenDir(root string) string { return filepath.Join(stateDir(root), "frozen") }

func frozenFile(root, rel string) string {
	return filepath.Join(frozenDir(root), url.PathEscape(rel)+".json")
}

func freeze(root string, f Frozen) error {
	if err := os.MkdirAll(frozenDir(root), 0o755); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(f, "", "  ")
	return os.WriteFile(frozenFile(root, f.Path), b, 0o644)
}

// ListFrozen returns every frozen path under root.
func ListFrozen(root string) ([]Frozen, error) {
	entries, err := os.ReadDir(frozenDir(root))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Frozen
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(frozenDir(root), e.Name()))
		if err != nil {
			continue
		}
		var f Frozen
		if json.Unmarshal(b, &f) == nil && f.Path != "" {
			out = append(out, f)
		}
	}
	return out, nil
}

// Unfreeze is pando resolve: the path syncs again. If the file was edited, the
// running engine sends it on its next pass.
func Unfreeze(root, rel string) (bool, error) {
	err := os.Remove(frozenFile(root, rel))
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}
