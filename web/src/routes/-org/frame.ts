// The org an /orgs/{org}/... page is about (its frame route found it).
import type { OrgProfile } from "@pando/contract";
import { useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, notFound } from "@tanstack/react-router";
import { ownerQuery } from "../../api/orgs";

const frame = getRouteApi("/orgs/$org");

export function useOrg(): OrgProfile {
  const { org } = frame.useRouteContext();
  const who = useSuspenseQuery(ownerQuery(org)).data;

  if (who.type !== "org") throw notFound();

  return who;
}
