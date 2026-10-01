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

type EditOp = "M" | "D" | "I";

/**
 * Myers O(ND) shortest edit script (the algorithm behind git's diff), so alignments on repetitive
 * code match git's instead of being an arbitrary tie-break. Returns null if the edit distance is too
 * large to trace cheaply; the caller then falls back to one big replacement (never unsafe, only
 * more conservative).
 */
function myers(a: string[], b: string[]): EditOp[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max;
  const width = 2 * max + 2;
  const v = new Int32Array(width);
  const trace: Int32Array[] = [];
  let found = -1;
  const budget = 24_000_000; // total Int32 entries we are willing to keep for the backtrace
  outer: for (let d = 0; d <= max; d++) {
    if ((d + 1) * width > budget) return null;
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) (x++, y++);
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }
  const ops: EditOp[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vv = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1]) ? k + 1 : k - 1;
    const prevX = vv[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) (ops.push("M"), x--, y--);
    ops.push(x === prevX ? "I" : "D");
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) (ops.push("M"), x--, y--);
  return ops.reverse();
}

/** Hunks that turn `base` into `other`. */
export function diffHunks(base: string[], other: string[]): Hunk[] {
  const n = base.length;
  const m = other.length;
  // Trim common prefix/suffix to keep the edit-distance search small.
  let pre = 0;
  while (pre < n && pre < m && base[pre] === other[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && base[n - 1 - suf] === other[m - 1 - suf]) suf++;
  const a = base.slice(pre, n - suf);
  const b = other.slice(pre, m - suf);
  if (!a.length && !b.length) return [];
  const ops = myers(a, b);
  const hunks: Hunk[] = [];
  if (!ops) {
    hunks.push({ start: pre, end: pre + a.length, lines: b });
  } else {
    let x = 0;
    let y = 0;
    let cur: Hunk | null = null;
    const flush = () => {
      if (cur) hunks.push(cur);
      cur = null;
    };
    for (const op of ops) {
      if (op === "M") {
        flush();
        x++;
        y++;
        continue;
      }
      cur ??= { start: pre + x, end: pre + x, lines: [] };
      if (op === "D") cur.end = pre + ++x;
      else cur.lines.push(b[y++]);
    }
    flush();
  }
  // Compaction: a pure insertion or deletion can often be placed at several equivalent positions (e.g.
  // appending a function that ends like the one above it). Slide each as far down as it will go so
  // that two sides describing the same change always agree on where it is; otherwise the same-point
  // inserts that git reports as conflicts can look like independent edits here.
  hunks.forEach((h, k) => {
    const limit = hunks[k + 1]?.start ?? n;
    if (h.end === h.start && h.lines.length) {
      while (h.start < limit && base[h.start] === h.lines[0]) {
        h.lines.push(h.lines.shift()!);
        h.start++;
        h.end++;
      }
    } else if (!h.lines.length && h.end > h.start) {
      while (h.end < limit && base[h.start] === base[h.end]) {
        h.start++;
        h.end++;
      }
    }
  });
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
      // git's rule (xdl_merge): changes merge only if at least one unchanged line separates them, so
      // abutting hunks conflict. Consecutive-line edits interact far more often than distant ones.
      const touches = (h: Hunk) => h.start <= e;
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
