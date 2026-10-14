// Risk-based review from the web (docs/risk-review/DESIGN.md): a person's
// approval on a branch's head, a project's switch and thresholds, and a
// guided review's snapshot.
import { type ChangedFile, type RepoName, Routes } from "@pando/contract";
import { queryOptions } from "@tanstack/react-query";
import { artifactsKey, fileHref } from "./artifacts";
import { getText, write } from "./client";
import type { JsonBody } from "./json";
import type { MonorepoRef } from "./names";

/** Approve the head on screen: a person's approval passes the review a branch's risk calls for. */
export const approve = (m: MonorepoRef, repo: RepoName, branch: string, head: string) => write(Routes.postReview(m.owner, m.name, repo, branch), { verdict: "approve", head });

/** Risk-based review on or off, and its thresholds (owners). */
export const setRepoReview = (m: MonorepoRef, repo: RepoName, review: JsonBody) => write(Routes.setRepoReview(m.owner, m.name, repo), { review });

/** One file of a guided review's section: its one-sentence summary over its diff (null: no lines in the guide's patch). */
export interface GuideFile {
  path: string;
  summary: string | null;
  file: ChangedFile | null;
}

/** A section, in reading order; the last may be "Everything else", the files the guide did not place. */
export interface GuidePart {
  title: string;
  /** Markdown. */
  overview: string;
  files: GuideFile[];
}

/** A guided review, read: what the tab draws. */
export interface GuideRead {
  title: string;
  intent: string;
  /** The head it was written for, and the model that wrote it. */
  head: string | null;
  model: string | null;
  parts: GuidePart[];
}

// A glob, not import(): the reader imports @plannotator/core's sources, which web's typecheck would check under its
// noUncheckedIndexedAccess; tsconfig.doc.json checks it with the package's own strictness (as ui/doc/Doc.tsx does).
const [reader] = Object.values(import.meta.glob<{ readGuide: (text: string) => GuideRead }>("../ui/doc/guide.ts"));

/**
 * A guided review as data: Plannotator's GuideSnapshotV1, the guide artifact's second file (worker/src/review/guide.ts),
 * checked by Plannotator's own parser (ui/doc/guide.ts). A version never changes.
 */
export const guideQuery = (m: MonorepoRef, guide: { artifact: string; version: number; snapshot: string }) =>
  queryOptions({
    queryKey: [...artifactsKey(m), "guide", guide.artifact, guide.version],
    staleTime: Infinity,
    queryFn: async () => {
      const [file, read] = await Promise.all([getText(fileHref(m, guide.artifact, guide.version, guide.snapshot)), reader ? reader() : Promise.reject(new Error("ui/doc/guide.ts is missing"))]);

      return read.readGuide(file.text ?? "");
    },
  });
