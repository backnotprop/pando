// Workers AI calls that answer JSON (env.AI, wrangler.jsonc "ai").

import type { Env } from "../env";
import { parseJson, type Json, type JsonObject } from "../parse";

/** A model's answer, read back as JSON (its own object, copied through JSON text: only JSON values survive). */
export async function runJson(env: Env, model: string, input: JsonObject): Promise<Json> {
  const out = await env.AI.run(model, { ...input });

  return parseJson(JSON.stringify(out));
}
