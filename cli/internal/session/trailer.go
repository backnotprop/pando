package session

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// sessionVar is the variable each agent puts its session id in, in the shell it runs commands in. Codex's is the
// thread's own (a subagent's commit names the subagent); Claude Code's subagents carry their parent's.
var sessionVar = map[string]string{ClaudeCode: "CLAUDE_CODE_SESSION_ID", Codex: "CODEX_THREAD_ID", Pi: "PI_SESSION_ID", OpenCode: "OPENCODE_SESSION_ID"}

// TrailerFor is the commit hook's rule for a Pando-Session line: the nearest agent above the hook, by its own
// variable; nothing while recording is off, while git replays commits (a rebase or a cherry-pick would stamp the
// replaying session on old work), or when the nearest agent set no variable. Never matched by time.
func TrailerFor(gitDir string, getenv func(string) string, nearest string, recording bool) string {
	if !recording || nearest == "" {
		return ""
	}
	for _, busy := range []string{"rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD"} {
		if _, err := os.Stat(filepath.Join(gitDir, busy)); err == nil {
			return ""
		}
	}
	v := getenv(sessionVar[nearest])
	if v == "" {
		return ""
	}
	return ID(nearest, v)
}

// AgentOf names the agent a command line runs, or "": the program, or the script node, bun, deno or a shell runs
// (an agent installed as a wrapper script).
func AgentOf(args string) string {
	f := strings.Fields(args)
	if len(f) == 0 {
		return ""
	}
	script := f[0]
	switch strings.TrimSuffix(filepath.Base(f[0]), ".exe") {
	case "node", "bun", "deno", "sh", "bash", "zsh", "dash":
		if len(f) < 2 || strings.HasPrefix(f[1], "-") {
			return ""
		}
		script = f[1]
	}
	name := filepath.Base(script)
	switch {
	case name == "claude" || strings.Contains(script, "claude-code"):
		return ClaudeCode
	case strings.HasPrefix(name, "codex") || strings.Contains(script, "@openai/codex"):
		return Codex
	case name == "pi" || strings.Contains(script, "pi-coding-agent"):
		return Pi
	case strings.HasPrefix(name, "opencode") || strings.Contains(script, "opencode-ai"):
		return OpenCode
	}
	return ""
}

type proc struct {
	ppid int
	args string
}

// processes is every process's parent and command line: /proc on Linux, ps elsewhere.
func processes() map[int]proc {
	out := map[int]proc{}
	if runtime.GOOS == "linux" {
		dirs, _ := os.ReadDir("/proc")
		for _, d := range dirs {
			pid, err := strconv.Atoi(d.Name())
			if err != nil {
				continue
			}
			stat, err1 := os.ReadFile(filepath.Join("/proc", d.Name(), "stat"))
			cmd, err2 := os.ReadFile(filepath.Join("/proc", d.Name(), "cmdline"))
			if err1 != nil || err2 != nil {
				continue
			}
			// stat: "pid (comm) state ppid ..."; comm may hold spaces, so read after the last ")".
			rest := strings.Fields(string(stat[bytes.LastIndexByte(stat, ')')+1:]))
			if len(rest) < 2 {
				continue
			}
			ppid, _ := strconv.Atoi(rest[1])
			out[pid] = proc{ppid: ppid, args: strings.TrimSpace(string(bytes.ReplaceAll(cmd, []byte{0}, []byte{' '})))}
		}
		return out
	}
	b, err := exec.Command("ps", "-axww", "-o", "pid=,ppid=,args=").Output()
	if err != nil {
		return out
	}
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 3 {
			continue
		}
		pid, _ := strconv.Atoi(f[0])
		ppid, _ := strconv.Atoi(f[1])
		out[pid] = proc{ppid: ppid, args: strings.Join(f[2:], " ")}
	}
	return out
}

// NearestAgent walks up from pid to the first agent program; "" when none is an ancestor (a commit typed in a plain
// terminal, or by an editor that outlived the agent that started it).
func NearestAgent(pid int) string {
	table := processes()
	for hops := 0; pid > 1 && hops < 64; hops++ {
		p, ok := table[pid]
		if !ok {
			return ""
		}
		if a := AgentOf(p.args); a != "" {
			return a
		}
		pid = p.ppid
	}
	return ""
}

// LearnFromShell keeps a moved data folder the agent's shell names, so `pando sync` finds a session stored there.
func LearnFromShell(homeDir, program string, getenv func(string) string) {
	var path string
	switch program {
	case ClaudeCode:
		path = getenv("CLAUDE_CONFIG_DIR")
	case Codex:
		path = getenv("CODEX_HOME")
	case Pi:
		// <sessions>/<the folder's own directory>/<file>
		if f := getenv("PI_SESSION_FILE"); f != "" {
			path = filepath.Dir(filepath.Dir(f))
		}
	case OpenCode:
		path = getenv("OPENCODE_DB")
		if path == "" && getenv("XDG_DATA_HOME") != "" {
			path = filepath.Join(getenv("XDG_DATA_HOME"), "opencode", "opencode.db")
		}
	}
	if path != "" {
		_ = Learn(homeDir, Normalize(program, path))
	}
}

// ExclusionsFile caches the person's own exclusions for the commit hook, which does not call the server.
func ExclusionsFile(homeDir string) string { return filepath.Join(homeDir, "session-exclusions.json") }

// CachedExclusion is one entry of that cache.
type CachedExclusion struct {
	Monorepo   string  `json:"monorepo"`
	MonorepoID string  `json:"monorepo_id"`
	Project    *string `json:"project"`
}

// CachedExclusions reads the cache (missing: none).
func CachedExclusions(homeDir string) []CachedExclusion {
	var out []CachedExclusion
	if b, err := os.ReadFile(ExclusionsFile(homeDir)); err == nil {
		_ = json.Unmarshal(b, &out)
	}
	return out
}
