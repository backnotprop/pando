// Package session records coding agents' sessions from this machine (docs/sessions-build-notes.md): it finds each
// agent's session store, reads only the new lines of sessions in a Pando folder here, removes secrets, and appends
// them to the session on the server. It keeps how far it got, never session text. The commit hook's Pando-Session
// line comes from here too (Trailer).
package session

import (
	"crypto/sha256"
	"math/big"
)

// The agents Pando reads, named as the server (and letta-ai/trajectory) names them.
const (
	ClaudeCode = "claude-code"
	Codex      = "codex"
	Pi         = "pi"
	OpenCode   = "opencode"
)

// Programs in a fixed order, for listings.
var Programs = []string{ClaudeCode, Codex, Pi, OpenCode}

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// ID is a session's id: "s_" and the first 128 bits of SHA-256("<program>:<agent's own id>") in 26 Crockford
// base32 characters. The Worker (worker/src/sessions/ids.ts) derives the same.
func ID(program, agentID string) string {
	sum := sha256.Sum256([]byte(program + ":" + agentID))
	n := new(big.Int).SetBytes(sum[:16])
	out := make([]byte, 26)
	five := big.NewInt(31)
	for i := 25; i >= 0; i-- {
		out[i] = crockford[new(big.Int).And(n, five).Int64()]
		n.Rsh(n, 5)
	}
	return "s_" + string(out)
}
