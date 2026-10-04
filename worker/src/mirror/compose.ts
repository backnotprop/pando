// The whole repository to one GitHub repository: the files outside projects/
// at the top and each project's main under projects/<name>/, one commit on
// GitHub per change. Two kinds of push per run:
//   1. each changed source's commits, through the pipe, to a hidden ref
//      (refs/pando/<repo>), so every tree and file the new state names is on
//      GitHub, with each source's own history;
//   2. the composed commits, written here with gitwrite's encoders from the
//      sources' root trees (readCommit, readTree: no file is read), as one
//      small pack to main.
// Commit ids differ from Pando's; author, author time and message are the
// source commit's, the committer is Pando, and a trailer names the source.

import type { Env } from "../env";
import { withRepo } from "../monorepo/artifacts";
import { buildPack } from "../gitwrite/pack";
import { commitObject, TREE_MODE, treeObject, type GitObject, type TreeEntry } from "../gitwrite/objects";
import { pushPack, ZERO } from "./pipe";
import { pandoMain, refusalOf, sendSource, type Connected } from "./run";
import type { MirrorJob, MirrorResult, MirrorSource } from "./types";

/** Where each source's commits are kept on GitHub (not a branch, so GitHub's pages do not show them). */
export const hiddenRef = (repo: string) => `refs/pando/${repo}`;

const COMMITTER = { name: "Pando", email: "mirror@pando.invalid" };

interface SourceHead {
  s: MirrorSource;
  sha: string;
  tree: string;
  author: { name: string; email: string; date: Date };
  message: string;
}

async function headOf(env: Env, s: MirrorSource, sha: string): Promise<SourceHead> {
  const c = await withRepo(env, s.ref.artifacts_name, (r) => r.readCommit(sha));

  if (!c) throw new Error(`${s.repo}'s main (${sha.slice(0, 12)}) could not be read`);

  return { s, sha, tree: c.treeHash, author: { name: c.author.name, email: c.author.email, date: new Date(c.authoredAt * 1000) }, message: c.message };
}

/** A tree from entries, with the objects it adds. */
async function tree(entries: TreeEntry[], out: GitObject[]): Promise<string> {
  const t = await treeObject(entries);
  out.push(t);

  return t.sha;
}

/**
 * The root tree for one state: the files outside projects/ (their root's
 * entries), with `projects/` holding each project's root tree at its path.
 */
async function rootTree(env: Env, heads: Map<string, SourceHead>, out: GitObject[], read: Map<string, TreeEntry[]>): Promise<string> {
  const entriesOf = async (s: MirrorSource, treeSha: string): Promise<TreeEntry[]> => {
    const hit = read.get(treeSha);

    if (hit) return hit;
    const got = (await withRepo(env, s.ref.artifacts_name, (r) => r.readTree(treeSha))) ?? [];
    const list = got.map((e) => ({ name: e.name, mode: e.mode, hash: e.hash }));
    read.set(treeSha, list);

    return list;
  };

  let top: TreeEntry[] = [];
  const meta = [...heads.values()].find((h) => h.s.meta);

  if (meta) top = await entriesOf(meta.s, meta.tree);
  // A nested tree for every path under projects/ (projects/<name>, or deeper).
  const dirs = new Map<string, TreeEntry[]>();

  const dirOf = async (path: string): Promise<TreeEntry[]> => {
    let d = dirs.get(path);

    if (!d) {
      const shared = path === "projects" && meta ? top.find((e) => e.name === "projects" && e.mode === TREE_MODE) : undefined;
      d = shared && meta ? [...(await entriesOf(meta.s, shared.hash))] : [];
      dirs.set(path, d);
    }

    return d;
  };

  for (const h of heads.values()) {
    if (h.s.meta || !h.s.path.startsWith("projects/")) continue;
    const parts = h.s.path.split("/");
    const name = parts.pop()!;
    const d = await dirOf(parts.join("/"));
    const at = d.findIndex((e) => e.name === name);
    const entry = { name, mode: TREE_MODE, hash: h.tree };

    if (at >= 0) d[at] = entry;
    else d.push(entry);
  }

  // Deepest first, so a parent's entry points at its finished child.
  for (const path of [...dirs.keys()].sort((a, b) => b.split("/").length - a.split("/").length)) {
    if (path === "projects") continue;
    const sha = await tree(dirs.get(path)!, out);
    const parts = path.split("/");
    const name = parts.pop()!;
    const parent = await dirOf(parts.join("/"));
    const at = parent.findIndex((e) => e.name === name);
    const entry = { name, mode: TREE_MODE, hash: sha };

    if (at >= 0) parent[at] = entry;
    else parent.push(entry);
  }

  if (dirs.has("projects")) {
    const sha = await tree(dirs.get("projects")!, out);
    top = [...top.filter((e) => e.name !== "projects"), { name: "projects", mode: TREE_MODE, hash: sha }];
  }

  return tree(top, out);
}

const trailer = (h: SourceHead) => `Pando-Commit: ${h.s.meta ? "/" : h.s.path} ${h.sha}`;

export async function composeRun(env: Env, job: MirrorJob, c: Connected): Promise<Omit<MirrorResult, "ms">> {
  const mains = await Promise.all(job.sources.map(async (s) => ({ s, sha: await pandoMain(env, s) })));
  const present = mains.filter((m): m is { s: MirrorSource; sha: string } => m.sha !== null);
  const main = "refs/heads/main";
  // Start over (no parent) when GitHub's main is not the last composed commit: a new or emptied repository, or one someone pushed over.
  const fresh = !job.composed || c.refs.get(main) !== job.composed;
  const changed = present.filter((m) => fresh || job.sent[m.s.repo] !== m.sha);

  if (!present.length || (!changed.length && !fresh)) return { ok: true, sent: job.sent, composed: job.composed, last_sha: job.composed, problem: null, pushes: 0 };
  let pushes = 0;

  // 1. Each changed source's commits, to its hidden ref.
  for (const m of present) {
    const ref = hiddenRef(m.s.repo);

    if (c.refs.get(ref) === m.sha) continue;
    const answer = await sendSource(env, job.monorepo, c, m.s, m.sha, ref);
    pushes++;
    const problem = refusalOf(answer, ref);

    if (problem) return { ok: false, sent: job.sent, composed: job.composed, last_sha: null, problem, pushes };
    c.refs.set(ref, m.sha);
  }

  // 2. The composed commits: one per changed source, in the order its change was made (all at once when starting over).
  const heads = new Map<string, SourceHead>();
  const all = await Promise.all(present.map((m) => headOf(env, m.s, m.sha)));
  const objects: GitObject[] = [];
  const read = new Map<string, TreeEntry[]>();
  let parent: string | null = fresh ? null : job.composed;

  if (fresh) {
    for (const h of all) heads.set(h.s.repo, h);

    const commit = await commitObject({
      tree: await rootTree(env, heads, objects, read),
      parents: [],
      author: COMMITTER,
      committer: COMMITTER,
      message: `Mirror of ${job.label} from Pando\n\n${all.map(trailer).join("\n")}`,
    });

    objects.push(commit);
    parent = commit.sha;
  } else {
    // The state GitHub has: each source as last sent.
    for (const h of all) if (job.sent[h.s.repo] === h.sha) heads.set(h.s.repo, h);
    const unchanged = present.filter((m) => !heads.has(m.s.repo) && job.sent[m.s.repo]).map((m) => ({ s: m.s, sha: job.sent[m.s.repo] }));

    for (const h of await Promise.all(unchanged.map((m) => headOf(env, m.s, m.sha)))) heads.set(h.s.repo, h);

    for (const h of all.filter((x) => job.sent[x.s.repo] !== x.sha).sort((a, b) => a.author.date.getTime() - b.author.date.getTime())) {
      heads.set(h.s.repo, h);

      const commit = await commitObject({
        tree: await rootTree(env, heads, objects, read),
        parents: parent ? [parent] : [],
        author: h.author,
        committer: { ...COMMITTER, date: new Date() },
        message: `${h.message}\n\n${trailer(h)}`,
      });

      objects.push(commit);
      parent = commit.sha;
    }
  }

  const unique = [...new Map(objects.map((o) => [o.sha, o])).values()];
  const answer = await pushPack(c.remote, [{ old: c.refs.get(main) ?? ZERO, new: parent!, ref: main }], await buildPack(unique));
  pushes++;
  const problem = refusalOf(answer, main);
  const sent = Object.fromEntries(present.map((m) => [m.s.repo, m.sha]));

  return problem ? { ok: false, sent: job.sent, composed: job.composed, last_sha: null, problem, pushes } : { ok: true, sent, composed: parent, last_sha: parent, problem: null, pushes };
}
