package macbroker

import (
	"os/exec"
	"strings"
	"testing"
)

func enabledList(ids ...string) []byte {
	b := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
`
	for _, id := range ids {
		b += "\t<string>" + id + "</string>\n"
	}
	return []byte(b + "</array>\n</plist>\n")
}

func TestStateFrom(t *testing.T) {
	line := func(flag string) string {
		return flag + "    " + ExtensionID + "(0.1.0)\t21FE86BB-A973-418F-8FF2-B932FBC7F0A1\t2026-10-03 12:46:41 +0000\t/Applications/Pando.app/Contents/Extensions/PandoExtension.appex\n (1 plug-in)\n"
	}
	none := func(string) bool { return false }
	cases := []struct {
		name      string
		pluginkit string
		list      []byte
		enabled   bool
		why       string
	}{
		// What this Mac showed on 2026-10-03: "+", but not in FSKit's list.
		{"plus, not in FSKit's list", line("+"), enabledList("com.apple.fskit.apfs"), false, "is off: turn on Pando in System Settings"},
		{"plus and in the list", line("+"), enabledList("com.apple.fskit.apfs", ExtensionID), true, ""},
		{"no choice, in the list", line(" "), enabledList(ExtensionID), true, ""},
		{"turned off", line("-"), enabledList(ExtensionID), false, "is off"},
		{"list unreadable, plus", line("+"), nil, true, ""},
		{"list unreadable, no choice", line(" "), nil, false, "is off"},
		{"not registered", "", enabledList(ExtensionID), false, "Pando.app is not installed"},
		{"another plugin", "+    ai.plannotator.pando.extension.other(1)\t/x/Other.app/Contents/Extensions/O.appex\n", enabledList(ExtensionID), false, "not installed"},
	}
	for _, tc := range cases {
		st := stateFrom(tc.pluginkit, tc.list, none)
		if st.Enabled != tc.enabled || !strings.Contains(st.Why, tc.why) {
			t.Fatalf("%s: %+v", tc.name, st)
		}
		if tc.pluginkit != "" && strings.Contains(tc.pluginkit, ExtensionID+"(") && st.App != "/Applications/Pando.app" {
			t.Fatalf("%s: app %q", tc.name, st.App)
		}
		if strings.Contains(st.Why, "—") {
			t.Fatalf("em dash in %q", st.Why)
		}
	}
}

func TestPlistBinary(t *testing.T) {
	cmd := exec.Command("/usr/bin/plutil", "-convert", "binary1", "-o", "-", "-")
	cmd.Stdin = strings.NewReader(string(enabledList(ExtensionID)))
	bin, err := cmd.Output()
	if err != nil {
		t.Skip("no plutil here")
	}
	if on, ok := plistHasString(bin, ExtensionID); !on || !ok {
		t.Fatalf("binary plist: on %v ok %v", on, ok)
	}
	if _, ok := plistHasString([]byte("not a plist"), ExtensionID); ok {
		t.Fatal("garbage read as a plist")
	}
}
