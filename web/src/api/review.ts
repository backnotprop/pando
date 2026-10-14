// Risk-based review from the web (docs/risk-review/DESIGN.md): a person's
// approval on a branch's head, and a project's switch and thresholds.
import { type RepoName, Routes } from "@pando/contract";
import { write } from "./client";
import type { JsonBody } from "./json";
import type { MonorepoRef } from "./names";

/** Approve the head on screen: a person's approval passes the review a branch's risk calls for. */
export const approve = (m: MonorepoRef, repo: RepoName, branch: string, head: string) => write(Routes.postReview(m.owner, m.name, repo, branch), { verdict: "approve", head });

/** Risk-based review on or off, and its thresholds (owners). */
export const setRepoReview = (m: MonorepoRef, repo: RepoName, review: JsonBody) => write(Routes.setRepoReview(m.owner, m.name, repo), { review });
