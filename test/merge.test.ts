import { test } from "node:test";
import assert from "node:assert/strict";
import { merge3, resolveSegments } from "../src/merge.ts";

const L = (...l: string[]) => l.join("\n");

test("non-overlapping edits merge cleanly", () => {
  const base = L("a", "b", "c", "d", "e");
  const r = merge3(base, L("A", "b", "c", "d", "e"), L("a", "b", "c", "d", "E"));
  assert.equal(r.conflicts, 0);
  assert.equal(r.text, L("A", "b", "c", "d", "E"));
});

test("identical edits on both sides do not conflict", () => {
  const r = merge3("a\nb", "a\nX", "a\nX");
  assert.equal(r.conflicts, 0);
  assert.equal(r.text, "a\nX");
});

test("overlapping different edits conflict and can be resolved", () => {
  const r = merge3(L("a", "b", "c"), L("a", "ours", "c"), L("a", "theirs", "c"));
  assert.equal(r.conflicts, 1);
  assert.equal(resolveSegments(r.segments, ["both"]), L("a", "ours", "theirs", "c"));
  assert.equal(resolveSegments(r.segments, [{ text: "merged" }]), L("a", "merged", "c"));
});

test("insertions at different places merge", () => {
  const r = merge3(L("a", "b", "c"), L("x", "a", "b", "c"), L("a", "b", "c", "y"));
  assert.equal(r.text, L("x", "a", "b", "c", "y"));
});

test("insertions at the same point conflict", () => {
  const r = merge3("a\nb", "a\nX\nb", "a\nY\nb");
  assert.equal(r.conflicts, 1);
});

test("delete on one side, untouched elsewhere", () => {
  const r = merge3(L("a", "b", "c", "d"), L("a", "c", "d"), L("a", "b", "c", "D"));
  assert.equal(r.text, L("a", "c", "D"));
});
