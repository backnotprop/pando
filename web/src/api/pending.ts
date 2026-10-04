// What the web reads that @pando/contract does not have yet (asked of web-api
// through pando-ops, 2026-10-04): a monorepo's event socket with row topics,
// its row frames, and build_id on ci.job rows. It moves into the contract
// with a recording, and this file goes away. Frames as
// worker/src/monorepo/object.ts publish() sends them; only the kinds and
// fields a page patches its cache from are listed.
import { Branch, CiBuild, CiJob, Count, type Login, Machine, type MonorepoName, RepoName, Status } from "@pando/contract";
import * as Schema from "effect/Schema";

/** GET /v1/monorepos/{owner}/{monorepo}/events?topics=&since= with Upgrade: the rows on those topics, after `since` first. */
export const monorepoEventsPath = (owner: Login, name: MonorepoName, topics: readonly string[], since: number | null) => {
  const params = new URLSearchParams({ topics: topics.join(",") });

  if (since !== null) params.set("since", String(since));

  return `/v1/monorepos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/events?${params}`;
};

/** One row event: its kind, the row's key and what to do with it. */
const rowEvent = <const K extends string, R extends Schema.Top>(kind: K, row: R) =>
  Schema.Struct({
    type: Schema.tag("event"),
    seq: Count,
    kind: Schema.tag(kind),
    key: Schema.String,
    op: Schema.Literals(["upsert", "delete"]),
    /** The repo the row is in; null for a machine or a connection. */
    repo: Schema.NullOr(RepoName),
    row,
  });

export const RowFrame = Schema.Union([
  /** topic kind:machine.updated: a machine connected, went offline, or acted. */
  rowEvent("machine.updated", Machine),
  /** topics kind:ci.build, repo:<repo>. */
  rowEvent("ci.build", CiBuild),
  /** topics kind:ci.job, repo:<repo>. `build_id` (Pando's build id) is coming from web-api; until then `key` is "<build id>/<job id>". */
  rowEvent("ci.job", CiJob.pipe(Schema.fieldsAssign({ build_id: Schema.optionalKey(Schema.String) }))),
  /** topic kind:ci.connection: connected (the connection) or disconnected ({id}). */
  rowEvent("ci.connection", Schema.Struct({ id: Schema.String })),
  /** topic repo:<repo>: the branch's whole row, its facts with it (`partial: false`). */
  rowEvent("branch.updated", Branch.pipe(Schema.fieldsAssign({ repo: RepoName }))),
  /**
   * topic repo:<repo>: a check reported on a commit. Today no branch.updated
   * follows it, so a branch page at that commit reads its branch again once
   * (live/rows.ts); web-api is making the server publish branch.updated with
   * the checks, and then this kind and that read go (pando-ops, 2026-10-04).
   */
  rowEvent("status", Status),
  /** The replay is done (or there was none): live from here. */
  Schema.Struct({ type: Schema.tag("caught_up"), seq: Count }),
  /** More was missed than the server replays: refetch, then resume from `seq`. */
  Schema.Struct({ type: Schema.tag("resync"), seq: Count }),
]);

export type RowFrame = typeof RowFrame.Type;

/** A row (not caught_up or resync). */
export type RowEvent = Extract<RowFrame, { type: "event" }>;

/** One text frame: Some(frame), or None for `pong`, a kind the web does not patch, or anything malformed (skip it). */
export const decodeRowFrame = Schema.decodeUnknownOption(Schema.fromJsonString(RowFrame), { onExcessProperty: "ignore" });
