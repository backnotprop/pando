// The home's What's new (decisions/RULINGS.md): the newest changelog entry,
// emitted at build for the web app, which fetches it at runtime. The
// changelog's first `##` is the newest date (YYYY-MM-DD) and the first `###`
// under it the newest entry. public/_headers gives this file its cache and
// cross-origin headers.
import type { APIRoute } from "astro";
import { getEntry, render } from "astro:content";
import { withBase } from "@cloudflare/nimbus-docs/runtime";

export const prerender = true;

export const GET: APIRoute = async ({ site }) => {
  const changelog = await getEntry("docs", "changelog");

  if (!changelog) throw new Error("whats-new.json: no src/content/docs/changelog.mdx");

  const { headings } = await render(changelog);
  const day = headings.findIndex((h) => h.depth === 2);
  const entry = headings.slice(day + 1).find((h) => h.depth <= 3);

  if (day < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(headings[day].text)) throw new Error("whats-new.json: the changelog's first ## heading must be a date, YYYY-MM-DD");

  if (!entry || entry.depth !== 3) throw new Error(`whats-new.json: no ### entry under ${headings[day].text}`);

  const link = new URL(withBase(`/changelog/#${entry.slug}`, import.meta.env.BASE_URL), site).href;

  return Response.json({ date: headings[day].text, headline: entry.text, link });
};
