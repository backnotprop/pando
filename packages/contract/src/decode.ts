// Two ways to decode a response, on purpose:
// - decodeResponse is the runtime one, for clients (the web): unknown fields
//   are ignored, so a server that adds a field never breaks an open tab;
// - decodeStrict is for CI only (scripts/check-recorded.ts): unknown fields
//   fail it, so drift between the Worker and this package is caught there.
import * as Schema from "effect/Schema";

import { ActivityFrame } from "./feed.ts";

/** Runtime, for clients: unknown fields are ignored. Answers a Result (success, or a Schema.SchemaError). */
export const decodeResponse = <A, I>(schema: Schema.Codec<A, I>) => Schema.decodeUnknownResult(schema, { onExcessProperty: "ignore" });

/** The same as an Effect, for Effect code. */
export const decodeResponseEffect = <A, I>(schema: Schema.Codec<A, I>) => Schema.decodeUnknownEffect(schema, { onExcessProperty: "ignore" });

/** CI only: unknown fields are refused. Never use it in a client. */
export const decodeStrict = <A, I>(schema: Schema.Codec<A, I>) => Schema.decodeUnknownResult(schema, { onExcessProperty: "error" });

/**
 * One text frame from the person's socket: Some(frame), or None for `pong`,
 * for a frame this build does not know (a newer server) and for anything
 * malformed. Skip a None; never close the socket over it.
 */
export const decodeActivityFrame = Schema.decodeUnknownOption(Schema.fromJsonString(ActivityFrame), { onExcessProperty: "ignore" });
