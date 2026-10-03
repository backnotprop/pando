// Records the web reads that @pando/contract does not have yet (asked of the
// quality lane). Each moves into the contract with a recording, and this file
// goes away. Only the fields a screen uses are listed.
import { Count, FullName, Login, MonorepoId, MonorepoKind, MonorepoName } from "@pando/contract";
import * as Schema from "effect/Schema";

/** GET /v1/monorepos/{owner}/{monorepo} (getMonorepo). */
export const Monorepo = Schema.Struct({ id: MonorepoId, owner: Login, name: MonorepoName, full_name: FullName, kind: MonorepoKind });

export interface Monorepo extends Schema.Schema.Type<typeof Monorepo> {}

/** GET .../repos (listRepos). */
export const Repo = Schema.Struct({ name: Schema.String, path: Schema.String, clone_url: Schema.String });

export interface Repo extends Schema.Schema.Type<typeof Repo> {}

export const Repos = Schema.Struct({ repos: Schema.Array(Repo) });

/** GET .../repos/{repo}/branches?state=open (listBranches): only the names, for the open-branch counts. */
export const BranchNames = Schema.Struct({ branches: Schema.Array(Schema.Struct({ name: Schema.String })) });

/** GET .../members (listMembers): only the count is shown in slice 1. */
export const Members = Schema.Struct({ members: Schema.Array(Schema.Struct({ login: Login })) });

/** GET .../machines (the Machines tab): the count of machines connected now. */
export const Machines = Schema.Struct({ machines: Schema.Array(Schema.Struct({ connected: Schema.Boolean })) });

/** POST .../meta/restore. */
export const Restored = Schema.Union([Schema.Struct({ version: Count }), Schema.Struct({ unchanged: Schema.Boolean, version: Count })]);

/** POST /v1/logout with Accept: application/json. */
export const SignedOut = Schema.Struct({ signed_out: Schema.Boolean, logout_url: Schema.String });
