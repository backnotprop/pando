package meta

import (
	"errors"
	"io"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"

	"pando/internal/config"
)

// Config is what the engine needs to sync one meta layer.
type Config struct {
	Root     string // the monorepo root: the meta layer
	Server   string // https://pando-dev.<subdomain>.workers.dev
	Monorepo string
	Token    string // a Pando token; never printed or logged

	Author  string // "Name <email>"
	Machine string
	Agent   string // PANDO_AGENT, optional

	Poll        time.Duration   // the shortest gap between scans (default 500 ms; longer on big trees)
	MaxHold     time.Duration   // a file still changing is sent after this (default 5 min)
	Backoff     []time.Duration // reconnect waits (default 5, 10, 30, 60 s)
	PingEvery   time.Duration   // default 30 s
	MaxInFlight int             // default 64

	Log *log.Logger
}

func (c *Config) defaults() {
	if c.Poll == 0 {
		c.Poll = 500 * time.Millisecond
	}
	if c.MaxHold == 0 {
		c.MaxHold = 5 * time.Minute
	}
	if len(c.Backoff) == 0 {
		c.Backoff = []time.Duration{5 * time.Second, 10 * time.Second, 30 * time.Second, 60 * time.Second}
	}
	if c.PingEvery == 0 {
		c.PingEvery = 30 * time.Second
	}
	if c.MaxInFlight == 0 {
		c.MaxInFlight = 64
	}
	if c.Log == nil {
		c.Log = log.New(os.Stderr, "pando meta: ", log.LstdFlags)
	}
	if c.Machine == "" {
		c.Machine = defaultMachine()
	}
	if c.Author == "" {
		c.Author = defaultAuthor()
	}
}

func (c *Config) check() error {
	switch {
	case c.Root == "":
		return errors.New("no root")
	case c.Server == "":
		return errors.New("no server: set PANDO_SERVER or run pando clone")
	case c.Monorepo == "":
		return errors.New("no monorepo name: run pando clone, or set PANDO_MONOREPO")
	}
	return nil
}

// LoadConfig reads the cli lane's files through pando/internal/config:
// .pando/local/root.json (the monorepo and its server), ~/.pando/config.toml
// (server, machine; PANDO_SERVER and PANDO_MACHINE win), the credential
// pando login stored (PANDO_TOKEN wins) and the signed-in account as the
// author. PANDO_MONOREPO and PANDO_AUTHOR are overrides for tests.
func LoadConfig(root string) (Config, error) {
	c := Config{Root: root}
	if r, err := config.LoadRoot(root); err == nil {
		if r.Kind == config.KindRepo {
			return c, errors.New("a plain git repo has no meta layer")
		}
		c.Monorepo, c.Server = r.Name, r.Server
	} else if !errors.Is(err, fs.ErrNotExist) {
		return c, err
	}
	home, err := config.LoadHome()
	if err != nil {
		return c, err
	}
	if os.Getenv("PANDO_SERVER") != "" || c.Server == "" {
		c.Server = home.Server
	}
	c.Server = strings.TrimRight(c.Server, "/")
	c.Machine = home.Machine
	if c.Server != "" {
		if tok, err := home.Token(c.Server); err == nil {
			c.Token = tok // never printed or logged
		}
		if acct, ok := home.Account(c.Server); ok {
			name := acct.Name
			if name == "" {
				name = acct.Login
			}
			c.Author = name
			if acct.Email != "" {
				c.Author = name + " <" + acct.Email + ">"
			}
		}
	}
	if v := os.Getenv("PANDO_MONOREPO"); v != "" {
		c.Monorepo = v
	}
	if v := os.Getenv("PANDO_AUTHOR"); v != "" {
		c.Author = v // "Name <email>"; once the Worker checks credentials, the account decides
	}
	c.Agent = os.Getenv("PANDO_AGENT")
	c.defaults()
	return c, nil
}

func defaultMachine() string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		return "unknown"
	}
	return strings.SplitN(h, ".", 2)[0]
}

func defaultAuthor() string {
	get := func(key string) string {
		cmd := exec.Command("git", "-c", "credential.helper=", "config", "--get", key)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1") // never Apple's keychain helper
		out, err := cmd.Output()
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(out))
	}
	name, email := get("user.name"), get("user.email")
	if name == "" {
		name = os.Getenv("USER")
	}
	if email == "" {
		return name
	}
	return name + " <" + email + ">"
}

// quietLogger discards output (tests).
func quietLogger() *log.Logger { return log.New(io.Discard, "", 0) }
