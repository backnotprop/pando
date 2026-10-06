package session

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
)

// Piece is what one append sends: whole lines, trimmed and redacted, and where they came from in the agent's file
// (At, the byte offset of the first line; Next, just past the last line read). Next can be past the last line kept:
// lines that were all reasoning or not JSON are read and not sent.
type Piece struct {
	At, Next int64
	Lines    []byte
}

// ReadPiece reads the whole lines of path from offset on, each through line, until about max bytes of output. A last
// line without its newline is not read yet (the agent is still writing it). A line alone over max becomes a short
// marker line. Nothing new: Next == At.
func ReadPiece(path string, offset int64, max int, line func([]byte) ([]byte, bool, error)) (Piece, error) {
	p := Piece{At: offset, Next: offset}
	f, err := os.Open(path)
	if err != nil {
		return p, err
	}
	defer f.Close()
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return p, err
	}
	r := bufio.NewReaderSize(f, 1<<20)
	var out bytes.Buffer
	for {
		raw, err := r.ReadBytes('\n')
		if errors.Is(err, io.EOF) {
			break // a partial last line, or nothing: wait for it
		}
		if err != nil {
			return p, err
		}
		kept, keep, err := line(bytes.TrimSuffix(raw, []byte("\n")))
		if err != nil {
			return Piece{At: offset, Next: offset}, err // redaction could not run: nothing of this piece leaves
		}
		if keep {
			if len(kept)+1 > max {
				kept = tooLong(len(kept))
			}
			if out.Len()+len(kept)+1 > max {
				break // the next piece starts with this line
			}
			out.Write(kept)
			out.WriteByte('\n')
		}
		p.Next += int64(len(raw))
	}
	p.Lines = out.Bytes()
	return p, nil
}

// Fingerprint names a file's beginning: when it changes, the agent wrote the file again from the start (as Codex did
// on 2026-09-24), and the offsets kept for it mean nothing.
func Fingerprint(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	b := make([]byte, 4096)
	n, err := io.ReadFull(f, b)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return "", err
	}
	// Only up to the first newline: the first line never changes once written.
	if i := bytes.IndexByte(b[:n], '\n'); i >= 0 {
		n = i
	}
	sum := sha256.Sum256(b[:n])
	return hex.EncodeToString(sum[:8]), nil
}
