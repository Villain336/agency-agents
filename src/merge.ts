// Line-based three-way merge (diff3). Pure, dependency-free.

export interface Hunk {
  start: number; // base index, inclusive
  end: number; // base index, exclusive
  lines: string[]; // replacement
}

export type Segment =
  | { kind: "ok"; lines: string[] }
  | { kind: "conflict"; base: string[]; ours: string[]; theirs: string[] };

export interface MergeResult {
  segments: Segment[];
  conflicts: number;
  /** Merged text; only meaningful when conflicts === 0. */
  text: string;
}

export const splitLines = (s: string): string[] => (s === "" ? [] : s.split("\n"));
export const joinLines = (l: string[]): string => l.join("\n");

/** Hunks that turn `base` into `other`, via LCS. */
export function diffHunks(base: string[], other: string[]): Hunk[] {
  const n = base.length;
  const m = other.length;
  // Trim common prefix/suffix to keep the LCS table small.
  let pre = 0;
  while (pre < n && pre < m && base[pre] === other[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && base[n - 1 - suf] === other[m - 1 - suf]) suf++;
  const a = base.slice(pre, n - suf);
  const b = other.slice(pre, m - suf);
  const w = b.length + 1;
  const t = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let cur: Hunk | null = null;
  const flush = () => {
    if (cur) hunks.push(cur);
    cur = null;
  };
  const open = () => (cur ??= { start: pre + i, end: pre + i, lines: [] });
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (j < b.length && (i === a.length || t[i * w + j + 1] >= t[(i + 1) * w + j])) {
      open().lines.push(b[j++]);
    } else {
      const h = open();
      i++;
      h.end = pre + i;
    }
  }
  flush();
  return hunks;
}

function apply(base: string[], hunks: Hunk[], s: number, e: number): string[] {
  const out: string[] = [];
  let p = s;
  for (const h of hunks) {
    out.push(...base.slice(p, h.start), ...h.lines);
    p = h.end;
  }
  out.push(...base.slice(p, e));
  return out;
}

const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);

/** Three-way merge. `ours` = trunk side, `theirs` = the agent's session. */
export function merge3(base: string, ours: string, theirs: string): MergeResult {
  const B = splitLines(base);
  const ha = diffHunks(B, splitLines(ours));
  const hb = diffHunks(B, splitLines(theirs));
  const segments: Segment[] = [];
  let pos = 0;
  let ia = 0;
  let ib = 0;
  const pushOk = (lines: string[]) => {
    if (!lines.length) return;
    const last = segments[segments.length - 1];
    if (last?.kind === "ok") last.lines.push(...lines);
    else segments.push({ kind: "ok", lines: [...lines] });
  };
  while (ia < ha.length || ib < hb.length) {
    const nextA = ha[ia];
    const nextB = hb[ib];
    const first = !nextB || (nextA && nextA.start <= nextB.start) ? nextA : nextB;
    pushOk(B.slice(pos, first.start));
    let s = first.start;
    let e = first.end;
    const ga: Hunk[] = [];
    const gb: Hunk[] = [];
    for (let grew = true; grew; ) {
      grew = false;
      const touches = (h: Hunk) => h.start < e || (h.start === e && (h.end === h.start || e === s));
      while (ia < ha.length && touches(ha[ia])) (ga.push(ha[ia]), (e = Math.max(e, ha[ia++].end)), (grew = true));
      while (ib < hb.length && touches(hb[ib])) (gb.push(hb[ib]), (e = Math.max(e, hb[ib++].end)), (grew = true));
    }
    const ra = apply(B, ga, s, e);
    const rb = apply(B, gb, s, e);
    if (!gb.length) pushOk(ra);
    else if (!ga.length) pushOk(rb);
    else if (same(ra, rb)) pushOk(ra);
    else segments.push({ kind: "conflict", base: B.slice(s, e), ours: ra, theirs: rb });
    pos = e;
  }
  pushOk(B.slice(pos));
  const conflicts = segments.filter((s) => s.kind === "conflict").length;
  const text = joinLines(segments.flatMap((s) => (s.kind === "ok" ? s.lines : s.theirs)));
  return { segments, conflicts, text };
}

export type Choice = "ours" | "theirs" | "both" | { text: string };

/** Resolve every conflict segment using `choices` (one per conflict, in order). */
export function resolveSegments(segments: Segment[], choices: Choice[]): string {
  let c = 0;
  const lines = segments.flatMap((s) => {
    if (s.kind === "ok") return s.lines;
    const ch = choices[c++];
    if (ch === undefined) throw new Error(`missing choice for conflict #${c}`);
    if (ch === "ours") return s.ours;
    if (ch === "theirs") return s.theirs;
    if (ch === "both") return [...s.ours, ...s.theirs];
    return splitLines(ch.text);
  });
  return joinLines(lines);
}
