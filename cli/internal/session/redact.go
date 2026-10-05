package session

import (
	"bufio"
	"errors"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/betterleaks/betterleaks/detect"
)

// Redacted is Pando's mark for a removed secret, here and on the server; no agent writes it.
const Redacted = "[pando:redacted]"

// secretName: an environment variable or NAME=value whose name says it holds a secret.
var secretName = regexp.MustCompile(`(?i)(TOKEN|SECRET|PASSWORD|PASSWD|PASS|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH|COOKIE)`)

// Pando's own checks, after betterleaks: URLs with passwords, private key blocks, NAME=value pairs whose name looks
// secret, and long mixed tokens of high entropy.
var (
	urlPassword = regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.-]*://[^\s:/@"']+:)([^\s@/"']+)@`)
	privateKey  = regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`)
	namedValue  = regexp.MustCompile(`(?i)\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Z0-9_]*)(\s*[=:]\s*["']?)([^\s"'` + "`" + `,;]{8,})`)
	tokenRun    = regexp.MustCompile(`[A-Za-z0-9_+=-]{24,}`)
)

var (
	detectorOnce sync.Once
	detector     *detect.Detector
	detectorErr  error
)

// betterleaks' 417 default rules (MIT, by gitleaks' authors), loaded once per process.
func leaks() (*detect.Detector, error) {
	detectorOnce.Do(func() {
		detector, detectorErr = detect.NewDetectorDefaultConfig()
		if detectorErr == nil && detector == nil {
			detectorErr = errors.New("betterleaks: no detector")
		}
	})
	return detector, detectorErr
}

// Redactor removes secrets from strings before they leave the machine. It fails closed: if betterleaks cannot load,
// NewRedactor fails and nothing is sent.
type Redactor struct {
	exact []string // longest first
}

// NewRedactor knows the exact values this machine holds: the Pando credential, every environment variable whose name
// looks secret, and the values in the .env files of the folders given (the repository folder, its worktrees).
func NewRedactor(credential string, envFolders []string) (*Redactor, error) {
	if _, err := leaks(); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	add := func(v string) {
		v = strings.Trim(strings.TrimSpace(v), `"'`)
		// A path (SSH_AUTH_SOCK) is not a secret, and would mark every path under it.
		if len(v) >= 8 && !strings.HasPrefix(v, "/") {
			seen[v] = true
		}
	}
	add(credential)
	for _, kv := range os.Environ() {
		if k, v, ok := strings.Cut(kv, "="); ok && secretName.MatchString(k) {
			add(v)
		}
	}
	for _, dir := range envFolders {
		files, _ := filepath.Glob(filepath.Join(dir, ".env*"))
		dev, _ := filepath.Glob(filepath.Join(dir, ".dev.vars*"))
		for _, f := range append(files, dev...) {
			fh, err := os.Open(f)
			if err != nil {
				continue
			}
			sc := bufio.NewScanner(fh)
			for sc.Scan() {
				if _, v, ok := strings.Cut(sc.Text(), "="); ok && !strings.HasPrefix(strings.TrimSpace(sc.Text()), "#") {
					add(v)
				}
			}
			fh.Close()
		}
	}
	r := &Redactor{}
	for v := range seen {
		r.exact = append(r.exact, v)
	}
	sort.Slice(r.exact, func(i, j int) bool { return len(r.exact[i]) > len(r.exact[j]) })
	return r, nil
}

// Redact replaces every secret in s with the mark.
func (r *Redactor) Redact(s string) (string, error) {
	if len(s) < 8 {
		return s, nil
	}
	for _, v := range r.exact {
		s = strings.ReplaceAll(s, v, Redacted)
	}
	d, err := leaks()
	if err != nil {
		return "", err
	}
	for _, f := range d.DetectString(s) {
		if len(f.Secret) >= 6 {
			s = strings.ReplaceAll(s, f.Secret, Redacted)
		}
	}
	s = privateKey.ReplaceAllString(s, Redacted)
	s = urlPassword.ReplaceAllString(s, "${1}"+Redacted+"@")
	s = namedValue.ReplaceAllString(s, "${1}${2}"+Redacted)
	s = tokenRun.ReplaceAllStringFunc(s, func(t string) string {
		if looksRandom(t) {
			return Redacted
		}
		return t
	})
	return s, nil
}

// looksRandom: upper, lower and digits together, and Shannon entropy above 4.5 bits a character. Hex ids (git shas,
// UUIDs) stay under 4, and paths and words are not one run.
func looksRandom(t string) bool {
	var up, low, dig bool
	counts := map[rune]float64{}
	for _, c := range t {
		up = up || (c >= 'A' && c <= 'Z')
		low = low || (c >= 'a' && c <= 'z')
		dig = dig || (c >= '0' && c <= '9')
		counts[c]++
	}
	if !up || !low || !dig {
		return false
	}
	h, n := 0.0, float64(len(t))
	for _, k := range counts {
		h -= k / n * math.Log2(k/n)
	}
	return h > 4.5
}
