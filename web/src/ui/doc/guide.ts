// A guided review's snapshot (Plannotator's GuideSnapshotV1, the guide
// artifact's guided-review.json), read with Plannotator's own parsers into
// what the Guided review tab draws (-project/Guide.tsx): each section with
// its files' patches, cut from the patch the guide was written against, in
// the shape Files changed's list takes. Loaded on first use (api/review.ts).
import type { ChangedFile } from "@pando/contract";
import { type DiffFile, parseDiffToFiles } from "@plannotator/core/diff-files";
import { parseGuideSnapshotJson } from "@plannotator/core/guide-format";
import type { GuideFile, GuidePart, GuideRead } from "../../api/review";

/** A file of the guide's patch, as Files changed's list takes it (no blobs: the patch is all the guide kept). */
function changedOf(f: DiffFile): ChangedFile {
  const file: ChangedFile = {
    path: f.path,
    status: f.status,
    old_sha: null,
    new_sha: null,
    old_mode: null,
    new_mode: null,
    binary: false,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch.endsWith("\n") ? f.patch : `${f.patch}\n`,
  };

  return f.oldPath ? { ...file, old_path: f.oldPath } : file;
}

/** The snapshot's text, read; throws when it is not a v1 snapshot. */
export function readGuide(text: string): GuideRead {
  const read = parseGuideSnapshotJson(text);

  if (!read.ok) throw new Error(`it is not a guided review (${read.error.path}: ${read.error.message})`);
  const s = read.value;
  const byPath = new Map(parseDiffToFiles(s.review.rawPatch).map((f) => [f.path, changedOf(f)]));
  const file = (path: string, summary: string | null): GuideFile => ({ path, summary, file: byPath.get(path) ?? null });
  const parts: GuidePart[] = s.guide.sections.map((x) => ({ title: x.title, overview: x.overview, files: x.diffs.map((d) => file(d.file, d.summary?.trim() || null)) }));
  const rest = s.guide.unplacedFiles ?? [];

  if (rest.length) parts.push({ title: "Everything else", overview: "", files: rest.map((p) => file(p, null)) });

  return { title: s.guide.title, intent: s.guide.intent, head: s.source.headSha ?? null, model: s.generator?.model ?? null, parts };
}
