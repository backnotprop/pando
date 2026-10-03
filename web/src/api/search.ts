// The query strings routes read, as Standard Schema validators for TanStack
// Router. Search values arrive as plain strings (main.tsx parses them with
// URLSearchParams, so `?v=431` stays 431, never JSON).
import * as Schema from "effect/Schema";

/** The home: `?in=owner/name` narrows the log and "Needs you" to one monorepo. */
export const homeSearch = Schema.toStandardSchemaV1(Schema.Struct({ in: Schema.optionalKey(Schema.String) }));

/** The sign-in page: where to come back to. */
export const loginSearch = Schema.toStandardSchemaV1(Schema.Struct({ return_to: Schema.optionalKey(Schema.String) }));

/** A root file: `?v=` shows an older version. */
export const fileSearch = Schema.toStandardSchemaV1(Schema.Struct({ v: Schema.optionalKey(Schema.String) }));

/** A version number from `?v=`, or null for now. */
export function versionOf(v: string | undefined): number | null {
  const n = Number(v);

  return v && Number.isSafeInteger(n) && n > 0 ? n : null;
}
