// The query strings routes read, as Standard Schema validators for TanStack
// Router. Search values arrive as plain strings (main.tsx parses them with
// URLSearchParams, so `?v=431` stays 431, never JSON).
import * as Schema from "effect/Schema";

/** The home: `?in=owner/name` narrows the log and "Needs you" to one monorepo. */
export const homeSearch = Schema.toStandardSchemaV1(Schema.Struct({ in: Schema.optionalKey(Schema.String) }));

/** The sign-in page: where to come back to. */
export const loginSearch = Schema.toStandardSchemaV1(Schema.Struct({ return_to: Schema.optionalKey(Schema.String) }));

/** A file: `?v=` shows an older version of a root file; `?ref=` a project's file at a branch or commit; `?plain=1` a document's code, not its Preview. */
export const fileSearch = Schema.toStandardSchemaV1(
  Schema.Struct({ v: Schema.optionalKey(Schema.String), ref: Schema.optionalKey(Schema.String), plain: Schema.optionalKey(Schema.String) }),
);

/** A project's code: `?ref=` for a branch or a commit (the default branch without it). */
export const refSearch = Schema.toStandardSchemaV1(Schema.Struct({ ref: Schema.optionalKey(Schema.String) }));

/** A repo's branches: `?tab=merged` for what landed on main. */
export const branchesSearch = Schema.toStandardSchemaV1(Schema.Struct({ tab: Schema.optionalKey(Schema.String) }));

/** A branch's page: `?tab=files` for Files changed. */
export const branchSearch = Schema.toStandardSchemaV1(Schema.Struct({ tab: Schema.optionalKey(Schema.String) }));

/** A CI build: `?job=` opens that job on its log (a branch's check links there). */
export const jobSearch = Schema.toStandardSchemaV1(Schema.Struct({ job: Schema.optionalKey(Schema.String) }));

/** A version number from `?v=`, or null for now. */
export function versionOf(v: string | undefined): number | null {
  const n = Number(v);

  return v && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The issues list: its filters, kept in the address (`?state=closed&label=bug,auth&assignee=@me&sort=updated&q=words`). */
export const issuesSearch = Schema.toStandardSchemaV1(
  Schema.Struct({
    state: Schema.optionalKey(Schema.String),
    label: Schema.optionalKey(Schema.String),
    assignee: Schema.optionalKey(Schema.String),
    author: Schema.optionalKey(Schema.String),
    project: Schema.optionalKey(Schema.String),
    q: Schema.optionalKey(Schema.String),
    sort: Schema.optionalKey(Schema.String),
  }),
);

/** New issue: `?project=projects-pando` fills its Project. */
export const newIssueSearch = Schema.toStandardSchemaV1(Schema.Struct({ project: Schema.optionalKey(Schema.String) }));
