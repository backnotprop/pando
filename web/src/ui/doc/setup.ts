// The one place Pando configures @plannotator/ui (configurePlannotatorUI),
// imported first by every lazy module that renders its components
// (PlannotatorDoc.tsx, artifact/Review.tsx), so the seams are in place before
// anything of the package renders (its HANDOFF.md: ordering is load-bearing).
// Settings stay in memory (no cookies, nothing in localStorage); the identity
// is the signed-in person, set by the artifact page (setPerson); no agent
// tools, no Plannotator server.
import { useTheme } from "@plannotator/ui/components/ThemeProvider";
import { configurePlannotatorUI } from "@plannotator/ui/configure";
import DOMPurify from "dompurify";
import { useEffect } from "react";
import { useShownMode } from "../theme";

const settings = new Map<string, string>();

/** The signed-in person's login: the author the composer stamps, and "(me)" on their cards. Empty on a read-only file page. */
let person = "";

export const setPerson = (login: string) => {
  person = login;
};

// Code fences take the code view's colours (ui/syntax.ts, the --diffs-token-*
// palette in theme.css), not a stock Shiki theme: once that theme is
// registered, every fence asks for it; before, the viewer keeps its default.
let fenceTheme: string | undefined;

const remote = /^(https?:|data:|blob:|mailto:)/i;

/** `path` from the file at `base` (a raw URL), as a raw URL at the same `?ref=`; web links pass through. */
function rawFrom(path: string, base?: string): string {
  if (!base || remote.test(path)) return path;
  const from = new URL(base, location.origin);
  const url = new URL(path, from);
  const ref = from.searchParams.get("ref");

  if (url.origin !== location.origin) return path;

  return url.pathname + (ref ? `?ref=${encodeURIComponent(ref)}` : "");
}

configurePlannotatorUI({
  webmcp: { enabled: false },
  storageBackend: {
    getItem: (key) => settings.get(key) ?? null,
    setItem: (key, value) => void settings.set(key, value),
    removeItem: (key) => void settings.delete(key),
  },
  identityProvider: { getIdentity: () => person, isCurrentUser: (author) => !!person && author === person, isEditable: () => false },
  imageSrcResolver: rawFrom,
  docPreviewFetcher: () => Promise.resolve(null),
  // KaTeX and its stylesheet load together, on a document's first formula.
  mathRendererLoader: () => Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([katex]) => katex.default),
  fenceTheme: () => fenceTheme,
});

export { remote };

// A document with a fence waits for Pando's theme to be registered (Pierre,
// which colours the fence, loads then anyway); one without never loads it.
let syntax: Promise<void> | null = null;

export const pandoFences = () =>
  (syntax ??= import("../syntax").then(
    ({ SYNTAX_THEME }) => {
      fenceTheme = SYNTAX_THEME;
    },
    // If the chunk cannot load (a deploy replaced it), the document still shows; its fences stay plain.
    () => undefined,
  ));

/** Keeps the viewer's mode on Pando's, also when the theme changes in the name menu (its code colours and diagrams follow it). */
export function FollowPando() {
  const { mode, setMode } = useTheme();
  const want = useShownMode();

  useEffect(() => {
    if (mode !== want) setMode(want);
  }, [mode, want, setMode]);

  return null;
}

/** An HTML file's text with every script removed (elements, handlers, javascript: links); its styles stay. */
export const scriptless = (html: string) => DOMPurify.sanitize(html, { WHOLE_DOCUMENT: true, ADD_TAGS: ["style"] });
