package meta

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
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

	Poll        time.Duration   // how often the folder is scanned (default 500 ms)
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

// FindRoot walks up from dir to the folder holding .pando/.
func FindRoot(dir string) (string, error) {
	dir, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	for d := dir; ; d = filepath.Dir(d) {
		if info, err := os.Stat(filepath.Join(d, ".pando")); err == nil && info.IsDir() {
			return d, nil
		}
		if filepath.Dir(d) == d {
			return "", fmt.Errorf("%s is not inside a Pando monorepo (no .pando/ above it)", dir)
		}
	}
}

// LoadConfig reads .pando/local/root.json (formats.md, section 3), then
// ~/.pando/config.toml and ~/.pando/token (section 7), then the PANDO_*
// environment, which wins.
func LoadConfig(root string) (Config, error) {
	c := Config{Root: root}
	var rj struct {
		Kind   string `json:"kind"`
		Name   string `json:"name"`
		Server string `json:"server"`
	}
	if b, err := os.ReadFile(filepath.Join(root, ".pando", "local", "root.json")); err == nil {
		if err := json.Unmarshal(b, &rj); err != nil {
			return c, fmt.Errorf(".pando/local/root.json: %w", err)
		}
		if rj.Kind == "repo" {
			return c, errors.New("a plain git repo has no meta layer")
		}
		c.Monorepo, c.Server = rj.Name, rj.Server
	}
	home := os.Getenv("PANDO_HOME")
	if home == "" {
		if h, err := os.UserHomeDir(); err == nil {
			home = filepath.Join(h, ".pando")
		}
	}
	if home != "" {
		var mc struct {
			Server  string `toml:"server"`
			Machine string `toml:"machine"`
		}
		if _, err := toml.DecodeFile(filepath.Join(home, "config.toml"), &mc); err == nil {
			if c.Server == "" {
				c.Server = mc.Server
			}
			c.Machine = mc.Machine
		}
		if b, err := os.ReadFile(filepath.Join(home, "token")); err == nil {
			c.Token = strings.TrimSpace(string(b))
		}
	}
	if v := os.Getenv("PANDO_SERVER"); v != "" {
		c.Server = v
	}
	if v := os.Getenv("PANDO_MONOREPO"); v != "" {
		c.Monorepo = v
	}
	if v := os.Getenv("PANDO_TOKEN"); v != "" {
		c.Token = v
	}
	if v := os.Getenv("PANDO_MACHINE"); v != "" {
		c.Machine = v
	}
	if v := os.Getenv("PANDO_AUTHOR"); v != "" {
		c.Author = v // "Name <email>"; once the Worker checks tokens, the token decides
	}
	c.Agent = os.Getenv("PANDO_AGENT")
	c.Server = strings.TrimRight(c.Server, "/")
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
		out, err := exec.Command("git", "config", "--get", key).Output()
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
