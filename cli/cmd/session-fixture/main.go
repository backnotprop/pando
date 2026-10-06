// session-fixture makes a committed test fixture from an agent's own session file: every line goes through what
// `pando sync` sends (session.Trim: the conversation's records only, the secret check, the trims), then the scratch
// folder it ran in is replaced by a placeholder. No hand edits.
//
//	go run ./cmd/session-fixture <program> <session file> <scratch folder> > ../worker/test/sessions/fixtures/<program>.jsonl
package main

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"strings"

	"pando/internal/session"
)

// Placeholder stands for the folder a fixture ran in.
const Placeholder = "/fixture/repo"

func main() {
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, "usage: session-fixture <program> <session file> <scratch folder>")
		os.Exit(2)
	}
	if err := run(os.Args[1], os.Args[2], os.Args[3]); err != nil {
		fmt.Fprintln(os.Stderr, "session-fixture:", err)
		os.Exit(1)
	}
}

func run(program, file, scratch string) error {
	r, err := session.NewRedactor("", nil)
	if err != nil {
		return err
	}
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer f.Close()
	// macOS writes /tmp as /private/tmp in some places: both forms go.
	folders := []string{"/private" + strings.TrimPrefix(scratch, "/private"), strings.TrimPrefix(scratch, "/private")}
	out := bufio.NewWriter(os.Stdout)
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1<<20), session.PieceMax)
	for sc.Scan() {
		kept, keep, err := session.Trim(program, sc.Bytes(), r.Redact)
		if err != nil {
			return err
		}
		if !keep {
			continue
		}
		for _, d := range folders {
			kept = bytes.ReplaceAll(kept, []byte(d), []byte(Placeholder))
		}
		out.Write(kept)
		out.WriteByte('\n')
	}
	if err := sc.Err(); err != nil {
		return err
	}
	return out.Flush()
}
