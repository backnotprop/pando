package meta

// Opt-in measurement, not a check: PANDO_META_LATENCY=watch|poll100|poll500
// with PANDO_META_TEST_URL, and PANDO_META_LATENCY_TREE=<files> for a big
// meta layer. Prints the one-way time from a write on one machine until the
// other machine's file holds the bytes, for 20 saves each way.

import (
	"context"
	"fmt"
	"os"
	"slices"
	"strconv"
	"testing"
	"time"
)

func TestLatency(t *testing.T) {
	mode := os.Getenv("PANDO_META_LATENCY")
	if mode == "" {
		t.Skip("set PANDO_META_LATENCY=watch|poll100|poll500")
	}
	env := newEnv(t)
	env.own(t, "latency")
	poll := 100 * time.Millisecond
	switch mode {
	case "watch":
	case "poll100", "poll500":
		if mode == "poll500" {
			poll = 500 * time.Millisecond
		}
		old := startWatcher
		startWatcher = func(string, *Rules) (watcher, error) { return nil, errNoWatcher }
		t.Cleanup(func() { startWatcher = old })
	default:
		t.Fatalf("unknown mode %s", mode)
	}
	tree, _ := strconv.Atoi(os.Getenv("PANDO_META_LATENCY_TREE"))
	mk := func(name string) *machine {
		m := env.bare(t, name)
		m.writeRoot(".pando/local/root.json", fmt.Sprintf(`{"version":1,"kind":"monorepo","name":%q,"server":%q,"repos":[]}`, env.mono, env.server))
		return m
	}
	a, b := mk("ana"), mk("ben")
	if tree > 0 {
		for i := 0; i < tree; i++ {
			a.write(fmt.Sprintf("research/topic-%03d/note-%05d.md", i%300, i), fmt.Sprintf("# Note %d\n", i))
		}
		start := time.Now()
		if err := Init(context.Background(), a.root); err != nil {
			t.Fatal(err)
		}
		if err := Clone(context.Background(), b.root); err != nil {
			t.Fatal(err)
		}
		t.Logf("%d files uploaded and cloned in %s", tree, time.Since(start).Round(time.Second))
	}
	for _, m := range []*machine{a, b} {
		cfg := m.config()
		cfg.Poll = poll
		cfg.Log = quietLogger()
		m.startWith(cfg)
	}
	time.Sleep(time.Second) // both online, first scans done

	measure := func(from, to *machine, i int) time.Duration {
		rel := fmt.Sprintf("latency/%s-%02d.md", from.name, i)
		body := fmt.Sprintf("save %d from %s at %d\n", i, from.name, time.Now().UnixNano())
		start := time.Now()
		from.write(rel, body)
		for time.Since(start) < 15*time.Second {
			if got, ok := to.read(rel); ok && got == body {
				return time.Since(start)
			}
			time.Sleep(2 * time.Millisecond)
		}
		t.Fatalf("%s never reached %s", rel, to.name)
		return 0
	}
	var ds []time.Duration
	for i := 0; i < 20; i++ {
		ds = append(ds, measure(a, b, i), measure(b, a, i))
		time.Sleep(150 * time.Millisecond)
	}
	slices.Sort(ds)
	ms := func(d time.Duration) string { return fmt.Sprintf("%d ms", d.Milliseconds()) }
	t.Logf("RESULT mode=%s tree=%d one-way: p50 %s, p90 %s, min %s, max %s (%d saves)",
		mode, tree, ms(ds[len(ds)/2]), ms(ds[len(ds)*9/10]), ms(ds[0]), ms(ds[len(ds)-1]), len(ds))
}
