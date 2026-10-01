// Incremental persistence for a Repo on Durable Object SQLite, with optional blob offload (R2).
// Append-only data (commits, file versions, events) is written once; sessions are written only when
// touched; the small collections (identities, comments, jobs, outbox) and metadata are diffed
// against what was last written. Large file contents go to a content-addressed blob store.

import { sha256 } from "./crypto.ts";
import { Repo, upgradeState, emptyState, type State, type Session } from "./repo.ts";

export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): any[] };
}
export interface BlobStore {
  put(key: string, text: string): Promise<void>;
  get(key: string): Promise<string | null>;
}
export interface StoreOptions {
  sql: SqlLike;
  transactionSync: (fn: () => void) => void;
  blobs?: BlobStore;
  /** contents longer than this (chars) are offloaded to the blob store when one is configured */
  inlineMax?: number;
}

const MAX_ROW = 1_900_000; // SQLite rows in Durable Objects are limited to ~2 MB
const SMALL = ["identities", "comments", "jobs", "tasks", "tags", "releases", "teams", "runs", "packages"] as const;
const META = ["config", "secrets", "auditHead", "mirror", "seq", "rev", "reviewPaths"] as const;

type Packed = { kind: 0 | 1 | 2; content: string | null; blob: string | null };

export class Store {
  private sql: SqlLike;
  private tx: (fn: () => void) => void;
  private blobs?: BlobStore;
  private inlineMax: number;
  private cache = new Map<string, string>();
  private persistedRev = 0;
  private persistedEvent = 0;

  constructor(o: StoreOptions) {
    this.sql = o.sql;
    this.tx = o.transactionSync;
    this.blobs = o.blobs;
    this.inlineMax = o.inlineMax ?? 100_000;
    for (const q of [
      "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS commits (rev INTEGER PRIMARY KEY, json TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS file_versions (path TEXT NOT NULL, rev INTEGER NOT NULL, kind INTEGER NOT NULL, content TEXT, blob TEXT, PRIMARY KEY (path, rev))",
      "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, json TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS session_edits (sid TEXT NOT NULL, path TEXT NOT NULL, kind INTEGER NOT NULL, content TEXT, blob TEXT, PRIMARY KEY (sid, path))",
      "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, json TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS docs (coll TEXT NOT NULL, k TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (coll, k))",
    ])
      this.sql.exec(q);
  }

  private async pack(text: string | null, pending: Map<string, string>): Promise<Packed> {
    if (text === null) return { kind: 0, content: null, blob: null };
    if (this.blobs && text.length > this.inlineMax) {
      const key = `blob/${sha256(text)}`;
      pending.set(key, text);
      return { kind: 2, content: null, blob: key };
    }
    if (text.length > MAX_ROW) throw new Error(`file too large to store inline (${text.length} chars); configure a blob store`);
    return { kind: 1, content: text, blob: null };
  }
  private async unpack(kind: number, content: string | null, blob: string | null): Promise<string | null> {
    if (kind === 0) return null;
    if (kind === 1) return content ?? "";
    const t = await this.blobs?.get(blob!);
    if (t == null) throw new Error(`missing blob ${blob}`);
    return t;
  }

  /** True if nothing has ever been saved. */
  isEmpty(): boolean {
    return this.sql.exec("SELECT v FROM meta WHERE k = 'rev'").toArray().length === 0;
  }

  async load(): Promise<State> {
    if (this.isEmpty()) return emptyState();
    const s: any = {};
    for (const r of this.sql.exec("SELECT k, v FROM meta").toArray()) {
      s[r.k] = JSON.parse(r.v);
      this.cache.set("meta:" + r.k, r.v);
    }
    s.commits = this.sql.exec("SELECT json FROM commits ORDER BY rev").toArray().map((r) => JSON.parse(r.json));
    s.files = {};
    for (const r of this.sql.exec("SELECT path, rev, kind, content, blob FROM file_versions ORDER BY path, rev").toArray())
      (s.files[r.path] ??= []).push({ rev: r.rev, content: await this.unpack(r.kind, r.content, r.blob) });
    s.sessions = {};
    for (const r of this.sql.exec("SELECT id, json FROM sessions").toArray()) {
      const x: Session = JSON.parse(r.json);
      x.edits = {};
      s.sessions[r.id] = x;
    }
    for (const r of this.sql.exec("SELECT sid, path, kind, content, blob FROM session_edits").toArray())
      if (s.sessions[r.sid]) s.sessions[r.sid].edits[r.path] = await this.unpack(r.kind, r.content, r.blob);
    s.events = this.sql.exec("SELECT json FROM events ORDER BY id DESC LIMIT 500").toArray().map((r) => JSON.parse(r.json)).reverse();
    for (const c of SMALL) {
      s[c] = {};
      for (const r of this.sql.exec("SELECT k, json FROM docs WHERE coll = ?", c).toArray()) {
        s[c][r.k] = JSON.parse(r.json);
        this.cache.set(`${c}:${r.k}`, r.json);
      }
    }
    s.outbox = [];
    for (const r of this.sql.exec("SELECT k, json FROM docs WHERE coll = 'outbox' ORDER BY k").toArray()) {
      s.outbox.push(JSON.parse(r.json));
      this.cache.set(`outbox:${r.k}`, r.json);
    }
    s.outbox.sort((a: any, b: any) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
    s.notifications = [];
    for (const r of this.sql.exec("SELECT k, json FROM docs WHERE coll = 'notifications'").toArray()) {
      s.notifications.push(JSON.parse(r.json));
      this.cache.set(`notifications:${r.k}`, r.json);
    }
    s.notifications.sort((a: any, b: any) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
    const st = upgradeState(s);
    this.persistedRev = st.rev;
    this.persistedEvent = st.seq.event;
    return st;
  }

  /** Wipe all persisted data (used when a repo is reset). */
  reset() {
    this.tx(() => {
      for (const tbl of ["meta", "commits", "file_versions", "sessions", "session_edits", "events", "docs"]) this.sql.exec(`DELETE FROM ${tbl}`);
    });
    this.cache = new Map();
    this.persistedRev = 0;
    this.persistedEvent = 0;
  }

  /**
   * Persist everything that changed since the last save. The change set is captured synchronously
   * up front (so concurrent requests that mutate the repo while we await blob uploads are never
   * half-written or lost); callers must serialize calls to save().
   */
  async save(repo: Repo): Promise<{ rows: number }> {
    const st = repo.s;
    const snapRev = st.rev;
    const snapEvent = st.seq.event;
    const dirty = new Set(repo.dirtySessions);
    repo.dirtySessions.clear();
    const pending = new Map<string, string>();
    const writes: (() => void)[] = [];
    const run = (q: string, ...b: unknown[]) => writes.push(() => void this.sql.exec(q, ...b));
    try {
      // append-only: commits and the file versions they created
      for (const c of st.commits) {
        if (c.rev <= this.persistedRev || c.rev > snapRev) continue;
        run("INSERT OR REPLACE INTO commits (rev, json) VALUES (?, ?)", c.rev, JSON.stringify(c));
        for (const p of c.paths) {
          const v = st.files[p]?.find((x) => x.rev === c.rev);
          const pk = await this.pack(v ? v.content : null, pending);
          run("INSERT OR REPLACE INTO file_versions (path, rev, kind, content, blob) VALUES (?, ?, ?, ?, ?)", p, c.rev, pk.kind, pk.content, pk.blob);
        }
      }
      for (const e of st.events) if (e.id > this.persistedEvent && e.id <= snapEvent) run("INSERT OR REPLACE INTO events (id, json) VALUES (?, ?)", e.id, JSON.stringify(e));

      // sessions: only those touched
      for (const id of dirty) {
        const x = st.sessions[id];
        if (!x) continue;
        const { edits, ...rest } = x;
        run("INSERT OR REPLACE INTO sessions (id, json) VALUES (?, ?)", id, JSON.stringify(rest));
        run("DELETE FROM session_edits WHERE sid = ?", id);
        for (const [path, content] of Object.entries(edits)) {
          const pk = await this.pack(content, pending);
          run("INSERT INTO session_edits (sid, path, kind, content, blob) VALUES (?, ?, ?, ?, ?)", id, path, pk.kind, pk.content, pk.blob);
        }
      }

      // small collections + metadata: diff against the last written JSON
      const docs: [string, Record<string, unknown>][] = [
        ["identities", st.identities], ["comments", st.comments], ["jobs", st.jobs], ["tasks", st.tasks], ["tags", st.tags], ["releases", st.releases], ["teams", st.teams], ["runs", st.runs], ["packages", st.packages],
        ["notifications", Object.fromEntries(st.notifications.map((n) => [n.id, n]))],
        ["outbox", Object.fromEntries(st.outbox.map((o) => [o.id, o]))],
      ];
      const newCache = new Map<string, string>();
      for (const [coll, rows] of docs) {
        for (const [k, v] of Object.entries(rows)) {
          const j = JSON.stringify(v);
          newCache.set(`${coll}:${k}`, j);
          if (this.cache.get(`${coll}:${k}`) !== j) run("INSERT OR REPLACE INTO docs (coll, k, json) VALUES (?, ?, ?)", coll, k, j);
        }
      }
      for (const key of this.cache.keys()) {
        if (key.startsWith("meta:") || newCache.has(key)) continue;
        const i = key.indexOf(":");
        run("DELETE FROM docs WHERE coll = ? AND k = ?", key.slice(0, i), key.slice(i + 1));
      }
      for (const m of META) {
        const j = JSON.stringify((st as any)[m]);
        newCache.set("meta:" + m, j);
        if (this.cache.get("meta:" + m) !== j) run("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", m, j);
      }

      // blobs first (content-addressed, idempotent), then one atomic SQL transaction
      for (const [k, v] of pending) await this.blobs!.put(k, v);
      this.tx(() => writes.forEach((w) => w()));
      this.cache = newCache;
      this.persistedRev = snapRev;
      this.persistedEvent = snapEvent;
      return { rows: writes.length };
    } catch (e) {
      for (const id of dirty) repo.dirtySessions.add(id); // retry on the next save
      throw e;
    }
  }
}
