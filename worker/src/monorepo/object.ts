// Monorepo object: branches, reviews, checks, merges, the worktree list.
// Owned by the server-git lane.
import { DurableObject } from "cloudflare:workers";
export class MonorepoObject extends DurableObject {}
