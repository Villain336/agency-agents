// Deterministic git object model derived from Weave state.
// Every Weave commit rev becomes exactly one git commit; ids depend only on committed content.
import type { Repo, Session } from "../repo.ts";
import { concat, dec, enc, fromHex } from "./bytes.ts";
import { hashObject } from "./sha1.ts";
import type { GitObj } from "./pack.ts";

type Version = { rev: number; content: string | null };
export type Lookup = (id: string) => GitObj | undefined;

interface Cache {
  objs: Map<string, GitObj>;
  commits: Map<number, string>;
  revOf: Map<string, number>;
  blobs: WeakMap<Version, string>;
}
const caches = new WeakMap<object, Cache>();

export const OPEN_STATUSES = ["active", "conflicted", "needs_verify", "verifying", "in_review"];
export const SESSION_PREFIX = "refs/weave/sessions/";
export const MAIN_REF = "refs/heads/main";

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

export const ident = (agent: string, ts: number): string => {
  const who = agent.replace(/[<>\n]/g, "");
  return `${who} <${who.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@weave.agents> ${Math.floor(ts / 1000)} +0000`;
};

export interface ParsedCommit { tree: string; parents: string[]; author: string; message: string }
export function parseCommit(data: Uint8Array): ParsedCommit {
  const text = dec.decode(data);
  const split = text.indexOf("\n\n");
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? "" : text.slice(split + 2);
  let tree = "", author = "";
  const parents: string[] = [];
  for (const line of head.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5);
    else if (line.startsWith("parent ")) parents.push(line.slice(7));
    else if (line.startsWith("author ")) author = line.slice(7);
  }
  if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error("malformed commit: no tree");
  return { tree, parents, author, message };
}

export interface TreeEntry { mode: string; name: string; id: string }
export function parseTree(data: Uint8Array): TreeEntry[] {
  const out: TreeEntry[] = [];
  let p = 0;
  while (p < data.length) {
    const sp = data.indexOf(32, p);
    const nul = data.indexOf(0, sp);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new Error("malformed tree");
    let id = "";
    for (let i = 0; i < 20; i++) id += data[nul + 1 + i].toString(16).padStart(2, "0");
    out.push({ mode: dec.decode(data.subarray(p, sp)), name: dec.decode(data.subarray(sp + 1, nul)), id });
    p = nul + 21;
  }
  return out;
}

/** Flatten a tree into path -> {mode, id}; throws on a missing object. */
export function flattenTree(lookup: Lookup, treeId: string, prefix = "", out = new Map<string, { mode: string; id: string }>()) {
  const t = lookup(treeId);
  if (!t || t.type !== 2) throw new Error(`missing tree ${treeId}`);
  for (const e of parseTree(t.data)) {
    if (e.mode === "40000") flattenTree(lookup, e.id, `${prefix}${e.name}/`, out);
    else out.set(prefix + e.name, { mode: e.mode, id: e.id });
  }
  return out;
}

export class GitView {
  repo: Repo;
  private c: Cache;
  /** per-request objects (session synthetic commits and their trees) */
  private extra = new Map<string, GitObj>();
  private sessionBase = new Map<string, { id: string; baseRev: number }>();

  constructor(repo: Repo) {
    this.repo = repo;
    let c = caches.get(repo.s);
    if (!c) caches.set(repo.s, (c = { objs: new Map(), commits: new Map(), revOf: new Map(), blobs: new WeakMap() }));
    this.c = c;
  }

  private put(type: 1 | 2 | 3, data: Uint8Array, shared: boolean): string {
    const id = hashObject(type === 1 ? "commit" : type === 2 ? "tree" : "blob", data);
    if (!this.c.objs.has(id)) (shared ? this.c.objs : this.extra).set(id, { type, data });
    return id;
  }

  get = (id: string): GitObj | undefined => this.c.objs.get(id) ?? this.extra.get(id);

  private blobOf(content: string, shared: boolean): string {
    return this.put(3, enc.encode(content), shared);
  }

  private versionAt(path: string, rev: number): Version | null {
    const v = this.repo.s.files[path];
    if (!v) return null;
    for (let i = v.length - 1; i >= 0; i--) if (v[i].rev <= rev) return v[i].content === null ? null : v[i];
    return null;
  }

  /** path -> blob id at a trunk revision. */
  flatAt(rev: number): Map<string, string> {
    const flat = new Map<string, string>();
    for (const path of Object.keys(this.repo.s.files).sort()) {
      const v = this.versionAt(path, rev);
      if (!v) continue;
      let id = this.c.blobs.get(v);
      if (!id) this.c.blobs.set(v, (id = this.blobOf(v.content as string, true)));
      flat.set(path, id);
    }
    return flat;
  }

  private treeFrom(flat: Map<string, string>, shared: boolean): string {
    type Node = { files: Map<string, string>; dirs: Map<string, Node> };
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, id] of flat) {
      const parts = path.split("/");
      let n = root;
      for (let i = 0; i < parts.length - 1; i++) {
        let d = n.dirs.get(parts[i]);
        if (!d) n.dirs.set(parts[i], (d = { files: new Map(), dirs: new Map() }));
        n = d;
      }
      n.files.set(parts[parts.length - 1], id);
    }
    const build = (n: Node): string => {
      const ents: { key: Uint8Array; head: Uint8Array; id: string }[] = [];
      for (const [name, id] of n.files) ents.push({ key: enc.encode(name), head: enc.encode(`100644 ${name}\0`), id });
      for (const [name, d] of n.dirs) ents.push({ key: enc.encode(name + "/"), head: enc.encode(`40000 ${name}\0`), id: build(d) });
      ents.sort((a, b) => cmpBytes(a.key, b.key));
      return this.put(2, concat(ents.flatMap((e) => [e.head, fromHex(e.id)])), shared);
    };
    return build(root);
  }

  private commitObj(tree: string, parent: string | null, agent: string, ts: number, message: string, shared: boolean): string {
    const who = ident(agent, ts);
    const text = `tree ${tree}\n${parent ? `parent ${parent}\n` : ""}author ${who}\ncommitter ${who}\n\n${message}`;
    return this.put(1, enc.encode(text), shared);
  }

  /** Git commit id for a Weave rev (null for rev 0 = empty history). */
  commitSha(rev: number): string | null {
    if (rev <= 0) return null;
    const hit = this.c.commits.get(rev);
    if (hit) return hit;
    const s = this.repo.s;
    const idx = s.commits[rev - 1]?.rev === rev ? rev - 1 : s.commits.findIndex((x) => x.rev === rev);
    if (idx < 0) throw new Error(`no such rev ${rev}`);
    const c = s.commits[idx];
    const parent = idx > 0 ? this.commitSha(s.commits[idx - 1].rev) : null;
    const tree = this.treeFrom(this.flatAt(rev), true);
    const message = `${c.message}\n\nWeave-Session: ${c.sessionId}\nWeave-Rev: r${c.rev}${c.merged ? "\nWeave-Merged: concurrent changes auto-merged" : ""}`;
    const id = this.commitObj(tree, parent, c.agent, c.ts, message, true);
    this.c.commits.set(rev, id);
    this.c.revOf.set(id, rev);
    return id;
  }

  /** Builds every trunk commit so sha -> rev lookups are complete. */
  ensureAll(): void {
    this.commitSha(this.repo.s.rev);
  }

  revOf(id: string): number | undefined {
    return this.c.revOf.get(id);
  }
  sessionBaseOf(id: string): number | undefined {
    return this.sessionBase.get(id)?.baseRev;
  }

  /** Synthetic commit for an open session: base tree + overlay. */
  sessionCommit(s: Session): string {
    const flat = this.flatAt(s.baseRev);
    for (const [p, content] of Object.entries(s.edits)) {
      if (content === null) flat.delete(p);
      else flat.set(p, this.blobOf(content, false));
    }
    const tree = this.treeFrom(flat, false);
    const message = `${s.goal}\n\nWeave-Session: ${s.id}\nWeave-Base: r${s.baseRev}\nWeave-Status: ${s.status}`;
    const id = this.commitObj(tree, this.commitSha(s.baseRev), s.agent, s.createdAt, message, false);
    this.sessionBase.set(id, { id: s.id, baseRev: s.baseRev });
    return id;
  }

  mainSha(): string | null {
    return this.commitSha(this.repo.s.rev);
  }

  /** All advertised refs (excluding HEAD), sorted. */
  refs(): { name: string; id: string }[] {
    const out: { name: string; id: string }[] = [];
    const main = this.mainSha();
    if (main) out.push({ name: MAIN_REF, id: main });
    const sessions = Object.values(this.repo.s.sessions).filter((s) => OPEN_STATUSES.includes(s.status));
    for (const s of sessions) out.push({ name: SESSION_PREFIX + s.id, id: this.sessionCommit(s) });
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Every object reachable from `roots`, skipping ids in `exclude`. Ordered commits, trees, blobs. */
  collect(roots: string[], exclude: Set<string> = new Set()): { id: string; obj: GitObj }[] {
    const seen = new Set(exclude);
    const commits: { id: string; obj: GitObj }[] = [], trees: typeof commits = [], blobs: typeof commits = [];
    const stack = [...roots];
    while (stack.length) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      const obj = this.get(id);
      if (!obj) continue;
      seen.add(id);
      if (obj.type === 1) {
        commits.push({ id, obj });
        const pc = parseCommit(obj.data);
        stack.push(pc.tree, ...pc.parents);
      } else if (obj.type === 2) {
        trees.push({ id, obj });
        for (const e of parseTree(obj.data)) stack.push(e.id);
      } else blobs.push({ id, obj });
    }
    return [...commits, ...trees, ...blobs];
  }

  closure(roots: string[]): Set<string> {
    return new Set(this.collect(roots).map((x) => x.id));
  }
}
