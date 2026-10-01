// Browse API: read-only, pure functions over a Repo (never mutate state). Contract: docs/API-NEXT.md.
//
// Limits (documented, enforced):
//   blame   files up to BLAME_MAX_LINES (10 000) lines, else 413; only the last BLAME_MAX_VERSIONS (300)
//           versions of a file are walked (older lines are attributed to the first walked version and
//           the response carries `truncated: true`).
//   search  files over 1 MB are skipped; patterns up to 200 chars; lines are examined up to 2 000 chars;
//           a 1.5 s wall-clock budget bounds the scan (result then has `truncated: true`).
//   Blame treats a line as the text between "\n"; unlike git, a missing final newline does not make the
//   last line "different" from the same line with a newline.
import { diffHunks, splitLines, type Hunk } from "./merge.ts";
import { fileDiff, type FileDiff } from "./diff.ts";
import { globMatch, LIVE, Repo, WeaveError, type Commit } from "./repo.ts";
import type { Ctx } from "./api.ts";

export const BLAME_MAX_LINES = 10_000;
export const BLAME_MAX_VERSIONS = 300;
export const SEARCH_MAX_FILE_BYTES = 1_000_000;
export const SEARCH_MAX_PATTERN = 200;
export const SEARCH_MAX_LINE = 2000;
export const SEARCH_BUDGET_MS = 1500;

const enc = new TextEncoder();

// ---- helpers -----------------------------------------------------------------------------------
const LANGS: Record<string, string> = {
  ts: "ts", tsx: "tsx", mts: "ts", cts: "ts", js: "js", jsx: "jsx", mjs: "js", cjs: "js", py: "py", rb: "rb", go: "go", rs: "rs", java: "java",
  kt: "kt", swift: "swift", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "cs", php: "php", sh: "sh", bash: "sh", zsh: "sh",
  md: "md", markdown: "md", json: "json", yml: "yaml", yaml: "yaml", toml: "toml", html: "html", htm: "html", css: "css", scss: "scss",
  sql: "sql", xml: "xml", svg: "svg", txt: "text",
};

export function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}
export const languageOf = (path: string): string => LANGS[extOf(path)] ?? "text";

const isText = (s: string) => !s.includes("\u0000");
/** Lines as a viewer shows them: a trailing newline does not start another line. */
const viewLines = (s: string): string[] => {
  const l = splitLines(s);
  if (l.length && l[l.length - 1] === "") l.pop();
  return l;
};

function normPath(p: string | null | undefined): string {
  let s = (p ?? "").trim();
  if (s.includes("\u0000") || s.includes("\\")) throw new WeaveError("invalid path", 400);
  s = s.replace(/^\/+|\/+$/g, "");
  if (!s) return "";
  const segs = s.split("/");
  if (segs.some((x) => x === "" || x === "." || x === "..")) throw new WeaveError("invalid path", 400);
  return s;
}

function parseRev(repo: Repo, raw: string | null | undefined, dflt: number): number {
  if (raw === null || raw === undefined || raw === "") return dflt;
  const m = /^r?(\d{1,9})$/.exec(raw.trim());
  if (!m) throw new WeaveError(`invalid revision: ${raw}`, 400);
  const n = Number(m[1]);
  if (n > repo.s.rev) throw new WeaveError(`no such revision: r${n}`, 404);
  return n;
}

function parseLimit(raw: string | null, dflt: number, max: number): number {
  if (raw === null || raw === "") return dflt;
  if (!/^\d+$/.test(raw)) throw new WeaveError(`invalid limit: ${raw}`, 400);
  return Math.min(max, Math.max(1, Number(raw)));
}

const flag = (raw: string | null) => raw === "1" || raw === "true" || raw === "yes";

const commitMap = (repo: Repo) => new Map<number, Commit>(repo.s.commits.map((c) => [c.rev, c]));
const under = (path: string, prefix: string) => prefix === "" || path === prefix || path.startsWith(prefix + "/");

/** Latest version of `path` at or before `rev` (including deletions). */
function versionAt(repo: Repo, path: string, rev: number) {
  const v = repo.s.files[path];
  if (!v) return undefined;
  for (let i = v.length - 1; i >= 0; i--) if (v[i].rev <= rev) return v[i];
  return undefined;
}

const who = (cm: Map<number, Commit>, rev: number) => {
  const c = cm.get(rev);
  return { lastRev: rev, lastAgent: c?.agent ?? null, lastMessage: c?.message ?? null, lastTs: c?.ts ?? null };
};

// ---- tree --------------------------------------------------------------------------------------
export interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  lastRev: number;
  lastAgent: string | null;
  lastMessage: string | null;
  lastTs: number | null;
}

export function tree(repo: Repo, opts: { path?: string | null; rev?: string | null } = {}) {
  const path = normPath(opts.path);
  const rev = parseRev(repo, opts.rev, repo.s.rev);
  const cm = commitMap(repo);
  const kids = new Map<string, { type: "file" | "dir"; live: boolean; last: number; size?: number }>();
  let pathIsFile = false;
  let any = path === "";
  for (const p of Object.keys(repo.s.files)) {
    const v = versionAt(repo, p, rev);
    if (!v) continue;
    if (p === path && v.content !== null) pathIsFile = true;
    if (!p.startsWith(path ? path + "/" : "")) continue;
    const rest = p.slice(path ? path.length + 1 : 0);
    const slash = rest.indexOf("/");
    const name = slash < 0 ? rest : rest.slice(0, slash);
    const type = slash < 0 ? "file" : "dir";
    const k = kids.get(name) ?? { type, live: false, last: 0 };
    if (v.content !== null) {
      k.live = true;
      any = true;
      if (type === "file") k.size = enc.encode(v.content).length;
    }
    k.last = Math.max(k.last, v.rev);
    kids.set(name, k);
  }
  if (pathIsFile) throw new WeaveError(`not a directory: ${path}`, 400);
  if (!any) throw new WeaveError(`no such directory: ${path}`, 404);
  const entries: TreeEntry[] = [];
  for (const [name, k] of kids) {
    if (!k.live) continue;
    const e: TreeEntry = { name, path: path ? `${path}/${name}` : name, type: k.type, ...who(cm, k.last) };
    if (k.type === "file") e.size = k.size;
    entries.push(e);
  }
  entries.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { rev, path, entries };
}

// ---- blob --------------------------------------------------------------------------------------
function liveFile(repo: Repo, path: string, rev: number): string {
  if (!path) throw new WeaveError("path is required", 400);
  const content = repo.fileAt(path, rev);
  if (content === null) {
    const isDir = repo.listFiles(rev).some((p) => p.startsWith(path + "/"));
    if (isDir) throw new WeaveError(`is a directory: ${path}`, 400);
    throw new WeaveError(`no such file at r${rev}: ${path}`, 404);
  }
  return content;
}

export function blob(repo: Repo, opts: { path?: string | null; rev?: string | null }) {
  const path = normPath(opts.path);
  const rev = parseRev(repo, opts.rev, repo.s.rev);
  const content = liveFile(repo, path, rev);
  return { path, rev, size: enc.encode(content).length, lines: viewLines(content).length, content, language: languageOf(path) };
}

// ---- history / commit / diff ---------------------------------------------------------------------
const commitSummary = (c: Commit) => ({ rev: c.rev, agent: c.agent, message: c.message, ts: c.ts, merged: c.merged, hash: c.hash, risk: c.provenance?.risk?.tier, paths: c.paths });

export function history(repo: Repo, opts: { path?: string | null; limit?: string | null; before?: string | null } = {}) {
  const path = normPath(opts.path);
  const limit = parseLimit(opts.limit ?? null, 30, 200);
  const before = opts.before === null || opts.before === undefined || opts.before === "" ? Infinity : parseRev(repo, opts.before, repo.s.rev + 1);
  const out: ReturnType<typeof commitSummary>[] = [];
  let hasMore = false;
  const cs = repo.s.commits;
  for (let i = cs.length - 1; i >= 0; i--) {
    const c = cs[i];
    if (c.rev >= before) continue;
    if (path && !c.paths.some((p) => under(p, path))) continue;
    if (out.length === limit) {
      hasMore = true;
      break;
    }
    out.push(commitSummary(c));
  }
  return { commits: out, hasMore };
}

function diffFiles(repo: Repo, from: number, to: number, path: string): FileDiff[] {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const files: FileDiff[] = [];
  for (const p of Object.keys(repo.s.files).sort()) {
    if (!under(p, path)) continue;
    if (!repo.s.files[p].some((v) => v.rev > lo && v.rev <= hi)) continue;
    const a = repo.fileAt(p, from);
    const b = repo.fileAt(p, to);
    if (a === b) continue;
    files.push(fileDiff(p, a, b));
  }
  return files;
}

export function commit(repo: Repo, revRaw: string) {
  const m = /^r?(\d{1,9})$/.exec((revRaw ?? "").trim());
  if (!m) throw new WeaveError(`invalid revision: ${revRaw}`, 400);
  const rev = Number(m[1]);
  const c = repo.s.commits.find((x) => x.rev === rev);
  if (!c) throw new WeaveError(`no such revision: r${rev}`, 404);
  const files: FileDiff[] = [];
  for (const p of [...c.paths].sort()) {
    const a = repo.fileAt(p, rev - 1);
    const b = repo.fileAt(p, rev);
    if (a === b) continue;
    files.push(fileDiff(p, a, b));
  }
  const pv = c.provenance;
  return {
    commit: { rev: c.rev, agent: c.agent, message: c.message, ts: c.ts, merged: c.merged, hash: c.hash, risk: pv?.risk?.tier, approvals: pv?.approvals ?? [], evidence: pv?.evidence ?? [] },
    files,
  };
}

/** `to` defaults to head and `from` to the revision before `to`. */
export function diff(repo: Repo, opts: { from?: string | null; to?: string | null; path?: string | null } = {}) {
  const to = parseRev(repo, opts.to, repo.s.rev);
  const from = parseRev(repo, opts.from, Math.max(0, to - 1));
  const path = normPath(opts.path);
  return { from, to, files: diffFiles(repo, from, to, path) };
}

// ---- blame -------------------------------------------------------------------------------------
/**
 * Like git's xdl_change_compact: slide pure insertions/deletions down as far as they go and merge groups
 * that become adjacent (then slide again). Among equal-cost diffs this picks the same alignment git does
 * far more often than diffHunks alone, which matters for attribution of repeated lines (blank lines, `}`).
 */
export function compactHunks(base: string[], input: Hunk[]): Hunk[] {
  const hunks = input.map((h) => ({ start: h.start, end: h.end, lines: [...h.lines] }));
  for (let changed = true; changed; ) {
    changed = false;
    for (let k = 0; k < hunks.length; k++) {
      const h = hunks[k];
      const pv = hunks[k - 1];
      if (pv && (h.end === h.start) !== (!h.lines.length)) {
        // can this pure group slide up until it touches the previous group? then they merge
        const ins = h.end === h.start;
        const s = { start: h.start, end: h.end, lines: [...h.lines] };
        while (s.start > pv.end && (ins ? base[s.start - 1] === s.lines[s.lines.length - 1] : base[s.start - 1] === base[s.end - 1])) {
          if (ins) s.lines.unshift(s.lines.pop()!);
          s.start--;
          s.end--;
        }
        if (s.start === pv.end) {
          pv.end = s.end;
          pv.lines.push(...s.lines);
          hunks.splice(k, 1);
          changed = true;
          k -= 2;
          continue;
        }
      }
      const limit = hunks[k + 1]?.start ?? base.length;
      if (h.end === h.start && h.lines.length) {
        while (h.start < limit && base[h.start] === h.lines[0]) (h.lines.push(h.lines.shift()!), h.start++, h.end++, (changed = true));
      } else if (!h.lines.length && h.end > h.start) {
        while (h.end < limit && base[h.start] === base[h.end]) (h.start++, h.end++, (changed = true));
      }
      const nx = hunks[k + 1];
      if (nx && nx.start === h.end) {
        h.end = nx.end;
        h.lines.push(...nx.lines);
        hunks.splice(k + 1, 1);
        changed = true;
        k--;
      }
    }
  }
  return hunks;
}

export function blame(repo: Repo, opts: { path?: string | null; rev?: string | null }) {
  const path = normPath(opts.path);
  const rev = parseRev(repo, opts.rev, repo.s.rev);
  const content = liveFile(repo, path, rev);
  const target = splitLines(content);
  if (target.length > BLAME_MAX_LINES + 1) throw new WeaveError(`file too large for blame (${target.length} lines, limit ${BLAME_MAX_LINES})`, 413);
  const all = (repo.s.files[path] ?? []).filter((v) => v.rev <= rev);
  // start after the last deletion: re-adding a file makes every line new
  let start = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].content === null) {
      start = i + 1;
      break;
    }
  }
  let truncated = false;
  if (all.length - start > BLAME_MAX_VERSIONS) {
    start = all.length - BLAME_MAX_VERSIONS;
    truncated = true;
  }
  let prev = splitLines(all[start].content!);
  let attr: number[] = prev.map(() => all[start].rev);
  for (let i = start + 1; i < all.length; i++) {
    const v = all[i];
    const next = splitLines(v.content!);
    const out: number[] = [];
    let pos = 0;
    for (const h of compactHunks(prev, diffHunks(prev, next))) {
      for (; pos < h.start; pos++) out.push(attr[pos]);
      for (let k = 0; k < h.lines.length; k++) out.push(v.rev);
      pos = h.end;
    }
    for (; pos < prev.length; pos++) out.push(attr[pos]);
    attr = out;
    prev = next;
  }
  const cm = commitMap(repo);
  const n = viewLines(content).length;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const c = cm.get(attr[i]);
    lines.push({ n: i + 1, text: target[i], rev: attr[i], agent: c?.agent ?? null, ts: c?.ts ?? null, message: c?.message ?? null });
  }
  return truncated ? { path, rev, lines, truncated } : { path, rev, lines };
}

// ---- search ------------------------------------------------------------------------------------
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// a quantified group that itself contains a quantifier, e.g. (a+)+ or (.*)* : the classic catastrophic shapes
const NESTED_QUANT = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,\d*\})/;

export interface SearchOpts {
  q?: string | null;
  regex?: string | null;
  caseSensitive?: string | null;
  path?: string | null;
  limit?: string | null;
}

export function search(repo: Repo, opts: SearchOpts, now: () => number = Date.now) {
  const q = opts.q ?? "";
  if (!q) throw new WeaveError("q is required", 400);
  if (q.length > SEARCH_MAX_PATTERN) throw new WeaveError(`pattern too long (max ${SEARCH_MAX_PATTERN} characters)`, 400);
  const limit = parseLimit(opts.limit ?? null, 100, 1000);
  const isRegex = flag(opts.regex ?? null);
  let re: RegExp;
  if (isRegex && NESTED_QUANT.test(q)) throw new WeaveError("regex rejected: nested quantifiers can backtrack catastrophically", 400);
  try {
    re = new RegExp(isRegex ? q : escapeRe(q), flag(opts.caseSensitive ?? null) ? "g" : "gi");
  } catch (e) {
    throw new WeaveError(`invalid regex: ${(e as Error).message}`, 400);
  }
  const glob = (opts.path ?? "").trim();
  const results: { path: string; line: number; text: string; matchStart: number; matchEnd: number }[] = [];
  let total = 0;
  let cut = false;
  const deadline = now() + SEARCH_BUDGET_MS;
  scan: for (const p of repo.listFiles()) {
    if (glob && !globMatch(p, glob)) continue;
    const content = repo.fileAt(p, repo.s.rev)!;
    if (content.length > SEARCH_MAX_FILE_BYTES || !isText(content)) continue;
    const lines = viewLines(content);
    for (let i = 0; i < lines.length; i++) {
      if ((i & 63) === 0 && now() > deadline) {
        cut = true;
        break scan;
      }
      const text = lines[i];
      const hay = text.length > SEARCH_MAX_LINE ? text.slice(0, SEARCH_MAX_LINE) : text;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(hay))) {
        if (m[0] === "") {
          re.lastIndex++;
          if (re.lastIndex > hay.length) break;
          continue;
        }
        total++;
        if (results.length < limit) results.push({ path: p, line: i + 1, text, matchStart: m.index, matchEnd: m.index + m[0].length });
        break; // one result per line
      }
    }
  }
  return { q, rev: repo.s.rev, total, truncated: cut || total > results.length, results };
}

// ---- readme / stats ----------------------------------------------------------------------------
export function readme(repo: Repo) {
  const cands = repo.listFiles().filter((p) => !p.includes("/") && /^readme(\.[a-z]+)?$/i.test(p));
  const rank = (p: string) => (/\.md$/i.test(p) ? 0 : /\.markdown$/i.test(p) ? 1 : !p.includes(".") ? 2 : 3);
  cands.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  const path = cands[0];
  if (!path) return { path: null };
  return { path, rev: repo.s.rev, content: repo.fileAt(path, repo.s.rev)! };
}

export function stats(repo: Repo) {
  const files = repo.listFiles();
  let loc = 0;
  const byExt = new Map<string, number>();
  for (const p of files) {
    const c = repo.fileAt(p, repo.s.rev)!;
    if (isText(c)) loc += viewLines(c).length;
    const e = extOf(p) || "none";
    byExt.set(e, (byExt.get(e) ?? 0) + 1);
  }
  const ranked = [...byExt].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const languages: Record<string, number> = {};
  for (const [e, n] of ranked.slice(0, 8)) languages[e] = n;
  const rest = ranked.slice(8).reduce((n, [, k]) => n + k, 0);
  if (rest) languages.other = rest;
  const by = new Map<string, { agent: string; commits: number; lastTs: number }>();
  for (const c of repo.s.commits) {
    const x = by.get(c.agent) ?? { agent: c.agent, commits: 0, lastTs: 0 };
    x.commits++;
    x.lastTs = Math.max(x.lastTs, c.ts);
    by.set(c.agent, x);
  }
  const contributors = [...by.values()].sort((a, b) => b.commits - a.commits || (a.agent < b.agent ? -1 : 1));
  const sessions = Object.values(repo.s.sessions);
  return {
    files: files.length, loc, languages, commits: repo.s.commits.length, contributors,
    sessions: { live: sessions.filter((s) => LIVE.includes(s.status)).length, landed: sessions.filter((s) => s.status === "landed").length },
  };
}

// ---- router ------------------------------------------------------------------------------------
/** Handles only the GET browse routes; returns undefined for everything else. */
export function routeBrowse(c: Ctx): unknown | undefined {
  if (c.method !== "GET") return undefined;
  const [a, id, extra] = c.parts;
  const g = (k: string) => c.url.searchParams.get(k);
  if (extra !== undefined) return undefined;
  if (id === undefined) {
    switch (a) {
      case "tree": return tree(c.repo, { path: g("path"), rev: g("rev") });
      case "blob": return blob(c.repo, { path: g("path"), rev: g("rev") });
      case "history": return history(c.repo, { path: g("path"), limit: g("limit"), before: g("before") });
      case "diff": return diff(c.repo, { from: g("from"), to: g("to"), path: g("path") });
      case "blame": return blame(c.repo, { path: g("path"), rev: g("rev") });
      case "search": return search(c.repo, { q: g("q"), regex: g("regex"), caseSensitive: g("caseSensitive"), path: g("path"), limit: g("limit") });
      case "readme": return readme(c.repo);
      case "stats": return stats(c.repo);
    }
  } else if (a === "commit") return commit(c.repo, decodeURIComponent(id));
  return undefined;
}
