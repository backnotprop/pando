// HTML someone else wrote (a CI build's annotations), shown safely: the
// browser parses it into a detached document, and only an allowlist of plain
// tags is rebuilt as React elements. No attribute survives but a link's
// http(s) href, so nothing in it can run, load or restyle the page; any other
// tag gives up its text, and scripts, styles, images and frames go entirely.
import { createElement, type ReactNode } from "react";

const KEEP = new Set([
  "p",
  "br",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "del",
  "ins",
  "sub",
  "sup",
  "small",
  "mark",
  "code",
  "pre",
  "kbd",
  "samp",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "blockquote",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "details",
  "summary",
  "span",
  "div",
  "a",
]);

const DROP = new Set([
  "script",
  "style",
  "iframe",
  "frame",
  "object",
  "embed",
  "img",
  "picture",
  "video",
  "audio",
  "svg",
  "math",
  "template",
  "noscript",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "link",
  "meta",
  "head",
  "title",
]);

/** A link's href when it is http or https; anything else (javascript:, data:) is dropped. */
function safeHref(href: string | null): string | null {
  if (!href) return null;

  try {
    const url = new URL(href, "https://invalid.example");

    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function rebuild(node: Node, key: number): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;

  if (!(node instanceof Element)) return null;
  const tag = node.tagName.toLowerCase();

  if (DROP.has(tag)) return null;
  const children = [...node.childNodes].map(rebuild);

  if (!KEEP.has(tag)) return children;

  if (tag === "a") {
    const href = safeHref(node.getAttribute("href"));

    return href ? createElement("a", { key, href, target: "_blank", rel: "noopener noreferrer nofollow" }, ...children) : children;
  }

  return createElement(tag, { key }, ...children);
}

export function SafeHtml({ html, className }: { html: string; className?: string }) {
  const body = new DOMParser().parseFromString(html, "text/html").body;

  return <div className={className}>{[...body.childNodes].map(rebuild)}</div>;
}
