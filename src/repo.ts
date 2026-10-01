// Weave core: trunk + agent sessions. Pure logic, no Cloudflare APIs, so it is easy to test.
// Model: there is one trunk. Agents never create branches; they open a *session* pinned to a
// trunk revision, edit an overlay, declare intent, and land atomically via a 3-way merge
// against whatever trunk is *now*. Conflicts come back as structured data an agent can resolve.

import { merge3, resolveSegments, splitLines, type Choice, type Segment } from "./merge.ts";

export type Status = "active" | "conflicted" | "in_review" | "landed" | "rejected";

export interface Conflict {
  path: string;
  kind: "text" | "delete-modify" | "add-add";
  segments: Segment[];
}

export interface Session {
  id: string;
  agent: string;
  goal: string;
  baseRev: number;
  /** path -> new content, or null for deletion */
  edits: Record<string, string | null>;
  /** per-path rebase point, set when a conflict on that path was resolved */
  pathBase: Record<string, number>;
  intent: string[];
  status: Status;
  conflicts: Conflict[];
  reviewer?: string;
  landedRev?: number;
  createdAt: number;
}

export interface Commit {
  rev: number;
  sessionId: string;
  agent: string;
  message: string;
  paths: string[];
  /** true when the merge had to combine changes made concurrently by others */
  merged: boolean;
  ts: number;
}

export interface WeaveEvent {
  id: number;
  ts: number;
  type: string;
  agent?: string;
  session?: string;
  message: string;
}

export interface State {
  rev: number;
  /** path -> versions, ascending by rev; content null = deleted */
  files: Record<string, { rev: number; content: string | null }[]>;
  commits: Commit[];
  sessions: Record<string, Session>;
  events: WeaveEvent[];
  reviewPaths: string[];
}

export class WeaveError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export const emptyState = (): State => ({ rev: 0, files: {}, commits: [], sessions: {}, events: [], reviewPaths: [] });

export class Repo {
  s: State;
  private now: () => number;
  constructor(s: State = emptyState(), now: () => number = Date.now) {
    this.s = s;
    this.now = now;
  }

  // ---- trunk ----------------------------------------------------------
  fileAt(path: string, rev: number): string | null {
    const v = this.s.files[path];
    if (!v) return null;
    for (let i = v.length - 1; i >= 0; i--) if (v[i].rev <= rev) return v[i].content;
    return null;
  }
  head(path: string) {
    return this.fileAt(path, this.s.rev);
  }
  listFiles(rev = this.s.rev): string[] {
    return Object.keys(this.s.files).filter((p) => this.fileAt(p, rev) !== null).sort();
  }

  private commit(sessionId: string, agent: string, message: string, changes: Record<string, string | null>, merged: boolean) {
    const rev = ++this.s.rev;
    for (const [p, content] of Object.entries(changes)) (this.s.files[p] ??= []).push({ rev, content });
    this.s.commits.push({ rev, sessionId, agent, message, paths: Object.keys(changes), merged, ts: this.now() });
    return rev;
  }

  /** Seed trunk directly (no session). */
  seed(files: Record<string, string>, message = "seed") {
    return this.commit("seed", "system", message, files, false);
  }

  setReviewPaths(paths: string[]) {
    this.s.reviewPaths = paths;
  }

  private log(type: string, message: string, s?: Session) {
    this.s.events.push({ id: this.s.events.length + 1, ts: this.now(), type, message, agent: s?.agent, session: s?.id });
    if (this.s.events.length > 500) this.s.events.splice(0, this.s.events.length - 500);
  }

  // ---- sessions -------------------------------------------------------
  session(id: string): Session {
    const s = this.s.sessions[id];
    if (!s) throw new WeaveError(`no such session: ${id}`, 404);
    return s;
  }

  open(opts: { id?: string; agent: string; goal: string; intent?: string[] }): { session: Session; warnings: string[] } {
    const id = opts.id ?? `${opts.agent}-${Object.keys(this.s.sessions).length + 1}`;
    const existing = this.s.sessions[id];
    if (existing && (existing.status === "active" || existing.status === "conflicted" || existing.status === "in_review"))
      throw new WeaveError(`session ${id} is still ${existing.status}`, 409);
    const session: Session = {
      id, agent: opts.agent, goal: opts.goal, baseRev: this.s.rev, edits: {}, pathBase: {},
      intent: opts.intent ?? [], status: "active", conflicts: [], createdAt: this.now(),
    };
    this.s.sessions[id] = session;
    this.log("open", `${opts.agent} started: ${opts.goal}`, session);
    return { session, warnings: this.declare(id, session.intent, true) };
  }

  /** Declare which paths this session intends to touch; returns overlap warnings with live sessions. */
  declare(id: string, paths: string[], quiet = false): string[] {
    const s = this.session(id);
    s.intent = [...new Set([...s.intent, ...paths])];
    const warnings: string[] = [];
    for (const o of Object.values(this.s.sessions)) {
      if (o.id === id || o.status === "landed" || o.status === "rejected") continue;
      const overlap = s.intent.filter((p) => o.intent.includes(p) || p in o.edits);
      if (overlap.length) warnings.push(`${o.agent} is also working on ${overlap.join(", ")} (${o.goal})`);
    }
    if (!quiet && paths.length) this.log("intent", `${s.agent} intends to touch ${paths.join(", ")}`, s);
    if (warnings.length) this.log("overlap", `heads-up for ${s.agent}: ${warnings.join("; ")}`, s);
    return warnings;
  }

  read(id: string, path: string): string | null {
    const s = this.session(id);
    return path in s.edits ? s.edits[path] : this.fileAt(path, s.baseRev);
  }

  write(id: string, path: string, content: string | null) {
    const s = this.session(id);
    if (s.status === "landed" || s.status === "rejected") throw new WeaveError(`session ${id} is ${s.status}`, 409);
    if (s.status === "conflicted") throw new WeaveError(`session ${id} has unresolved conflicts; resolve them first`, 409);
    s.edits[path] = content;
    if (!s.intent.includes(path)) s.intent.push(path);
    s.status = "active";
  }

  // ---- landing --------------------------------------------------------
  private mergeAll(s: Session): { changes: Record<string, string | null>; conflicts: Conflict[]; merged: boolean } {
    const changes: Record<string, string | null> = {};
    const conflicts: Conflict[] = [];
    let merged = false;
    for (const [path, theirs] of Object.entries(s.edits)) {
      const baseRev = s.pathBase[path] ?? s.baseRev;
      const base = this.fileAt(path, baseRev);
      const ours = this.head(path);
      if (theirs === ours) { if (ours !== base) merged = true; continue; } // already on trunk
      if (ours === base) { changes[path] = theirs; continue; } // trunk untouched: fast-forward
      merged = true;
      const whole = (kind: Conflict["kind"]) =>
        conflicts.push({ path, kind, segments: [{ kind: "conflict", base: splitLines(base ?? ""), ours: splitLines(ours ?? ""), theirs: splitLines(theirs ?? "") }] });
      if (base === null) { whole("add-add"); continue; }
      if (ours === null || theirs === null) { whole("delete-modify"); continue; }
      const r = merge3(base, ours, theirs);
      if (r.conflicts) conflicts.push({ path, kind: "text", segments: r.segments });
      else changes[path] = r.text;
    }
    return { changes, conflicts, merged };
  }

  /** Try to land a session onto trunk atomically. */
  submit(id: string, message?: string): { status: Status; rev?: number; conflicts?: Conflict[] } {
    const s = this.session(id);
    if (s.status === "landed" || s.status === "rejected") throw new WeaveError(`session ${id} is ${s.status}`, 409);
    if (s.status === "in_review") return { status: "in_review" };
    if (!Object.keys(s.edits).length) throw new WeaveError("nothing to land: session has no edits");
    const r = this.mergeAll(s);
    if (r.conflicts.length) {
      s.status = "conflicted";
      s.conflicts = r.conflicts;
      this.log("conflict", `${s.agent} hit ${r.conflicts.length} conflict(s) in ${r.conflicts.map((c) => c.path).join(", ")}`, s);
      return { status: "conflicted", conflicts: r.conflicts };
    }
    s.conflicts = [];
    const gated = Object.keys(s.edits).filter((p) => this.s.reviewPaths.some((rp) => p.startsWith(rp)));
    if (gated.length && !s.reviewer) {
      s.status = "in_review";
      this.log("review_requested", `${s.agent}'s change touches protected path(s) ${gated.join(", ")}; awaiting review`, s);
      return { status: "in_review" };
    }
    if (!Object.keys(r.changes).length) {
      // every edit already matches trunk: nothing to commit
      s.status = "landed";
      s.landedRev = this.s.rev;
      this.log("noop", `${s.agent}'s change was already on trunk; nothing to land`, s);
      return { status: "landed" as Status, rev: this.s.rev };
    }
    return this.land(s, r.changes, r.merged, message);
  }

  private land(s: Session, changes: Record<string, string | null>, merged: boolean, message?: string) {
    const msg = message ?? s.goal;
    s.landedRev = this.commit(s.id, s.agent, msg, changes, merged);
    s.status = "landed";
    this.log("landed", `${s.agent} landed r${s.landedRev}${merged ? " (auto-merged with concurrent work)" : ""}: ${msg}`, s);
    return { status: "landed" as Status, rev: s.landedRev };
  }

  /** Resolve conflicts on one path with explicit choices or a blanket strategy; keeps the session open. */
  resolve(id: string, path: string, how: Choice[] | "ours" | "theirs" | "both") {
    const s = this.session(id);
    const c = s.conflicts.find((x) => x.path === path);
    if (!c) throw new WeaveError(`no conflict on ${path}`, 404);
    const n = c.segments.filter((x) => x.kind === "conflict").length;
    const choices = typeof how === "string" ? Array<Choice>(n).fill(how) : how;
    if (c.kind !== "text") {
      const ch = choices[0];
      const seg = c.segments[0] as Extract<Segment, { kind: "conflict" }>;
      const pick = ch === "ours" ? seg.ours : ch === "theirs" ? seg.theirs : ch === "both" ? [...seg.ours, ...seg.theirs] : splitLines((ch as { text: string }).text);
      const deleted = (ch === "ours" && this.head(path) === null) || (ch === "theirs" && s.edits[path] === null);
      s.edits[path] = deleted ? null : pick.join("\n");
    } else s.edits[path] = resolveSegments(c.segments, choices);
    s.pathBase[path] = this.s.rev;
    s.conflicts = s.conflicts.filter((x) => x !== c);
    this.log("resolve", `${s.agent} resolved ${path}`, s);
    if (!s.conflicts.length) s.status = "active";
    return s;
  }

  review(id: string, reviewer: string, approve: boolean, note = "") {
    const s = this.session(id);
    if (s.status !== "in_review") throw new WeaveError(`session ${id} is not awaiting review`, 409);
    if (!approve) {
      s.status = "rejected";
      this.log("rejected", `${reviewer} rejected ${s.agent}'s change${note ? `: ${note}` : ""}`, s);
      return { status: s.status };
    }
    s.reviewer = reviewer;
    this.log("approved", `${reviewer} approved ${s.agent}'s change`, s);
    s.status = "active";
    return this.submit(id); // re-merge against *current* trunk; approval never lands a stale diff
  }

  abandon(id: string) {
    const s = this.session(id);
    s.status = "rejected";
    this.log("abandoned", `${s.agent} abandoned their session`, s);
  }
}
