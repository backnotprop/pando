// The contract's one check: every recorded real response (recorded/*.json,
// written by record.mjs) decodes against its schema, with unknown fields
// refused, so a field the Worker sends and the contract lacks fails here too.
// Run: npm run check -w @pando/contract
import { readdirSync, readFileSync } from "node:fs";

import { Option, Result, Schema } from "effect";
import { flow } from "effect/Function";

import { ActivityFrame, ErrorBody, EventsPage, Me, MetaFileHeaders, MetaHistory, MetaTree, MonorepoList, MonorepoSummaryList, NeedsPage } from "../src/index.ts";

const Recording = Schema.Struct({
  schema: Schema.String,
  route: Schema.String,
  status: Schema.Int,
  body: Schema.Unknown,
});

/** A decoder that answers the failure, if any, so every entry has one type. */
const refuses = <A, I>(schema: Schema.Codec<A, I>) => flow(Schema.decodeUnknownResult(schema, { onExcessProperty: "error" }), Result.getFailure);

const decoders = {
  Me: refuses(Me),
  ErrorBody: refuses(ErrorBody),
  MonorepoList: refuses(MonorepoList),
  MonorepoSummaryList: refuses(MonorepoSummaryList),
  EventsPage: refuses(EventsPage),
  NeedsPage: refuses(NeedsPage),
  "ActivityFrame[]": refuses(Schema.Array(ActivityFrame)),
  MetaTree: refuses(MetaTree),
  MetaHistory: refuses(MetaHistory),
  MetaFileHeaders: refuses(MetaFileHeaders),
};

const isDecoderName = Schema.is(Schema.Literals(["Me", "ErrorBody", "MonorepoList", "MonorepoSummaryList", "EventsPage", "NeedsPage", "ActivityFrame[]", "MetaTree", "MetaHistory", "MetaFileHeaders"]));

const folder = new URL("../recorded/", import.meta.url);

const files = readdirSync(folder).filter((file) => file.endsWith(".json")).sort();

let failures = 0;

for (const file of files) {
  const recording = Schema.decodeUnknownSync(Recording)(JSON.parse(readFileSync(new URL(file, folder), "utf8")));

  if (!isDecoderName(recording.schema)) {
    failures++;
    console.log(`FAIL  ${file}: no schema named ${recording.schema}`);
    continue;
  }

  const failure = decoders[recording.schema](recording.body);

  if (Option.isNone(failure)) {
    console.log(`PASS  ${file}  ${recording.route} as ${recording.schema}`);
    continue;
  }

  failures++;
  console.log(`FAIL  ${file}  ${recording.route} as ${recording.schema}\n${failure.value.message}`);
}

console.log(`${files.length - failures} of ${files.length} recordings decode`);

process.exit(failures === 0 && files.length > 0 ? 0 : 1);
