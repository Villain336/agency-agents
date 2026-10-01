// How good is the semantic-interaction detector? Synthetic pairs with known ground truth.
import { semanticRisk } from "../src/semantic.ts";
import { DEFAULTS, fnName, seedFiles } from "./workload.ts";

export interface DetectorResult {
  category: string;
  shouldFlag: boolean;
  cases: number;
  flagged: number;
  rate: number;
}

export function evalDetector(cases = 200): DetectorResult[] {
  const w = { ...DEFAULTS, files: 6, fnsPerFile: 12 };
  const files = seedFiles(w);
  const out: DetectorResult[] = [];
  const run = (category: string, shouldFlag: boolean, gen: (i: number) => [string, string, string]) => {
    let flagged = 0;
    for (let i = 0; i < cases; i++) {
      const [base, ours, theirs] = gen(i);
      if (semanticRisk("f.js", base, ours, theirs).length) flagged++;
    }
    out.push({ category, shouldFlag, cases, flagged, rate: flagged / cases });
  };
  const pick = (i: number) => {
    const f = i % w.files, j = (i * 7) % w.fnsPerFile, f2 = (f + 1 + (i % 3)) % w.files;
    return { f, j, name: fnName(f, j), base: files[`mod${f}.js`], other: files[`mod${f2}.js`] };
  };
  // A changes a function's signature; B (concurrently) adds a caller using the old arity.
  run("signature change vs new caller", true, (i) => {
    const { name, base } = pick(i);
    const ours = base.replace(`function ${name}(x) {`, `function ${name}(x, y) {`);
    const theirs = base + `\nfunction caller_${i}(z) {\n  return ${name}(z);\n}\n`;
    return [base, ours, theirs];
  });
  // A changes a function body; B changes a different function that calls it.
  run("body change vs existing caller edited", true, (i) => {
    const { name, base } = pick(i);
    const callerName = fnName((i + 3) % w.files, 1);
    const withCaller = base + `\nfunction caller_${i}(z) {\n  return ${name}(z);\n}\n`;
    const ours = withCaller.replace(`function ${name}(x) {\n  step0(x);`, `function ${name}(x) {\n  guard(x);\n  step0(x);`);
    const theirs = withCaller.replace(`  return ${name}(z);`, `  return ${name}(z) + 1;`);
    void callerName;
    return [withCaller, ours, theirs];
  });
  // both edit different lines of the same function (edits are scoped to that function, not the file's first one)
  run("same function, different lines", true, (i) => {
    const { name, base } = pick(i);
    const at = base.indexOf(`function ${name}(x) {`);
    const end = base.indexOf("\n}", at) + 2;
    const fn = base.slice(at, end);
    const ours = base.slice(0, at) + fn.replace("  step0(x);", "  step0(x); // a") + base.slice(end);
    const theirs = base.slice(0, at) + fn.replace("  return x;", "  return x + 1;") + base.slice(end);
    return [base, ours, theirs];
  });
  // known limitation: the dependency is two calls away
  run("transitive dependency (known miss)", true, (i) => {
    const { name, base } = pick(i);
    const chain = base + `\nfunction mid_${i}(z) {\n  return ${name}(z);\n}\n\nfunction top_${i}(z) {\n  return mid_${i}(z);\n}\n`;
    const ours = chain.replace(`function ${name}(x) {`, `function ${name}(x, y) {`);
    const theirs = chain.replace(`  return mid_${i}(z);`, `  return mid_${i}(z) + 1;`);
    return [chain, ours, theirs];
  });
  // controls: independent changes must not be flagged
  run("independent changes (false positives)", false, (i) => {
    const { name, base, other } = pick(i);
    void other;
    const ours = base.replace(`function ${name}(x) {\n  step0(x);`, `function ${name}(x) {\n  step0(x); // edit`);
    const theirs = base + `\nfunction unrelated_${i}(z) {\n  return z * 2;\n}\n`;
    return [base, ours, theirs];
  });
  run("independent edits to two functions (false positives)", false, (i) => {
    const { f, j, name, base } = pick(i);
    const n2 = fnName(f, (j + 5) % w.fnsPerFile);
    const scoped = (fname: string, from: string, to: string) => {
      const at = base.indexOf(`function ${fname}(x) {`);
      const end = base.indexOf("\n}", at) + 2;
      return base.slice(0, at) + base.slice(at, end).replace(from, to) + base.slice(end);
    };
    return [base, scoped(name, "  step0(x);", "  step0(x); // a"), scoped(n2, "  step4(x);", "  step4(x); // b")];
  });
  return out;
}
