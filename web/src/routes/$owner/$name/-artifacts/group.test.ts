// The upload's grouping (group.ts): node --test 'web/src/routes/$owner/$name/-artifacts/group.test.ts'
import assert from "node:assert/strict";
import { test } from "node:test";
import { group, type Picked } from "./group.ts";

const f = (path: string, size = 100, folder: string | null = null): Picked<string> => ({ path, file: path, size, folder });

const made = (out: ReturnType<typeof group<string>>) => out.groups.map((g) => ({ name: g.name, kind: g.kind, images: g.images.map((i) => i.path), problem: g.problem }));

test("one document takes every loose image, by its name", () => {
  const out = group([f("banner.html"), f("hero.png"), f("phone.png")], new Map());

  assert.deepEqual(made(out), [{ name: "banner.html", kind: "html", images: ["hero.png", "phone.png"], problem: null }]);
});

test("several documents are one artifact each; an image goes to the document that names it; the rest stand alone", () => {
  const texts = new Map([
    ["plan.md", "![timeline](timeline.png)"],
    ["banner.html", '<img src="hero.png">'],
  ]);

  const out = group([f("plan.md"), f("banner.html"), f("timeline.png"), f("hero.png"), f("other.webp")], texts);

  assert.deepEqual(made(out), [
    { name: "plan.md", kind: "markdown", images: ["timeline.png"], problem: null },
    { name: "banner.html", kind: "html", images: ["hero.png"], problem: null },
    { name: "other.webp", kind: "image", images: [], problem: null },
  ]);
});

test("images alone are one artifact each; other kinds are left out and named", () => {
  const out = group([f("a.png"), f("b.svg"), f("notes.txt")], new Map());

  assert.deepEqual(
    made(out).map((g) => g.name),
    ["a.png", "b.svg"],
  );
  assert.deepEqual(out.skipped, ["notes.txt"]);
});

test("a dropped folder is one artifact: its index.html, its images by their paths from it", () => {
  const out = group([f("site/index.html", 100, "site"), f("site/about.html", 100, "site"), f("site/img/hero.png", 100, "site"), f("site/img/phone.png", 100, "site")], new Map());

  assert.deepEqual(made(out), [{ name: "index.html", kind: "html", images: ["img/hero.png", "img/phone.png"], problem: null }]);
  assert.deepEqual(out.skipped, ["site/about.html"]);
});

test("a folder with one document takes it, wherever it sits; images outside its folder are left out", () => {
  const out = group([f("plan/docs/plan.md", 100, "plan"), f("plan/docs/img/a.png", 100, "plan"), f("plan/b.png", 100, "plan")], new Map());

  assert.deepEqual(made(out), [{ name: "plan.md", kind: "markdown", images: ["img/a.png"], problem: null }]);
  assert.deepEqual(out.skipped, ["plan/b.png"]);
});

test("a folder of images only: each its own artifact", () => {
  const out = group([f("shots/a.png", 100, "shots"), f("shots/b.png", 100, "shots")], new Map());

  assert.deepEqual(
    made(out).map((g) => [g.name, g.kind]),
    [
      ["a.png", "image"],
      ["b.png", "image"],
    ],
  );
});

test("the limits: the artifact's size, the document's, the file count, the name", () => {
  const MIB = 1024 * 1024;

  assert.match(group([f("big.png", 11 * MIB)], new Map()).groups[0]?.problem ?? "", /11 MiB in all: at most 10 MiB/);
  assert.match(group([f("long.md", 2 * MIB)], new Map()).groups[0]?.problem ?? "", /The document is 2 MiB: at most 1.5 MiB/);
  assert.match(group([f("plan.md"), ...Array.from({ length: 20 }, (_, i) => f(`i${i}.png`))], new Map()).groups[0]?.problem ?? "", /21 files: at most 20/);
  assert.match(group([f("my plan.md")], new Map()).groups[0]?.problem ?? "", /only letters, digits/);
});

test("two artifacts with one name in one drop: the second is refused", () => {
  const out = group([f("a/index.html", 100, "a"), f("b/index.html", 100, "b")], new Map());

  assert.deepEqual(
    out.groups.map((g) => g.problem),
    [null, "Another file in this drop has the same name"],
  );
});
