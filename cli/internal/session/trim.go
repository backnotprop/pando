package session

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	// PieceMax is the most bytes of lines one piece carries: the server refuses more (a parse costs about five
	// times its text in a Worker's 128 MB).
	PieceMax = 8_000_000
	// opaqueMin: a string this long with no spaces, all base64 or hex (images, encrypted reasoning, signatures),
	// becomes "[opaque <length>]".
	opaqueMin = 200
	// stringMax: a longer string is cut (a prompt or an answer keeps its first 64 KB).
	stringMax = 64 << 10
)

var (
	opaqueRe  = regexp.MustCompile(`^[A-Za-z0-9+/=_-]+$`)
	dataURLRe = regexp.MustCompile(`^data:[\w.+-]+/[\w.+-]+;base64,`)
)

// reasoning is the agent's reasoning, which is not kept (owner, 2026-10-04): an object of one of these types inside a
// list (Claude Code and Pi thinking blocks, OpenCode reasoning parts), or a line whose payload is one (Codex).
var reasoning = map[string]bool{"thinking": true, "redacted_thinking": true, "reasoning": true, "agent_reasoning": true, "agent_reasoning_raw_content": true}

func typeOf(v any) string {
	if m, ok := v.(map[string]any); ok {
		if t, ok := m["type"].(string); ok {
			return t
		}
	}
	return ""
}

// Trim reads one line of an agent's session and returns what may leave the machine: every string redacted, long
// opaque strings replaced by a marker, strings cut at 64 KB, reasoning dropped. keep is false for a line that is all
// reasoning, or not JSON. An error means redaction could not run: the line, and the piece, stay home.
func Trim(line []byte, redact func(string) (string, error)) (out []byte, keep bool, err error) {
	dec := json.NewDecoder(bytes.NewReader(line))
	dec.UseNumber()
	var v any
	if dec.Decode(&v) != nil {
		return nil, false, nil
	}
	top, _ := v.(map[string]any)
	if reasoning[typeOf(top["payload"])] {
		return nil, false, nil
	}
	v, err = walk(v, redact)
	if err != nil {
		return nil, false, err
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, false, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), true, nil
}

func walk(v any, redact func(string) (string, error)) (any, error) {
	switch x := v.(type) {
	case string:
		if len(x) >= opaqueMin && (dataURLRe.MatchString(x) || (!strings.ContainsAny(x, " \n") && opaqueRe.MatchString(x))) {
			return fmt.Sprintf("[opaque %d]", len(x)), nil
		}
		s, err := redact(x)
		if err != nil {
			return nil, err
		}
		return cut(s, stringMax), nil
	case []any:
		out := x[:0]
		for _, e := range x {
			if reasoning[typeOf(e)] {
				continue
			}
			w, err := walk(e, redact)
			if err != nil {
				return nil, err
			}
			out = append(out, w)
		}
		return out, nil
	case map[string]any:
		for k, e := range x {
			w, err := walk(e, redact)
			if err != nil {
				return nil, err
			}
			x[k] = w
		}
		return x, nil
	}
	return v, nil
}

// cut keeps at most n bytes of s, never splitting a character.
func cut(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// tooLong stands in for a line that alone is over PieceMax after trimming: the server could not take it.
func tooLong(n int) []byte {
	return fmt.Appendf(nil, `{"type":"pando","note":"a line of %d bytes was not kept"}`, n)
}
