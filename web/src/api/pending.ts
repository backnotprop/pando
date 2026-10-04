// What the web reads that @pando/contract on main does not have yet: a
// monorepo's event socket with row topics, and its frames. web-api's fd9c23d
// adds them to the contract (Routes.monorepoEventsSocketPath,
// MonorepoEventFrame, decodeMonorepoEventFrame); these mirror that commit's
// shapes for the kinds the web patches from, and this file goes when it lands.
import { Branch, CiBuild, CiJob, Count, type Login, Machine, type MonorepoName, RepoName, Status, Timestamp } from "@pando/contract";
import * as Schema from "effect/Schema";

/** A monorepo's event socket for row updates (with `Upgrade: websocket`): `topics` such as `kind:ci.build` or `repo:<repo>`, `since` the highest `seq` seen. */
export const monorepoEventsSocketPath = (owner: Login, name: MonorepoName, topics: readonly string[], since: number | null): string => {
  const params = new URLSearchParams({ topics: topics.join(",") });

  if (since !== null) params.set("since", String(since));

  return `/v1/monorepos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/events?${params}`;
};

/** What every event frame carries: its place in the stream, its key and its repo. */
const envelope = {
  type: Schema.tag("event"),
  seq: Count,
  at: Timestamp,
  key: Schema.String,
  repo: Schema.NullOr(RepoName),
};

export const MonorepoEventFrame = Schema.Union([
  /** A branch's full row (facts, checks and gate as getBranch answers it): replace the cached branch. */
  Schema.Struct({ ...envelope, kind: Schema.Literal("branch.updated"), partial: Schema.Literal(false), row: Branch.pipe(Schema.fieldsAssign({ repo: RepoName })) }),
  /**
   * A status on a commit. With fd9c23d the branches at that commit follow as
   * branch.updated; until it lands, a branch page at that commit reads its
   * branch once (live/rows.ts), and that read goes with this file.
   */
  Schema.Struct({ ...envelope, kind: Schema.Literal("status"), row: Status }),
  /** A machine's row on the Machines tab. */
  Schema.Struct({ ...envelope, kind: Schema.Literal("machine.updated"), row: Machine }),
  /** A CI build, as GET .../ci/builds answers it. */
  Schema.Struct({ ...envelope, kind: Schema.Literal("ci.build"), row: CiBuild }),
  /** A CI job; `row.build` is its build's Pando id. */
  Schema.Struct({ ...envelope, kind: Schema.Literal("ci.job"), row: CiJob }),
  /** A CI connection made, changed or removed. */
  Schema.Struct({ ...envelope, kind: Schema.Literal("ci.connection"), row: Schema.Struct({ id: Schema.String }) }),
  /** The replay after `since` is done. */
  Schema.Struct({ type: Schema.tag("caught_up"), seq: Count }),
  /** More was missed than the stream replays: refetch, then reconnect from `seq`. */
  Schema.Struct({ type: Schema.tag("resync"), seq: Count, oldest_seq: Count }),
]);

export type MonorepoEventFrame = typeof MonorepoEventFrame.Type;

/** A row (not caught_up or resync). */
export type RowEvent = Extract<MonorepoEventFrame, { type: "event" }>;

/** One text frame: Some(frame), or None for `pong`, a kind the web does not patch from, or anything malformed (skip it). */
export const decodeMonorepoEventFrame = Schema.decodeUnknownOption(Schema.fromJsonString(MonorepoEventFrame), { onExcessProperty: "ignore" });
