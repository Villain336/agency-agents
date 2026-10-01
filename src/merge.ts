// Line-based three-way merge (diff3). Pure, dependency-free.

export interface Hunk {
  start: number; // base index, inclusive
  end: number; // base index, exclusive
  lines: string[]; // replacement
}

export type Segment =
  | { kind: "ok"; lines: string[] }
  | { kind: "conflict"; base: string[]; ours: string[]; theirs: string[] };

export interface MergeOptions {
  /** merge single-line lists (exports, imports, arrays, arguments) item by item */
  lists?: boolean;
  /** keep both sides when each only inserted text at the same point (appended tests, changelog entries) */
  union?: boolean;
}

export interface MergeResult {
  segments: Segment[];
  conflicts: number;
  /** clashes resolved automatically by the strategies above */
  auto: number;
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


// ---- smart strategies ---------------------------------------------------------------------------

const OPEN: Record<string, string> = { "{": "}", "[": "]", "(": ")" };

/** Matching bracket pairs on one line, ignoring brackets inside quotes. */
function bracketPairs(line: string): [number, number][] {
  const pairs: [number, number][] = [];
  const stack: [string, number][] = [];
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
    } else if (c === "'" || c === '"' || c === "`") q = c;
    else if (c in OPEN) stack.push([c, i]);
    else if (Object.values(OPEN).includes(c)) {
      const top = stack.pop();
      if (!top || OPEN[top[0]] !== c) return [];
      pairs.push([top[1], i]);
    }
  }
  return stack.length || q ? [] : pairs;
}

/** Split a list body on top-level commas (not inside quotes or nested brackets). */
function splitItems(inner: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let q: string | null = null;
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (q) {
      cur += c;
      if (c === "\\") cur += inner[++i] ?? "";
      else if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") q = c;
    else if (c in OPEN) depth++;
    else if (Object.values(OPEN).includes(c)) depth--;
    if (c === "," && depth === 0) (items.push(cur.trim()), (cur = ""));
    else cur += c;
  }
  if (cur.trim() !== "") items.push(cur.trim());
  return items;
}

/**
 * Three-way merge of one line that is (or contains) a list, at item granularity. Two sides adding
 * different items, or one adding and one removing, do not really conflict.
 */
function mergeListLine(b: string, o: string, t: string): string | null {
  const m = Math.min(b.length, o.length, t.length);
  let p = 0;
  while (p < m && b[p] === o[p] && o[p] === t[p]) p++;
  let s = 0;
  while (s < m - p && b[b.length - 1 - s] === o[o.length - 1 - s] && o[o.length - 1 - s] === t[t.length - 1 - s]) s++;
  const from = p;
  const to = b.length - s;
  // innermost bracket pair that encloses the whole differing region in every version
  const enclosing = bracketPairs(b).filter(([open, close]) => open < from && close >= to).sort((x, y) => y[0] - x[0])[0];
  if (!enclosing) return null;
  const [open, close] = enclosing;
  const fromEnd = b.length - close;
  const inner = (l: string) => l.slice(open + 1, l.length - fromEnd);
  const head = b.slice(0, open + 1);
  const tail = b.slice(close);
  if (o.slice(0, open + 1) !== head || t.slice(0, open + 1) !== head || o.slice(o.length - fromEnd) !== tail || t.slice(t.length - fromEnd) !== tail) return null;
  const bi = splitItems(inner(b));
  const oi = splitItems(inner(o));
  const ti = splitItems(inner(t));
  const oa = oi.filter((x) => !bi.includes(x));
  const or = bi.filter((x) => !oi.includes(x));
  const ta = ti.filter((x) => !bi.includes(x));
  const tr = bi.filter((x) => !ti.includes(x));
  const items = bi.filter((x) => !or.includes(x) && !tr.includes(x));
  for (const x of [...oa, ...ta]) if (!items.includes(x)) items.push(x);
  const body = inner(b);
  const lead = /^\s*/.exec(body)![0];
  const trail = /\s*$/.exec(body)![0];
  const sep = /,(\s*)\S/.exec(body)?.[0].slice(0, -1) ?? ", ";
  return head + lead + items.join(sep) + trail + tail;
}

/** How much of `base` this line shares at its start and end (0..base.length). */
function similarity(base: string, l: string): number {
  const m = Math.min(base.length, l.length);
  let p = 0;
  while (p < m && base[p] === l[p]) p++;
  let s = 0;
  while (s < m - p && base[base.length - 1 - s] === l[l.length - 1 - s]) s++;
  return p + s;
}

/** The line in `block` that is a modified version of `base` (e.g. the exports line), or -1. */
function anchorIndex(base: string, block: string[]): number {
  let best = -1;
  let score = 0;
  block.forEach((l, i) => {
    const sc = similarity(base, l);
    if (sc > score) ((score = sc), (best = i));
  });
  return score >= Math.max(4, base.length * 0.7) ? best : -1;
}

/** Combine the lines two sides inserted at the same point: one side's, or both when `union` allows. */
function unionBlock(a: string[], b: string[], opts: MergeOptions): string[] | null {
  if (!a.length) return b;
  if (!b.length) return a;
  if (a.length === b.length && a.every((x, i) => x === b[i])) return a;
  return opts.union ? [...a, ...b] : null;
}

/**
 * Resolve one clash region. Strategies (each opt-in, each counted by the caller):
 *  - union: both sides only inserted lines at the same point (appended tests, changelog entries)
 *  - lists: the region is one base line that both sides changed, possibly with new lines inserted around it
 *    (a new function above the exports line, plus an edit to the exports line itself): the anchor line is
 *    merged item by item and the inserted blocks around it are kept
 */
function resolveClash(baseLines: string[], ours: string[], theirs: string[], opts: MergeOptions): string[] | null {
  if (opts.union && baseLines.length === 0 && ours.length && theirs.length) return [...ours, ...theirs];
  if (!opts.lists || baseLines.length !== 1) return null;
  const b = baseLines[0];
  const oi = anchorIndex(b, ours);
  const ti = anchorIndex(b, theirs);
  if (oi < 0 || ti < 0) return null;
  const anchor = ours[oi] === b ? theirs[ti] : theirs[ti] === b || ours[oi] === theirs[ti] ? ours[oi] : mergeListLine(b, ours[oi], theirs[ti]);
  if (anchor === null) return null;
  const before = unionBlock(ours.slice(0, oi), theirs.slice(0, ti), opts);
  const after = unionBlock(ours.slice(oi + 1), theirs.slice(ti + 1), opts);
  return before && after ? [...before, anchor, ...after] : null;
}

/** Three-way merge. `ours` = trunk side, `theirs` = the agent's session. */
export function merge3(base: string, ours: string, theirs: string, opts: MergeOptions = {}): MergeResult {
  const B = splitLines(base);
  const ha = diffHunks(B, splitLines(ours));
  const hb = diffHunks(B, splitLines(theirs));
  const segments: Segment[] = [];
  let auto = 0;
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
    else {
      const merged = resolveClash(B.slice(s, e), ra, rb, opts);
      if (merged) (pushOk(merged), auto++);
      else segments.push({ kind: "conflict", base: B.slice(s, e), ours: ra, theirs: rb });
    }
    pos = e;
  }
  pushOk(B.slice(pos));
  const conflicts = segments.filter((s) => s.kind === "conflict").length;
  const text = joinLines(segments.flatMap((s) => (s.kind === "ok" ? s.lines : s.theirs)));
  return { segments, conflicts, text, auto };
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
