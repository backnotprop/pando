package app

import (
	"errors"
	"fmt"
	"strings"

	"pando/internal/server"
)

// Monorepos are named owner/name, like GitHub repos (RULINGS.md; the plan
// is research/plans/architecture-2026-10-03/NAMESPACES.md). Owners are
// lower case and matched without regard to case.

// splitFull splits owner/name; ok is false for a bare name.
func splitFull(s string) (owner, name string, ok bool) {
	owner, name, ok = strings.Cut(strings.Trim(s, "/"), "/")
	if !ok || owner == "" || name == "" || strings.Contains(name, "/") {
		return "", s, false
	}
	return strings.ToLower(owner), name, true
}

// resolveMonorepo finds the monorepo a person means. owner/name is that
// monorepo. A bare name is the one in the person's own namespace, else the
// only one so named they can see; with several, it stops and lists them.
func resolveMonorepo(e *Env, srv server.Server, arg string) (*server.Monorepo, error) {
	if owner, name, ok := splitFull(arg); ok {
		m, err := srv.GetMonorepo(e.Ctx, owner+"/"+name)
		if err != nil {
			if errors.Is(err, server.ErrNotFound) {
				return nil, fmt.Errorf("no monorepo %s/%s (or you are not a member)", owner, name)
			}
			return nil, err
		}
		return m, nil
	}
	ms, err := srv.ListMonorepos(e.Ctx, arg)
	if err != nil {
		return nil, err
	}
	var named []server.Monorepo
	for _, m := range ms {
		if strings.EqualFold(m.Name, arg) {
			named = append(named, m)
		}
	}
	switch len(named) {
	case 0:
		return nil, fmt.Errorf("no monorepo named %s that you belong to", arg)
	case 1:
		return &named[0], nil
	}
	if me, err := srv.Me(e.Ctx); err == nil {
		for i := range named {
			if strings.EqualFold(named[i].Owner, me.Login) {
				return &named[i], nil
			}
		}
	}
	choices := make([]string, len(named))
	for i, m := range named {
		choices[i] = m.Full()
	}
	return nil, fmt.Errorf("more than one monorepo is named %s; use one of: %s", arg, strings.Join(choices, ", "))
}
