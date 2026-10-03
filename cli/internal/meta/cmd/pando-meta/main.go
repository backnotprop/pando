// pando-meta runs the meta layer commands on their own, for testing the live
// lane before they are wired into the pando command. The same commands will
// be `pando meta sync`, `pando history`, `pando restore`, `pando resolve`.
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
		fmt.Fprintln(os.Stderr, "usage: pando-meta sync|download|history|restore|resolve|status [args]")
		os.Exit(2)
	}
	cmds := map[string]func([]string) int{
		"sync":     meta.CmdSync,
		"download": meta.CmdDownload,
		"history":  meta.CmdHistory,
		"restore":  meta.CmdRestore,
		"resolve":  meta.CmdResolve,
		"status":   meta.CmdStatus,
	}
	run, ok := cmds[os.Args[1]]
	if !ok {
		fmt.Fprintf(os.Stderr, "pando-meta: unknown command %q\n", os.Args[1])
		os.Exit(2)
	}
	os.Exit(run(os.Args[2:]))
}
