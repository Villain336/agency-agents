import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, makeOps, seedFiles, lostUpdates } from "../bench/workload.ts";
import { gitMerge3 } from "../bench/gitmerge.ts";

test("workload is deterministic and every op changes its file", () => {
  const o = { ...DEFAULTS, agents: 40 };
  const a = makeOps(o), b = makeOps(o);
  assert.deepEqual(a.map((x) => [x.path, x.marker, x.workSec]), b.map((x) => [x.path, x.marker, x.workSec]));
  const files = seedFiles(o);
  for (const op of a) assert.ok(op.apply(files[op.path]).includes(op.marker), op.marker);
});

test("applying every op serially loses nothing", () => {
  const o = { ...DEFAULTS, agents: 80, skew: 1.3 };
  const files = seedFiles(o);
  for (const op of makeOps(o)) files[op.path] = op.apply(files[op.path]);
  assert.equal(lostUpdates(files, makeOps(o)), 0);
});

test("git merge-file: clean merge, and conflict on the same line", () => {
  assert.equal(gitMerge3("a\nb\nc\nd\ne\n", "A\nb\nc\nd\ne\n", "a\nb\nc\nd\nE\n"), "A\nb\nc\nd\nE\n");
  assert.equal(gitMerge3("a\nb\nc\n", "a\nX\nc\n", "a\nY\nc\n"), null);
});

test("merge engine agrees with real git on random concurrent edits (differential fuzz)", async () => {
  const { fuzz } = await import("../bench/fuzz-merge.ts");
  const s = fuzz(600, 11);
  const agree = (s.bothClean - s.cleanDiffer + s.bothConflict) / s.cases;
  assert.ok(agree >= 0.97, `agreement with git was ${(agree * 100).toFixed(1)}%`);
  // Weave must not be meaningfully more permissive than git
  assert.ok(s.weaveCleanGitConflict / s.cases <= 0.03, `weave merged ${s.weaveCleanGitConflict} cases git rejected`);
});

test("wv cat writes only file content: nothing on stderr that a redirect could capture", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../scripts/wv.ts", import.meta.url), "utf8");
  const cat = src.slice(src.indexOf('case "cat"'), src.indexOf('case "put"'));
  assert.ok(!/console\.error|stderr/.test(cat), "cat must not print anything besides the file");
});
