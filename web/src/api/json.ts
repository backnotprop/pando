// A JSON request body's types, on their own so a module that only builds a
// body (an artifact comment's anchor, ui/doc/artifact/) need not load the client.

/** A value in a JSON request body. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonBody;

/** A JSON request body. */
export interface JsonBody {
  readonly [key: string]: JsonValue;
}
