import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/repo.ts";
import { exportFastImport } from "../src/export.ts";

test("export round-trips through git fast-import", () => {
  const r = new Repo();
  r.seed({ "a.txt": "héllo\nworld", "b.txt": "gone" }, "initial");
  r.open({ id: "s", agent: "Bot One", goal: "edit" });
  r.write("s", "a.txt", "héllo\nweave");
  r.write("s", "b.txt", null);
  r.submit("s");
  const dir = mkdtempSync(join(tmpdir(), "weave-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "fast-import", "--quiet"], { input: exportFastImport(r.s) });
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a]).toString();
  assert.equal(git("rev-list", "--count", "main").trim(), "2");
  assert.equal(git("show", "main:a.txt"), "héllo\nweave");
  assert.equal(git("ls-tree", "--name-only", "main").trim(), "a.txt");
  assert.match(git("log", "-1", "--format=%an"), /Bot One/);
});
