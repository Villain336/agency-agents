// Real git three-way merge of file contents, so the baselines' conflict behaviour is git's, not ours.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "bench-merge-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

/** Returns merged text, or null on conflict. `ours` = trunk, `theirs` = the agent's branch. */
export function gitMerge3(base: string, ours: string, theirs: string): string | null {
  writeFileSync(join(dir, "o"), ours);
  writeFileSync(join(dir, "b"), base);
  writeFileSync(join(dir, "t"), theirs);
  const r = spawnSync("git", ["merge-file", "-p", join(dir, "o"), join(dir, "b"), join(dir, "t")], { encoding: "utf8" });
  if (r.status === 0) return r.stdout;
  return null; // >0 = number of conflicts; <0 = error
}
