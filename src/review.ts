// Risk scoring and review policy. The goal is to spend scarce human attention only where it pays:
// most agent changes are low risk and land on evidence alone; a few need an agent reviewer; the
// riskiest need a human.

import { diffStat } from "./diff.ts";
import type { Risk } from "./semantic.ts";

export interface Policy {
  /** score below this lands without review (checks/verification still apply) */
  autoLandBelow: number;
  /** score at or above this requires a human approval */
  humanAbove: number;
  /** how many items a human reviewer is shown at once; the rest are deferred */
  attentionBudget: number;
  /** trunk-movement rule for check evidence: "paths" (default), "strict", or "train" (speculative queue) */
  evidence: "paths" | "strict" | "train";
}

export const DEFAULT_POLICY: Policy = { autoLandBelow: 30, humanAbove: 70, attentionBudget: 5, evidence: "paths" };

export type Tier = "low" | "medium" | "high";
export type Need = "none" | "any" | "human";

export interface RiskReport {
  score: number;
  tier: Tier;
  need: Need;
  reasons: string[];
}

export interface RiskInput {
  /** substantial work landed by other agents that this change would remove (author confirmed it) */
  reverts?: { rev: number; agent: string; path: string; lines: number }[];
  paths: string[];
  before: (p: string) => string | null;
  after: Record<string, string | null>;
  semantic: Risk[];
  merged: boolean;
  protectedPaths: string[];
  recentRejects: number;
  policy: Policy;
}

const SENSITIVE = /(^|\/)(auth|authn|authz|secrets?|crypto|security|payments?|billing|iam|permissions?|infra|terraform|deploy|migrations?|wrangler\.(toml|jsonc?)|dockerfile|package(-lock)?\.json|\.env[^/]*)(\.|\/|$)|\.github\/workflows\//i;
const TESTISH = /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[a-z]+$|_test\.(go|py)$/i;

const TEST_CASE = /^\s*(?:(?:test|it)(?:\.\w+)?\s*\(|def test_|func Test\w*\(|#\[test\])/;
/** Number of test cases in a test file (heuristic across JS/TS, Python, Go, Rust). */
export function countTests(text: string | null): number {
  return text === null ? 0 : text.split("\n").filter((l) => TEST_CASE.test(l)).length;
}

export function scoreRisk(i: RiskInput): RiskReport {
  const reasons: string[] = [];
  let score = 0;
  const add = (n: number, why: string) => {
    score += n;
    reasons.push(`+${n} ${why}`);
  };
  let lines = 0;
  let deletions = 0;
  for (const p of i.paths) {
    const after = i.after[p];
    const s = diffStat(i.before(p), after);
    lines += s.added + s.removed;
    if (after === null) deletions++;
  }
  if (lines >= 10) add(Math.min(30, Math.floor(lines / 10)), `${lines} changed lines`);
  if (i.paths.length > 1) add(Math.min(10, i.paths.length * 2), `${i.paths.length} files`);
  const sensitive = i.paths.filter((p) => SENSITIVE.test(p));
  if (sensitive.length) add(30, `sensitive path(s): ${sensitive.join(", ")}`);
  const prot = i.paths.filter((p) => i.protectedPaths.some((r) => p.startsWith(r)));
  if (prot.length) add(25, `protected path(s): ${prot.join(", ")}`);
  if (i.semantic.length) add(Math.min(30, 15 * i.semantic.length), `${i.semantic.length} interaction(s) with concurrent work`);
  if (deletions) add(Math.min(20, 10 * deletions), `${deletions} file deletion(s)`);
  if (i.merged) add(5, "auto-merged with concurrent changes");
  // Deleting tests makes every check meaningless, so it is treated as risky in itself
  let testsRemoved = 0;
  for (const p of i.paths) if (TESTISH.test(p)) testsRemoved += Math.max(0, countTests(i.before(p)) - countTests(i.after[p]));
  if (testsRemoved) add(30, `removes ${testsRemoved} test case(s)`);
  const touchesCode = i.paths.some((p) => !TESTISH.test(p) && /\.(ts|tsx|js|jsx|py|go|rs|java|rb|c|cc|cpp)$/.test(p));
  if (touchesCode && !i.paths.some((p) => TESTISH.test(p))) add(10, "code changed without tests");
  for (const v of i.reverts ?? []) add(40, `removes ${v.lines} lines of work landed by ${v.agent} in r${v.rev}`);
  if (i.recentRejects) add(10, "author has recently rejected changes");
  score = Math.min(100, score);
  let tier: Tier = score >= i.policy.humanAbove ? "high" : score < i.policy.autoLandBelow ? "low" : "medium";
  if ((prot.length || testsRemoved || i.reverts?.length) && tier === "low") tier = "medium"; // protected paths and removed tests always get a reviewer
  const need: Need = tier === "high" ? "human" : tier === "medium" ? "any" : "none";
  return { score, tier, need, reasons };
}
