// Semantic risk detection for clean textual merges. A line merge can't see that two
// non-overlapping edits interact (e.g. one adds a parameter while the other caches the function).
// We approximate with symbol-level analysis: top-level declarations found by regex (TS/JS/Go/Python),
// no parser required. It is a heuristic that errs toward flagging; a flagged change simply needs a
// verifier (tests, a reviewer agent) to attest against the merged result before it lands.

import { diffHunks, splitLines } from "./merge.ts";

export interface Risk {
  path: string;
  kind: "same-symbol" | "dependency";
  symbols: string[];
  detail: string;
}

interface Sym {
  name: string;
  start: number;
  end: number; // exclusive
}

const DECL = [
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /^(?:async\s+)?(?:def|class)\s+(\w+)/,
  /^func\s+(?:\([^)]*\)\s*)?(\w+)/,
];

export function symbols(lines: string[]): Sym[] {
  const heads: { name: string; start: number }[] = [];
  lines.forEach((l, i) => {
    for (const re of DECL) {
      const m = re.exec(l);
      if (m) {
        heads.push({ name: m[1], start: i });
        break;
      }
    }
  });
  const out: Sym[] = [];
  if (!heads.length || heads[0].start > 0) out.push({ name: "<top>", start: 0, end: heads[0]?.start ?? lines.length });
  heads.forEach((h, i) => out.push({ name: h.name, start: h.start, end: heads[i + 1]?.start ?? lines.length }));
  return out;
}

/** Names of symbols whose text differs between base and other. */
function changed(base: string[], other: string[]): Set<string> {
  const bs = symbols(base);
  const os = symbols(other);
  const names = new Set<string>();
  for (const h of diffHunks(base, other)) {
    const touch = (line: number, syms: Sym[]) => syms.find((s) => line >= s.start && line < s.end) ?? syms[syms.length - 1];
    if (h.end > h.start) for (let i = h.start; i < h.end; i++) names.add(touch(i, bs)?.name ?? "<top>");
    else if (!h.lines.every((l) => l.trim() === "") && !h.lines.some((l) => DECL.some((re) => re.test(l))))
      names.add(touch(Math.min(h.start, base.length - 1), bs)?.name ?? "<top>"); // insertion inside a body
  }
  // symbols that exist on only one side were added/removed
  const bn = new Set(bs.map((s) => s.name));
  for (const s of os) if (!bn.has(s.name)) names.add(s.name);
  return names;
}

const mentions = (text: string, name: string) => name !== "<top>" && new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(text);

export function semanticRisk(path: string, base: string, ours: string, theirs: string): Risk[] {
  const B = splitLines(base);
  const O = splitLines(ours);
  const T = splitLines(theirs);
  const a = changed(B, O);
  const b = changed(B, T);
  const risks: Risk[] = [];
  const both = [...a].filter((n) => n !== "<top>" && b.has(n));
  if (both.length)
    risks.push({ path, kind: "same-symbol", symbols: both, detail: `both sides modified ${both.map((n) => `\`${n}\``).join(", ")} in different lines; the merge compiles textually but may not mean what either author intended` });
  const deps = (side: Set<string>, other: Set<string>, text: string[], label: string) => {
    for (const s of symbols(text)) {
      if (!side.has(s.name)) continue;
      const body = text.slice(s.start, s.end).join("\n");
      const hit = [...other].filter((n) => n !== s.name && !both.includes(n) && mentions(body, n));
      if (hit.length)
        risks.push({ path, kind: "dependency", symbols: [s.name, ...hit], detail: `${label} changed \`${s.name}\`, which uses ${hit.map((n) => `\`${n}\``).join(", ")} changed concurrently by the other side` });
    }
  };
  deps(b, a, T, "the session");
  deps(a, b, O, "trunk");
  return risks;
}
