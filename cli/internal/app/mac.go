package app

import "pando/internal/macbroker"

// Mac is `pando mac broker [--dry-run] [--app <path>]`: write and load the
// LaunchAgent for Pando.app's broker. The FSKit worktree driver runs the
// same step before its first mount.
func Mac(e *Env, args []string) error {
	if len(args) == 0 || args[0] != "broker" {
		return UsageError{"pando mac broker [--dry-run] [--app <path>]"}
	}
	fs := flags("mac broker")
	dry := fs.Bool("dry-run", false, "print the LaunchAgent and the commands; load nothing")
	appPath := fs.String("app", "", "the installed Pando.app (default: found through pluginkit)")
	if _, err := parse(fs, args[1:]); err != nil {
		return err
	}
	p := *appPath
	if p == "" {
		p = macbroker.AppPath(e.Ctx)
	}
	if err := macbroker.Ensure(e.Ctx, p, *dry, e.Stdout); err != nil {
		return err
	}
	if !*dry {
		e.printf("pando-broker is loaded and answers.\n")
	}
	return nil
}
