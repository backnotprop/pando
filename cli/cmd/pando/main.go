// The pando command. Subcommands are registered by the lanes that own them
// (see docs/contracts/README.md).
package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: pando <command> [args]")
		os.Exit(2)
	}
	fmt.Fprintf(os.Stderr, "pando: unknown command %q\n", os.Args[1])
	os.Exit(2)
}
