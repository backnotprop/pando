// Package config reads and writes the files in docs/contracts/formats.md:
// ~/.pando/ (this machine), .pando/local/ (this root, this machine) and
// .pando/pando.toml (shared).
package config

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/BurntSushi/toml"
)

// Home is the machine's own config: ~/.pando/ or $PANDO_HOME.
type Home struct {
	Dir     string
	Server  string `toml:"server"`
	Machine string `toml:"machine"`
}

// HomeDir is ~/.pando unless PANDO_HOME says otherwise.
func HomeDir() (string, error) {
	if d := os.Getenv("PANDO_HOME"); d != "" {
		return d, nil
	}
	h, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(h, ".pando"), nil
}

// LoadHome reads ~/.pando/config.toml (missing is fine) and applies the
// PANDO_SERVER and PANDO_MACHINE overrides.
func LoadHome() (*Home, error) {
	dir, err := HomeDir()
	if err != nil {
		return nil, err
	}
	h := &Home{Dir: dir}
	path := filepath.Join(dir, "config.toml")
	if _, err := os.Stat(path); err == nil {
		if _, err := toml.DecodeFile(path, h); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
	}
	if v := os.Getenv("PANDO_SERVER"); v != "" {
		h.Server = v
	}
	if v := os.Getenv("PANDO_MACHINE"); v != "" {
		h.Machine = v
	}
	if h.Machine == "" {
		h.Machine = defaultMachine()
	}
	h.Server = strings.TrimRight(h.Server, "/")
	return h, nil
}

func defaultMachine() string {
	name, err := os.Hostname()
	if err != nil || name == "" {
		return "unknown"
	}
	if i := strings.IndexByte(name, '.'); i > 0 {
		name = name[:i]
	}
	return strings.ToLower(name)
}

// SaveServer writes server (and keeps machine) to ~/.pando/config.toml.
func (h *Home) SaveServer(server string) error {
	if err := os.MkdirAll(h.Dir, 0o700); err != nil {
		return err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "server = %q\n", strings.TrimRight(server, "/"))
	if m := os.Getenv("PANDO_MACHINE"); m == "" && h.Machine != "" && h.Machine != defaultMachine() {
		fmt.Fprintf(&b, "machine = %q\n", h.Machine)
	}
	h.Server = strings.TrimRight(server, "/")
	return os.WriteFile(filepath.Join(h.Dir, "config.toml"), []byte(b.String()), 0o644)
}

// ErrNoToken means no token is set for a monorepo.
var ErrNoToken = errors.New("no Pando token for this monorepo: run `pando login <monorepo>` (or set PANDO_TOKEN)")

// tokenPath is ~/.pando/tokens/<server host>/<monorepo>.
func (h *Home) tokenPath(server, mono string) string {
	host := server
	if u, err := url.Parse(server); err == nil && u.Host != "" {
		host = u.Host
	} else if strings.HasPrefix(server, "file://") {
		host = "file"
	}
	host = strings.NewReplacer("/", "_", ":", "_").Replace(host)
	return filepath.Join(h.Dir, "tokens", host, mono)
}

// Token returns the API token for a monorepo on a server. Tokens are per
// monorepo (api-v1.yaml). Order: PANDO_TOKEN, ~/.pando/tokens/<host>/<mono>,
// ~/.pando/token. The token is never printed or logged by any caller.
func (h *Home) Token(server, mono string) (string, error) {
	if v := os.Getenv("PANDO_TOKEN"); v != "" {
		return strings.TrimSpace(v), nil
	}
	for _, p := range []string{h.tokenPath(server, mono), filepath.Join(h.Dir, "token")} {
		b, err := os.ReadFile(p)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		if t := strings.TrimSpace(string(b)); t != "" {
			return t, nil
		}
	}
	return "", ErrNoToken
}

// ReadToken reads one token from r (a pipe or a terminal with echo off).
func ReadToken(r io.Reader) (string, error) {
	line, err := bufio.NewReader(io.LimitReader(r, 64<<10)).ReadString('\n')
	if err != nil && err != io.EOF {
		return "", err
	}
	t := strings.TrimSpace(line)
	if t == "" {
		return "", errors.New("empty token")
	}
	return t, nil
}

// SaveToken writes a monorepo's token to ~/.pando/tokens/<host>/<mono>,
// mode 600, in folders of mode 700.
func (h *Home) SaveToken(server, mono, token string) error {
	p := h.tokenPath(server, mono)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, []byte(token+"\n"), 0o600); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}
