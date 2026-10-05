package session

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"

	_ "modernc.org/sqlite" // pure Go: no cgo for one more database
)

// OpenCode V2 keeps sessions in one SQLite database (session_v2, session_message); V1 has no session_v2 and is not
// read. Its rows change after they are written (an answer streams into its row), so Pando reads rows in seq order and
// stops at the first one not settled yet, the same rule OpenCode uses when it copies a session's settled history.

// OpenDB opens OpenCode's database read-only; ok is false when it is not V2's.
func OpenDB(path string) (*sql.DB, bool, error) {
	db, err := sql.Open("sqlite", "file:"+url.PathEscape(path)+"?mode=ro&_pragma=busy_timeout(2000)")
	if err != nil {
		return nil, false, err
	}
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'").Scan(&n); err != nil {
		db.Close()
		return nil, false, err
	}
	if n == 0 {
		db.Close()
		return nil, false, nil
	}
	return db, true, nil
}

// OpenCodeSession is a session_v2 row, as the first line of the session's first piece carries it.
type OpenCodeSession struct {
	Type        string `json:"type"` // "session"
	ID          string `json:"id"`
	Directory   string `json:"directory"`
	ParentID    string `json:"parent_id,omitempty"`
	Version     string `json:"version"`
	TimeCreated int64  `json:"time_created"`
}

// OpenCodeSessions lists the database's sessions.
func OpenCodeSessions(db *sql.DB) ([]OpenCodeSession, error) {
	rows, err := db.Query("SELECT id, directory, COALESCE(parent_id, ''), version, time_created FROM session_v2")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []OpenCodeSession
	for rows.Next() {
		s := OpenCodeSession{Type: "session"}
		if err := rows.Scan(&s.ID, &s.Directory, &s.ParentID, &s.Version, &s.TimeCreated); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

type messageRow struct {
	ID          string          `json:"id"`
	Type        string          `json:"type"`
	Seq         int64           `json:"seq"`
	TimeCreated int64           `json:"time_created"`
	Data        json.RawMessage `json:"data"`
}

// settled: an answer that has finished, a shell command or compaction not still running.
func settled(r messageRow) bool {
	var d struct {
		Status string `json:"status"`
		Time   struct {
			Completed *json.Number `json:"completed"`
		} `json:"time"`
	}
	if json.Unmarshal(r.Data, &d) != nil {
		return true
	}
	switch r.Type {
	case "assistant":
		return d.Time.Completed != nil
	case "shell", "compaction":
		return d.Status != "running"
	}
	return true
}

// OpenCodePiece reads a session's settled rows after seq `after`, each through line, until about max bytes. The
// cursor is the last seq read; at 0 the session's own row goes first.
func OpenCodePiece(db *sql.DB, s OpenCodeSession, after int64, max int, line func([]byte) ([]byte, bool, error)) (Piece, error) {
	p := Piece{At: after, Next: after}
	var out bytes.Buffer
	emit := func(raw []byte) (bool, error) {
		kept, keep, err := line(raw)
		if err != nil || !keep {
			return true, err
		}
		if len(kept)+1 > max {
			kept = tooLong(len(kept))
		}
		if out.Len()+len(kept)+1 > max {
			return false, nil
		}
		out.Write(kept)
		out.WriteByte('\n')
		return true, nil
	}
	if after == 0 {
		head, _ := json.Marshal(s)
		if _, err := emit(head); err != nil {
			return Piece{At: after, Next: after}, err
		}
	}
	rows, err := db.Query("SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT 5000", s.ID, after)
	if err != nil {
		return p, err
	}
	defer rows.Close()
	for rows.Next() {
		var r messageRow
		var data string
		if err := rows.Scan(&r.ID, &r.Type, &r.Seq, &r.TimeCreated, &data); err != nil {
			return p, err
		}
		r.Data = json.RawMessage(data)
		if !settled(r) {
			break
		}
		raw, err := json.Marshal(r)
		if err != nil {
			return p, fmt.Errorf("opencode row %s: %w", r.ID, err)
		}
		more, err := emit(raw)
		if err != nil {
			return Piece{At: after, Next: after}, err
		}
		if !more {
			break
		}
		p.Next = r.Seq
	}
	p.Lines = out.Bytes()
	return p, rows.Err()
}
