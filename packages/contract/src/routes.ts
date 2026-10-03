// The routes web slice 1 reads: each one's path and the schema of its 200
// body. Names are api-v1.yaml's operationIds. Path segments are encoded
// here, so callers pass plain values.
import { FullName, Login, MonorepoName } from "./ids.ts";
import { MonorepoList, MonorepoSummaryList } from "./monorepo.ts";
import { EventsPage } from "./feed.ts";
import { MetaHistory, MetaTree } from "./meta.ts";
import { NeedsPage } from "./needs.ts";
import { Me } from "./user.ts";

const query = (params: URLSearchParams): string => {
  const text = params.toString();

  return text === "" ? "" : `?${text}`;
};

const metaBase = (owner: Login, name: MonorepoName): string => `/v1/monorepos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/meta`;

/** GET /v1/user. A 401 here means: show the sign-in button. */
export const me = { path: "/v1/user", response: Me };

/** GET /v1/monorepos. */
export const listMonorepos = { path: "/v1/monorepos", response: MonorepoList };

/** GET /v1/monorepos?summary=1: the home's list, each with its line. */
export const listMonorepoSummaries = { path: "/v1/monorepos?summary=1", response: MonorepoSummaryList };

/** GET /v1/events: a page of the activity log. `inMonorepo` narrows to one `owner/name`; `cursor` is a page's `next`. */
export const listActivity = (cursor: string | null, inMonorepo: FullName | null) => {
  const params = new URLSearchParams();

  if (cursor !== null) params.set("cursor", cursor);

  if (inMonorepo !== null) params.set("in", inMonorepo);

  return { path: `/v1/events${query(params)}`, response: EventsPage };
};

/** The person's socket: the same path with `Upgrade: websocket`; frames are ActivityFrame. */
export const activitySocketPath = "/v1/events";

/** GET /v1/branches: "Needs you", open branches that are ready, conflicting or failing. */
export const listNeeds = (inMonorepo: FullName | null) => {
  const params = new URLSearchParams();

  if (inMonorepo !== null) params.set("in", inMonorepo);

  return { path: `/v1/branches${query(params)}`, response: NeedsPage };
};

/** GET .../meta/tree?dir=<folder>: one folder of root files (`""` is the root), with its subfolders on the first page. */
export const metaTree = (owner: Login, name: MonorepoName, dir: string, after: string | null) => {
  const params = new URLSearchParams({ dir });

  if (after !== null) params.set("after", after);

  return { path: `${metaBase(owner, name)}/tree${query(params)}`, response: MetaTree };
};

/** GET .../meta/history?path=<path>: a root file's versions, newest first; `before` is a version to page from. */
export const metaHistory = (owner: Login, name: MonorepoName, path: string, before: number | null) => {
  const params = new URLSearchParams({ path });

  if (before !== null) params.set("before", String(before));

  return { path: `${metaBase(owner, name)}/history${query(params)}`, response: MetaHistory };
};

/** GET .../meta/file?path=<path>: raw bytes (no schema); MetaFileHeaders reads its version headers. `version` null: now. */
export const metaFilePath = (owner: Login, name: MonorepoName, path: string, version: number | null): string => {
  const params = new URLSearchParams({ path });

  if (version !== null) params.set("version", String(version));

  return `${metaBase(owner, name)}/file${query(params)}`;
};

/** A large monorepo's activity socket: its event stream with `topics=feed` (frames: MonorepoFeedFrame). `feedSince`: the last `n` seen. */
export const monorepoFeedSocketPath = (owner: Login, name: MonorepoName, feedSince: number | null): string => {
  const params = new URLSearchParams({ topics: "feed" });

  if (feedSince !== null) params.set("feed_since", String(feedSince));

  return `/v1/monorepos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/events${query(params)}`;
};

/** GET /{owner}/{name}/raw/{path}?v=<version>: a root file's bytes (no schema; members only). `version` null: now. Path segments keep their slashes. */
export const metaRawPath = (owner: Login, name: MonorepoName, path: string, version: number | null): string => {
  const params = new URLSearchParams();

  if (version !== null) params.set("v", String(version));

  return `/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/raw/${path.split("/").map(encodeURIComponent).join("/")}${query(params)}`;
};
