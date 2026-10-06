// The fold rule's edge cases (rules.ts): node --test web/src/conversation/rules.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { failedVerb, foldText, presentVerb, stepWords } from "./rules.ts";

const step = (tool: string, args: Record<string, string> = {}) => ({ tool, args });

test("one object is named, more are counted, in the order first seen", () => {
  assert.equal(foldText([step("read", { path: "a.ts" }), step("bash", { command: "npm test" }), step("read", { path: "b.ts" })]), "Read 2 files, Ran npm test");
  assert.equal(foldText([step("edit", { path: "README.md" }), step("edit", { path: "README.md" })]), "Edited 2 files");
});

test("at most three verbs, then and more", () => {
  assert.equal(foldText([step("read", { path: "a" }), step("bash", { command: "ls" }), step("grep", { pattern: "x" }), step("merge")]), "Read a, Ran ls, Searched for x, and more");
});

test("a command is its first line, cut at 60 characters", () => {
  const long = `${"x".repeat(70)}\nsecond line`;

  assert.equal(stepWords(step("bash", { command: long })).object, `${"x".repeat(60)}…`);
  assert.equal(stepWords(step("bash", { command: "git status\ngit log" })).object, "git status");
});

test("Pando's tools and unknown tools", () => {
  assert.equal(foldText([step("issue", { number: "41" })]), "Read #41");
  assert.equal(foldText([step("post_review", { verdict: "request_changes" })]), "Reviewed this branch: request changes");
  assert.equal(foldText([step("start_branch", { name: "theme-cache" })]), "Started branch theme-cache");
  assert.equal(foldText([step("list_files")]), "Listed the root");
  assert.equal(foldText([step("mystery_tool")]), "mystery_tool");
});

test("failed and running verbs", () => {
  assert.equal(failedVerb("Ran"), "Failed to run");
  assert.equal(presentVerb("Edited"), "Editing");
  assert.equal(presentVerb("mystery_tool"), "mystery_tool");
});
