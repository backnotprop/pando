// Records the web reads that @pando/contract does not have yet (asked of the
// quality lane): only the heads route now. It moves into the contract with a
// recording, and this file goes away.
import * as Schema from "effect/Schema";

/** GET .../heads: each code repo's main head as Pando last moved it. */
export const Heads = Schema.Struct({
  heads: Schema.Array(Schema.Struct({ repo: Schema.String, path: Schema.String, head: Schema.NullOr(Schema.String), updated_at: Schema.NullOr(Schema.String) })),
});

export type Head = (typeof Heads.Type)["heads"][number];
