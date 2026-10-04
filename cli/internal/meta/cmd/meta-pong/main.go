// meta-pong measures the meta layer's round trip between two machines.
// A measuring tool for tests, not part of pando.
//
//	meta-pong pong <dir>               on the far machine (Linux): answer each
//	                                   ping-N.md with pong-N.md, the moment
//	                                   inotify reports it (no polling)
//	meta-pong ping <dir> <n> [gap-ms]  on this machine: write ping-N.md, time
//	                                   until pong-N.md holds the same bytes
//
// Both <dir> are the same folder of one meta layer, on each machine.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"time"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: meta-pong pong <dir> | ping <dir> <n> [gap-ms]")
		os.Exit(2)
	}
	dir := os.Args[2]
	os.MkdirAll(dir, 0o755)
	switch os.Args[1] {
	case "pong":
		if err := pong(dir); err != nil {
			fmt.Fprintln(os.Stderr, "meta-pong:", err)
			os.Exit(1)
		}
	case "ping":
		n, _ := strconv.Atoi(os.Args[3])
		gap := 500
		if len(os.Args) > 4 {
			gap, _ = strconv.Atoi(os.Args[4])
		}
		ping(dir, n, time.Duration(gap)*time.Millisecond)
	}
}

// answer writes pong-N.md with ping-N.md's bytes, as an editor saves.
func answer(dir, name string) {
	var n int
	if _, err := fmt.Sscanf(name, "ping-%d.md", &n); err != nil {
		return
	}
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil || len(b) == 0 {
		return
	}
	out := filepath.Join(dir, fmt.Sprintf("pong-%d.md", n))
	tmp := filepath.Join(dir, fmt.Sprintf(".pong-%d.md.pando-tmp-%d", n, time.Now().UnixNano()))
	if os.WriteFile(tmp, b, 0o644) == nil && os.Rename(tmp, out) == nil {
		fmt.Printf("%s answered ping %d\n", time.Now().Format("15:04:05.000"), n)
	}
}

func ping(dir string, n int, gap time.Duration) {
	var rtts []time.Duration
	for i := 1; i <= n; i++ {
		body := fmt.Sprintf("ping %d %d\n", i, time.Now().UnixNano())
		pongPath := filepath.Join(dir, fmt.Sprintf("pong-%d.md", i))
		start := time.Now()
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("ping-%d.md", i)), []byte(body), 0o644); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		for {
			if b, err := os.ReadFile(pongPath); err == nil && string(b) == body {
				break
			}
			if time.Since(start) > 30*time.Second {
				fmt.Printf("ping %d: no pong after 30 s\n", i)
				os.Exit(1)
			}
			time.Sleep(time.Millisecond)
		}
		d := time.Since(start)
		rtts = append(rtts, d)
		fmt.Printf("ping %d: round trip %d ms\n", i, d.Milliseconds())
		time.Sleep(gap)
	}
	slices.Sort(rtts)
	ms := func(d time.Duration) int64 { return d.Milliseconds() }
	fmt.Printf("RESULT round trip over %d pings: p50 %d ms, p90 %d ms, min %d ms, max %d ms\n",
		len(rtts), ms(rtts[len(rtts)/2]), ms(rtts[len(rtts)*9/10]), ms(rtts[0]), ms(rtts[len(rtts)-1]))
}
