import { diffHunks, splitLines } from "./merge.ts";

export interface FileDiff {
  path: string;
  status: "added" | "deleted" | "modified";
  added: number;
  removed: number;
  /** unified-diff text (with 3 lines of context) */
  patch: string;
}

export function diffStat(before: string | null, after: string | null): { added: number; removed: number } {
  const a = splitLines(before ?? "");
  const b = splitLines(after ?? "");
  let added = 0;
  let removed = 0;
  for (const h of diffHunks(a, b)) {
    added += h.lines.length;
    removed += h.end - h.start;
  }
  return { added, removed };
}

export function fileDiff(path: string, before: string | null, after: string | null, ctx = 3): FileDiff {
  const a = splitLines(before ?? "");
  const b = splitLines(after ?? "");
  const hunks = diffHunks(a, b);
  const { added, removed } = diffStat(before, after);
  const out: string[] = [`--- ${before === null ? "/dev/null" : "a/" + path}`, `+++ ${after === null ? "/dev/null" : "b/" + path}`];
  // group hunks whose context windows touch
  let i = 0;
  while (i < hunks.length) {
    let j = i;
    while (j + 1 < hunks.length && hunks[j + 1].start - hunks[j].end <= ctx * 2) j++;
    const first = hunks[i];
    const last = hunks[j];
    const s = Math.max(0, first.start - ctx);
    const e = Math.min(a.length, last.end + ctx);
    const body: string[] = [];
    let pos = s;
    let newCount = 0;
    for (let k = i; k <= j; k++) {
      const h = hunks[k];
      for (; pos < h.start; pos++) (body.push(" " + a[pos]), newCount++);
      for (; pos < h.end; pos++) body.push("-" + a[pos]);
      for (const l of h.lines) (body.push("+" + l), newCount++);
    }
    for (; pos < e; pos++) (body.push(" " + a[pos]), newCount++);
    const newStart = s + hunks.slice(0, i).reduce((n, h) => n + h.lines.length - (h.end - h.start), 0);
    out.push(`@@ -${s + 1},${e - s} +${newStart + 1},${newCount} @@`, ...body);
    i = j + 1;
  }
  return { path, status: before === null ? "added" : after === null ? "deleted" : "modified", added, removed, patch: out.join("\n") };
}
