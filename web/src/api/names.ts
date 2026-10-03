// A monorepo's owner and name from the address bar, checked against the
// contract's patterns. An address that cannot name a monorepo is not found.
import { FullName, Login, MonorepoName, NotFound } from "@pando/contract";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export interface MonorepoRef {
  owner: Login;
  name: MonorepoName;
  full: FullName;
}

const login = Schema.decodeUnknownResult(Login);

const monorepoName = Schema.decodeUnknownResult(MonorepoName);

const fullName = Schema.decodeUnknownResult(FullName);

export function monorepoRef(owner: string, name: string): MonorepoRef {
  const o = login(owner.toLowerCase());
  const n = monorepoName(name.toLowerCase());
  const f = fullName(`${owner}/${name}`.toLowerCase());

  if (Result.isFailure(o) || Result.isFailure(n) || Result.isFailure(f)) throw new NotFound({ code: "not_found", message: `no monorepo ${owner}/${name}` });

  return { owner: o.success, name: n.success, full: f.success };
}

/** A monorepo's `owner/name`, as the `in` filter takes it; null for anything else. */
export function fullNameOf(value: string | undefined): FullName | null {
  if (!value) return null;
  value = value.toLowerCase();
  const [owner = "", name = "", rest] = value.split("/");

  if (rest !== undefined || Result.isFailure(login(owner)) || Result.isFailure(monorepoName(name))) return null;
  const f = fullName(value);

  return Result.isSuccess(f) ? f.success : null;
}
