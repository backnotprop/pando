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
	Dir      string             `toml:"-"`
	Server   string             `toml:"server"`
	Machine  string             `toml:"machine,omitempty"`
	Accounts map[string]Account `toml:"accounts,omitempty"`
}

// Account is who this machine is signed in as on one server host. The
// secret credential is kept apart, in ~/.pando/credentials/<host>.
type Account struct {
	Name  string `toml:"name"`
	Email string `toml:"email,omitempty"`
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

// Save writes ~/.pando/config.toml (never a secret).
func (h *Home) Save() error {
	if err := os.MkdirAll(h.Dir, 0o700); err != nil {
		return err
	}
	out := *h
	if out.Machine == defaultMachine() || os.Getenv("PANDO_MACHINE") != "" {
		out.Machine = ""
	}
	var b strings.Builder
	b.WriteString("# Pando on this machine (docs/contracts/formats.md, section 7). No secrets here.\n")
	if err := toml.NewEncoder(&b).Encode(out); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(h.Dir, "config.toml"), []byte(b.String()), 0o644)
}

// Host is the host part of a server URL ("file" for file:// servers).
func Host(server string) string {
	if strings.HasPrefix(server, "file://") {
		return "file"
	}
	if u, err := url.Parse(server); err == nil && u.Host != "" {
		return u.Host
	}
	return strings.NewReplacer("/", "_", ":", "_").Replace(server)
}

func safeHost(server string) string { return strings.NewReplacer("/", "_", ":", "_").Replace(Host(server)) }

// CredentialPath is ~/.pando/credentials/<host>: this machine's credential
// for one server, mode 600.
func (h *Home) CredentialPath(server string) string {
	return filepath.Join(h.Dir, "credentials", safeHost(server))
}

// Account returns who this machine is signed in as on a server.
func (h *Home) Account(server string) (Account, bool) {
	a, ok := h.Accounts[Host(server)]
	return a, ok
}

// SaveCredential stores the machine credential for a server (mode 600, in
// a folder of mode 700) and who it signs in as.
func (h *Home) SaveCredential(server, credential string, acct Account) error {
	p := h.CredentialPath(server)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, []byte(credential+"\n"), 0o600); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, p); err != nil {
		return err
	}
	if h.Accounts == nil {
		h.Accounts = map[string]Account{}
	}
	h.Accounts[Host(server)] = acct
	return h.Save()
}

// Logout deletes the machine credential for a server.
func (h *Home) Logout(server string) (bool, error) {
	removed := false
	if err := os.Remove(h.CredentialPath(server)); err == nil {
		removed = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if legacy := filepath.Join(h.Dir, "tokens", safeHost(server)); dirExists(legacy) {
		if err := os.RemoveAll(legacy); err != nil {
			return removed, err
		}
		removed = true
	}
	if _, ok := h.Accounts[Host(server)]; ok {
		delete(h.Accounts, Host(server))
		return true, h.Save()
	}
	return removed, nil
}

func dirExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

// ErrNoToken means this machine is not signed in to a server.
var ErrNoToken = errors.New("this machine is not signed in: run `pando login` (or set PANDO_TOKEN)")

// Token returns the credential to use against a server, for a monorepo.
// Order: PANDO_TOKEN; a monorepo token from the first API version,
// ~/.pando/tokens/<host>/<monorepo>; the machine credential
// ~/.pando/credentials/<host> (pando login). It is never printed or logged.
func (h *Home) Token(server, mono string) (string, error) {
	if v := os.Getenv("PANDO_TOKEN"); v != "" {
		return strings.TrimSpace(v), nil
	}
	var paths []string
	if mono != "" {
		paths = append(paths, filepath.Join(h.Dir, "tokens", safeHost(server), mono))
	}
	paths = append(paths, h.CredentialPath(server))
	for _, p := range paths {
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
	p := filepath.Join(h.Dir, "tokens", safeHost(server), mono)
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
