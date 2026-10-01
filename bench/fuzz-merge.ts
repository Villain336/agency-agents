// Differential fuzz: Weave's merge3 vs real `git merge-file` on random pairs of concurrent edits.
//   node bench/fuzz-merge.ts [cases] [seed]
import { merge3 } from "../src/merge.ts";
import { gitMerge3 } from "./gitmerge.ts";
import { rng, DEFAULTS, makeOps, seedFiles } from "./workload.ts";

export interface FuzzStats { cases: number; bothClean: number; bothConflict: number; weaveCleanGitConflict: number; weaveConflictGitClean: number; cleanDiffer: number; examples: string[]; differing: { base: string; ours: string; theirs: string; weave: string; git: string }[] }

function randomEdit(lines: string[], r: ReturnType<typeof rng>): string[] {
  const out = [...lines];
  const n = 1 + Math.floor(r.next() * 3);
  for (let i = 0; i < n; i++) {
    const at = Math.floor(r.next() * (out.length + 1));
    const roll = r.next();
    if (roll < 0.35) out.splice(at, 0, ...Array.from({ length: 1 + Math.floor(r.next() * 3) }, () => pick(r)));
    else if (roll < 0.65 && out.length) out.splice(Math.min(at, out.length - 1), 1 + Math.floor(r.next() * 2));
    else if (out.length) out[Math.min(at, out.length - 1)] = pick(r);
  }
  return out;
}
// a small alphabet makes repeated/identical lines common, which is where diff alignments differ
const ALPHA = ["}", "", "  return x;", "  step(x);", "function f(x) {", "a", "b", "c", "// note"];
const pick = (r: ReturnType<typeof rng>) => ALPHA[Math.floor(r.next() * ALPHA.length)] + (r.next() < 0.3 ? String(Math.floor(r.next() * 4)) : "");

export function fuzz(cases: number, seed = 1): FuzzStats {
  const r = rng(seed);
  const s: FuzzStats = { cases, bothClean: 0, bothConflict: 0, weaveCleanGitConflict: 0, weaveConflictGitClean: 0, cleanDiffer: 0, examples: [], differing: [] };
  const w = { ...DEFAULTS, agents: 60, skew: 0.8 };
  const base0 = seedFiles(w);
  const ops = makeOps(w);
  for (let i = 0; i < cases; i++) {
    let base: string, ours: string, theirs: string;
    if (i % 2 === 0) {
      // realistic: two workload edits to the same file
      const a = ops[Math.floor(r.next() * ops.length)];
      const b = ops[Math.floor(r.next() * ops.length)];
      base = base0[a.path];
      ours = a.apply(base);
      theirs = b.path === a.path ? b.apply(base) : a.apply(base).replace("step0", "stepX");
    } else {
      // adversarial: random line edits over a tiny alphabet with many repeated lines
      const lines = Array.from({ length: 6 + Math.floor(r.next() * 25) }, () => pick(r));
      base = lines.join("\n");
      ours = randomEdit(lines, r).join("\n");
      theirs = randomEdit(lines, r).join("\n");
    }
    const g = gitMerge3(base, ours, theirs);
    const m = merge3(base, ours, theirs);
    const wc = m.conflicts === 0;
    if (wc && g !== null) { s.bothClean++; if (m.text !== g) { s.cleanDiffer++; s.differing.push({ base, ours, theirs, weave: m.text, git: g }); if (s.examples.length < 3) s.examples.push(JSON.stringify({ base, ours, theirs, weave: m.text, git: g }).slice(0, 700)); } }
    else if (!wc && g === null) s.bothConflict++;
    else if (wc && g === null) { s.weaveCleanGitConflict++; if (s.examples.length < 3) s.examples.push("W-clean/G-conflict " + JSON.stringify({ base, ours, theirs }).slice(0, 500)); }
    else s.weaveConflictGitClean++;
  }
  return s;
}

if (process.argv[1]?.endsWith("fuzz-merge.ts")) {
  const s = fuzz(Number(process.argv[2] ?? 3000), Number(process.argv[3] ?? 1));
  const { examples, ...rest } = s;
  console.log(rest);
  console.log("agreement:", (((s.bothClean - s.cleanDiffer + s.bothConflict) / s.cases) * 100).toFixed(1) + "%");
  for (const e of examples) console.log("example:", e);
}
