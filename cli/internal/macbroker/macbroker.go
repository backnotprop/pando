// Package macbroker writes and loads the LaunchAgent for pando-broker, the
// relay inside Pando.app between the FSKit extension and the daemon
// (mac/README.md on the mac-app branch). It runs only when Pando.app is
// installed; without it, worktrees on a Mac use the sparse driver.
package macbroker

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	Label       = "ai.plannotator.pando.broker"
	ExtensionID = "ai.plannotator.pando.extension"
	AppID       = "ai.plannotator.pando"
)

// AppPath finds the installed Pando.app through pluginkit, which lists the
// FSKit extension with its path. It returns "" when the app is not there.
func AppPath(ctx context.Context) string {
	out, err := exec.CommandContext(ctx, "pluginkit", "-m", "-v", "-i", ExtensionID).Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(line, ExtensionID) {
			continue
		}
		for _, f := range strings.Split(line, "\t") {
			f = strings.TrimSpace(f)
			if i := strings.Index(f, ".app/"); i > 0 && strings.HasPrefix(f, "/") {
				return f[:i+4]
			}
		}
		if _, err := os.Stat("/Applications/Pando.app"); err == nil {
			return "/Applications/Pando.app"
		}
	}
	return ""
}

// PlistPath is ~/Library/LaunchAgents/ai.plannotator.pando.broker.plist.
func PlistPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "LaunchAgents", Label+".plist"), nil
}

func esc(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

// Plist is the LaunchAgent for the app at appPath. No RunAtLoad and no
// KeepAlive: launchd starts the broker when the extension looks it up.
func Plist(appPath string) []byte {
	broker := filepath.Join(appPath, "Contents", "MacOS", "pando-broker")
	return []byte(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>` + Label + `</string>
    <key>ProgramArguments</key>
    <array>
        <string>` + esc(broker) + `</string>
    </array>
    <key>MachServices</key>
    <dict>
        <key>` + Label + `</key>
        <true/>
    </dict>
    <key>AssociatedBundleIdentifiers</key>
    <array>
        <string>` + AppID + `</string>
    </array>
    <key>ProcessType</key>
    <string>Interactive</string>
</dict>
</plist>
`)
}

// Ensure writes the LaunchAgent if it differs, loads it into the person's
// gui domain (never with sudo), and pings the broker. With dryRun it only
// prints the plist and the commands it would run.
func Ensure(ctx context.Context, appPath string, dryRun bool, out io.Writer) error {
	if appPath == "" {
		return errors.New("Pando.app is not installed; worktrees use the sparse driver")
	}
	if os.Geteuid() == 0 {
		return errors.New("load the broker as yourself, not as root (root has no gui domain)")
	}
	path, err := PlistPath()
	if err != nil {
		return err
	}
	want := Plist(appPath)
	old, readErr := os.ReadFile(path)
	changed := readErr != nil || !bytes.Equal(old, want)
	domain := fmt.Sprintf("gui/%d", os.Getuid())
	if dryRun {
		fmt.Fprintf(out, "# %s (changed: %t)\n%s", path, changed, want)
		if changed && readErr == nil {
			fmt.Fprintf(out, "# would run: launchctl bootout %s/%s\n", domain, Label)
		}
		fmt.Fprintf(out, "# would run: launchctl bootstrap %s %s\n", domain, path)
		fmt.Fprintf(out, "# would run: %s --ping\n", filepath.Join(appPath, "Contents", "MacOS", "pando-broker"))
		return nil
	}
	if changed {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(path, want, 0o644); err != nil {
			return err
		}
		if readErr == nil {
			_ = exec.CommandContext(ctx, "launchctl", "bootout", domain+"/"+Label).Run()
		}
	}
	cmd := exec.CommandContext(ctx, "launchctl", "bootstrap", domain, path)
	if b, err := cmd.CombinedOutput(); err != nil {
		var ee *exec.ExitError
		// 5 (Input/output error) means it is already loaded.
		if !(errors.As(err, &ee) && ee.ExitCode() == 5) {
			return fmt.Errorf("launchctl bootstrap: %s", strings.TrimSpace(string(b)))
		}
	}
	ping := exec.CommandContext(ctx, filepath.Join(appPath, "Contents", "MacOS", "pando-broker"), "--ping")
	if b, err := ping.CombinedOutput(); err != nil {
		return fmt.Errorf("pando-broker --ping: %s", strings.TrimSpace(string(b)))
	}
	return nil
}
