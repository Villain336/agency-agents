// Parse a unified-diff patch (as produced by the API) into hunks of typed, numbered lines.
export function parsePatch(patch) {
  const hunks = [];
  let cur = null;
  let o = 0, n = 0;
  for (const raw of String(patch ?? "").split("\n")) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw);
    if (m) {
      o = +m[1];
      n = +m[3];
      cur = { header: raw, oldStart: o, newStart: n, section: m[5].trim(), lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue; // ---/+++ preamble
    const c = raw[0];
    if (c === "+") cur.lines.push({ type: "add", text: raw.slice(1), oldN: null, newN: n++ });
    else if (c === "-") cur.lines.push({ type: "del", text: raw.slice(1), oldN: o++, newN: null });
    else if (c === " ") cur.lines.push({ type: "ctx", text: raw.slice(1), oldN: o++, newN: n++ });
    else if (c === "\\") cur.lines.push({ type: "meta", text: raw, oldN: null, newN: null });
    // anything else (empty trailing line) is ignored
  }
  return hunks;
}

export function countPatch(hunks) {
  const a = { added: 0, removed: 0 };
  for (const h of hunks) for (const l of h.lines) if (l.type === "add") a.added++; else if (l.type === "del") a.removed++;
  return a;
}
