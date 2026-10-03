// The web's writes. Each is a POST the Worker checks for Pando's own Origin.
import { post } from "./client";
import type { MonorepoRef } from "./names";
import { Restored, SignedOut } from "./pending";
import { restorePath } from "./queries";

/** Ends this browser's session, then WorkOS's (its logout page returns to /). */
export async function signOut(): Promise<void> {
  const out = await post(SignedOut, "/v1/logout", {});
  location.assign(out.logout_url);
}

/** Writes a root file back as it was at `version`, as a new version every machine receives. */
export const restore = (m: MonorepoRef, path: string, version: number) => post(Restored, restorePath(m), { path, version, machine: "the web" });
