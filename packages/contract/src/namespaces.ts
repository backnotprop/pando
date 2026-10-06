// Names no person or org can take. A namespace (a login or an org) is the
// first URL segment, so it can never be one of the Worker's own paths or the
// web app's top-level pages. One list for the Worker (which imports this file
// alone, as `@pando/contract/names`, so it bundles no Effect) and the web.
// api-v1.yaml's Login description lists the same names.
export const RESERVED_NAMESPACES: ReadonlySet<string> = new Set([
  "v1", "healthz", "login", "logout", "settings", "assets", "fonts", "new", "api", "app", "static", "orgs", "users", "docs",
]);

// Names no repository can take, under a person or an org: /{owner}/{name} would be one of the web app's own pages
// under a namespace. `sessions`: /{login}/sessions is a person's recorded agent sessions (owner, 2026-10-05).
export const RESERVED_REPOSITORY_NAMES: ReadonlySet<string> = new Set(["sessions"]);
