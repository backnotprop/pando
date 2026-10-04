// A person's profile: their contributions (the graph and the timeline, as
// this viewer may see them) and one day of it, and Edit profile's write.
// Keys: ["contrib", login, tz] the year, ["contrib", login, tz, day] a day,
// so the live socket's `contributed` frame refreshes them all at once.
import { type Login, Routes } from "@pando/contract";
import { queryOptions } from "@tanstack/react-query";
import { get, write } from "./client";

/** The viewer's time zone, as the API takes it: minutes east of UTC. */
export const viewerTz = (): number => -new Date().getTimezoneOffset();

/** The year: the graph's days, the monorepos, the months. */
export const contributionsQuery = (login: Login, tz: number) =>
  queryOptions({
    queryKey: ["contrib", login, tz],
    queryFn: () => {
      const route = Routes.getContributions(login, tz);

      return get(route.response, route.path);
    },
    staleTime: 60_000,
  });

/** One day's timeline (a click on a square). */
export const contributionDayQuery = (login: Login, tz: number, day: string) =>
  queryOptions({
    queryKey: ["contrib", login, tz, day],
    queryFn: () => {
      const route = Routes.getContributionDay(login, tz, day);

      return get(route.response, route.path);
    },
    staleTime: 60_000,
  });

/** The server's limits on Edit profile (worker/src/accounts/profile-routes.ts PROFILE_LIMITS), in characters; links are https URLs. */
export const PROFILE_LIMITS = { name: 100, bio: 160, location: 100, links: 4, link: 2048 } as const;

/** Edit profile's save: an empty field is cleared, empty links are dropped. */
export const updateProfile = (fields: { name: string; bio: string; location: string; links: readonly string[] }) =>
  write(Routes.updateProfile, {
    name: fields.name.trim() || null,
    bio: fields.bio.trim() || null,
    location: fields.location.trim() || null,
    links: fields.links.map((l) => l.trim()).filter(Boolean),
  });
