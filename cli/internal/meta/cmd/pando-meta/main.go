// pando-meta runs the live sync's commands on their own, for testing the
// live lane without the rest of the pando command. In pando they are
// `pando sync`, `pando history`, `pando restore`, `pando resolve` and
// `pando fetch`, and Init and Clone run inside `pando init` and `pando clone`.
//
//	go run ./internal/meta/cmd/pando-meta sync --root <folder>
package main

import (
	"fmt"
	"os"

	"pando/internal/meta"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: pando-meta sync|init|clone|fetch|history|restore|resolve|status [args]")
		os.Exit(2)
	}
	cmds := map[string]func([]string) int{
		"sync":    func(a []string) int { return meta.CmdSync(a, meta.Hooks{}) },
		"init":    meta.CmdInit,
		"clone":   meta.CmdClone,
		"fetch":   meta.CmdFetch,
		"history": meta.CmdHistory,
		"restore": meta.CmdRestore,
		"resolve": meta.CmdResolve,
		"status":  meta.CmdStatus,
	}
	run, ok := cmds[os.Args[1]]
	if !ok {
		fmt.Fprintf(os.Stderr, "pando-meta: unknown command %q\n", os.Args[1])
		os.Exit(2)
	}
	os.Exit(run(os.Args[2:]))
}
