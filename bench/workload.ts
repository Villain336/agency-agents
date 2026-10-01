// Deterministic synthetic workload: N agents each make one change to a shared repo.
// Edits are expressed as pure functions of file content, so an agent can "rework" a change on top
// of newer trunk exactly the way an LLM agent would after a conflict.

export interface Rng { next(): number }
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return { next() { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; } };
}

export interface Op {
  agent: number;
  kind: "modify" | "append";
  path: string;
  /** marker that proves this agent's change is present */
  marker: string;
  apply(content: string): string;
  /** seconds of agent "thinking" before the first submit */
  workSec: number;
}

export interface WorkloadOptions {
  agents: number;
  files: number;
  fnsPerFile: number;
  /** Zipf exponent for picking where to edit: 0 = uniform, higher = hotter hot-spots */
  skew: number;
  /** fraction of agents that append a new function at the end of a file */
  appendFraction: number;
  seed: number;
}

export const DEFAULTS: WorkloadOptions = { agents: 50, files: 10, fnsPerFile: 20, skew: 1.0, appendFraction: 0.4, seed: 7 };

const STEPS = 5;
export const fnName = (f: number, j: number) => `f${f}_${j}`;

export function seedFiles(o: WorkloadOptions): Record<string, string> {
  const files: Record<string, string> = {};
  for (let f = 0; f < o.files; f++) {
    const out: string[] = [];
    for (let j = 0; j < o.fnsPerFile; j++) {
      out.push(`function ${fnName(f, j)}(x) {`);
      for (let k = 0; k < STEPS; k++) out.push(`  step${k}(x);`);
      out.push("  return x;", "}", "");
    }
    files[`mod${f}.js`] = out.join("\n");
  }
  return files;
}

function zipfPicker(n: number, s: number, r: Rng) {
  const w = Array.from({ length: n }, (_, i) => 1 / Math.pow(i + 1, s));
  const total = w.reduce((a, b) => a + b, 0);
  return () => {
    let x = r.next() * total;
    for (let i = 0; i < n; i++) if ((x -= w[i]) <= 0) return i;
    return n - 1;
  };
}

export function makeOps(o: WorkloadOptions): Op[] {
  const r = rng(o.seed);
  const pickFile = zipfPicker(o.files, o.skew, r);
  const pickFn = zipfPicker(o.fnsPerFile, o.skew, r);
  const ops: Op[] = [];
  for (let i = 0; i < o.agents; i++) {
    const f = pickFile();
    const path = `mod${f}.js`;
    const workSec = 5 + Math.floor(r.next() * 55);
    if (r.next() < o.appendFraction) {
      const marker = `added_by_${i}`;
      ops.push({ agent: i, kind: "append", path, marker, workSec, apply: (c) => `${c.replace(/\n*$/, "\n")}\nfunction ${marker}(x) {\n  return x;\n}\n` });
    } else {
      const j = pickFn();
      const step = Math.floor(r.next() * STEPS);
      const marker = `edited_by_${i}`;
      ops.push({
        agent: i, kind: "modify", path, marker, workSec,
        apply: (c) => {
          const head = `function ${fnName(f, j)}(x) {`;
          const at = c.indexOf(head);
          if (at < 0) return c;
          const line = `  step${step}(x);`;
          const lineAt = c.indexOf(line, at);
          // if a concurrent edit already rewrote this step line, edit the line that replaced it
          const endAt = c.indexOf("\n}", at);
          const region = c.slice(at, endAt);
          if (lineAt >= 0 && lineAt < endAt) return c.slice(0, lineAt) + `  step${step}(x); // ${marker}` + c.slice(lineAt + line.length);
          const m = new RegExp(`^  step${step}\\(x\\);.*$`, "m").exec(region);
          return m ? c.slice(0, at + m.index) + `${m[0]} // ${marker}` + c.slice(at + m.index + m[0].length) : c;
        },
      });
    }
  }
  return ops;
}

/** Which agents' changes are missing from the final trunk (lost updates)? */
export function lostUpdates(files: Record<string, string>, ops: Op[]): number {
  return ops.filter((op) => !(files[op.path] ?? "").includes(op.marker)).length;
}
