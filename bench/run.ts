// Runs the benchmark sweeps and writes bench/results.json and bench/results.md.
//   node bench/run.ts [--quick]
import { writeFileSync } from "node:fs";
import { fuzz } from "./fuzz-merge.ts";
import { evalDetector } from "./detector.ts";
import { simPushRace, simQueue, simWeave, type Result, type SimParams } from "./sim.ts";
import { DEFAULTS } from "./workload.ts";

const quick = process.argv.includes("--quick");
const AGENTS = quick ? [20, 50] : [20, 50, 100, 200];
const SKEWS = [0, 1.0];
const CONC = quick ? [5] : [1, 5, 20];
const PUSHRACE_MAX = 100; // each push-race run does O(N^2) real `git merge-file` spawns

interface Row { agents: number; skew: number; concurrency: number | null; results: Omit<Result, "landings">[] }
const rows: Row[] = [];
const strip = ({ landings: _l, ...r }: Result) => r;
const base: Omit<SimParams, "workload" | "concurrency"> = { ciSec: 60, reworkSec: 15, verifySec: 10 };
const t0 = Date.now();

for (const skew of SKEWS) for (const n of AGENTS) {
  const workload = { ...DEFAULTS, agents: n, skew };
  const pushRace = n <= PUSHRACE_MAX ? strip(simPushRace({ ...base, workload, concurrency: 1 })) : undefined;
  for (const c of CONC) {
    const p = { ...base, workload, concurrency: c };
    rows.push({ agents: n, skew, concurrency: c, results: [...(pushRace ? [pushRace] : []), strip(simQueue(p)), strip(simWeave(p, "train"))] });
    console.error(`done N=${n} skew=${skew} C=${c} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
}

const detector = evalDetector(200);
const fz = fuzz(quick ? 400 : 3000, 1);
const { examples: _e, differing: _d, ...fuzzStats } = fz;
const out = { generatedAt: new Date().toISOString(), params: { ...base, note: "virtual time; build concurrency C is the queue batch size and the number of Weave runners" }, rows, detector, mergeAgreement: { ...fuzzStats, agreement: (fz.bothClean - fz.cleanDiffer + fz.bothConflict) / fz.cases } };
writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify(out, null, 2));

const f = (r: Omit<Result, "landings">) => `| ${r.policy} | ${r.makespanSec} | ${r.ciRuns} | ${r.retries} | ${r.conflicts} | ${r.p50Sec} | ${r.p95Sec} | ${r.lostUpdates} |`;
let md = "# Weave benchmark results\n\nVirtual-time simulation: CI = 60s, rework after a conflict = 15s, agents take 5-60s to produce a change. ";
md += "Baselines use real `git merge-file`; Weave runs its actual `Repo` (train mode, real merge and semantic gate). Build concurrency C is the merge-queue batch size and the number of Weave runners.\n";
for (const r of rows) {
  md += `\n### ${r.agents} agents, hot-spot skew ${r.skew}, build concurrency ${r.concurrency}\n\n| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |\n|---|---|---|---|---|---|---|---|\n`;
  md += r.results.map(f).join("\n") + "\n";
}
md += "\n## Semantic-interaction detector (synthetic ground truth)\n\n| case | should flag | flagged | rate |\n|---|---|---|---|\n";
md += detector.map((d) => `| ${d.category} | ${d.shouldFlag ? "yes" : "no"} | ${d.flagged}/${d.cases} | ${(d.rate * 100).toFixed(0)}% |`).join("\n");
md += `\n\n## Merge engine vs real git (${fz.cases} random concurrent-edit pairs)\n\nAgreement ${(out.mergeAgreement.agreement * 100).toFixed(1)}%: both clean ${fz.bothClean}, both conflict ${fz.bothConflict}, Weave merged what git rejected ${fz.weaveCleanGitConflict}, Weave rejected what git merged ${fz.weaveConflictGitClean}, clean but different text ${fz.cleanDiffer}.\n`;
writeFileSync(new URL("./results.md", import.meta.url), md);
console.log(md);
