package macbroker

import (
	"bytes"
	"context"
	"encoding/xml"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// SettingsPath is where a person turns the extension on.
const SettingsPath = "System Settings > General > Login Items & Extensions > File System Extensions"

// State says whether this Mac can mount worktrees through Pando's FSKit
// extension.
type State struct {
	App     string // the installed Pando.app; "" when macOS does not list the extension
	Enabled bool   // FSKit will mount with it
	Why     string // when not Enabled: what is missing and how to fix it, one sentence
}

// Check asks macOS. pluginkit says whether the extension is registered and
// where its app is. Whether FSKit mounts with it is FSKit's own list, the
// file behind the switch in System Settings; pluginkit's "+" alone is not
// proof (on macOS 26.3 a failed switch leaves "+" and /sbin/mount still says
// "Module ... is disabled!"). When that file cannot be read, "+" decides.
func Check(ctx context.Context) State {
	if runtime.GOOS != "darwin" {
		return State{Why: "the FSKit mount is for macOS"}
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, _ := exec.CommandContext(ctx, "/usr/bin/pluginkit", "-m", "-v", "-i", ExtensionID).Output()
	list, err := os.ReadFile(EnabledListPath())
	if err != nil {
		list = nil
	}
	return stateFrom(string(out), list, fileExists)
}

// EnabledListPath is FSKit's list of the modules this person turned on.
// Apple calls the file an implementation detail (developer forums thread
// 808594), so nothing here depends on it being readable.
func EnabledListPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "Group Containers", "group.com.apple.fskit.settings", "enabledModules.plist")
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

func stateFrom(pluginkit string, list []byte, exists func(string) bool) State {
	flag, app, found := parsePluginkit(pluginkit, exists)
	if !found {
		return State{Why: "Pando.app is not installed: put it in Applications and open it once"}
	}
	off := State{App: app, Why: "the Pando file system extension is off: turn on Pando in " + SettingsPath}
	if flag == '-' || flag == '!' {
		return off
	}
	if on, ok := plistHasString(list, ExtensionID); ok {
		if on {
			return State{App: app, Enabled: true}
		}
		return off
	}
	if flag == '+' || flag == '=' {
		return State{App: app, Enabled: true}
	}
	return off
}

// parsePluginkit reads `pluginkit -m -v -i <id>`: one line per plugin, a
// flag first ("+" chosen, "-" turned off, a space for no choice), then tab
// separated fields, one of them the plugin's path inside its app.
func parsePluginkit(out string, exists func(string) bool) (flag byte, app string, found bool) {
	for _, line := range strings.Split(out, "\n") {
		if !strings.Contains(line, ExtensionID+"(") {
			continue
		}
		flag = line[0]
		for _, f := range strings.Split(line, "\t") {
			f = strings.TrimSpace(f)
			if i := strings.Index(f, ".app/"); i > 0 && strings.HasPrefix(f, "/") {
				app = f[:i+4]
			}
		}
		if app == "" && exists("/Applications/Pando.app") {
			app = "/Applications/Pando.app"
		}
		return flag, app, true
	}
	return 0, "", false
}

// plistHasString reports whether a plist holds s as a string; ok is false
// for anything that is not a plist this can read. FSKit writes XML today; a
// binary plist goes through plutil.
func plistHasString(b []byte, s string) (found, ok bool) {
	if bytes.HasPrefix(b, []byte("bplist")) {
		cmd := exec.Command("/usr/bin/plutil", "-convert", "xml1", "-o", "-", "-")
		cmd.Stdin = bytes.NewReader(b)
		out, err := cmd.Output()
		if err != nil {
			return false, false
		}
		b = out
	}
	if !bytes.Contains(b, []byte("<plist")) {
		return false, false
	}
	var esc bytes.Buffer
	_ = xml.EscapeText(&esc, []byte(s))
	return bytes.Contains(b, []byte("<string>"+esc.String()+"</string>")), true
}
