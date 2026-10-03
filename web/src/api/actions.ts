// The web's writes. Each is a POST the Worker checks for Pando's own Origin.
import { post } from "./client";
import type { MonorepoRef } from "./names";
import { Routes } from "@pando/contract";

/** Ends this browser's session, then WorkOS's (its logout page returns to /). */
export async function signOut(): Promise<void> {
  const out = await post(Routes.logout.response, Routes.logout.path, {});
  location.assign(out.logout_url);
}

/** Writes a root file back as it was at `version`, as a new version every machine receives. */
export const restore = (m: MonorepoRef, path: string, version: number) => {
  const route = Routes.restore(m.owner, m.name);

  return post(route.response, route.path, { path, version, machine: "the web" });
};
