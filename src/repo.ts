// Weave core: trunk + agent sessions. Pure, synchronous logic with no Cloudflare APIs, so it is easy
// to test. Model: there is one trunk per shard. Agents never create branches; they open a *session*
// pinned to a trunk revision, edit an overlay, declare intent, and land atomically via a 3-way merge
// against whatever trunk is *now*. Landing is gated by policy: required checks (run by pull-based
// runners), a semantic-interaction gate, and risk-tiered review. Every landed commit carries a
// signed, hash-chained provenance record.

import { canonical, hmacSha256, randomToken, sha256 } from "./crypto.ts";
import { diffStat, fileDiff, type FileDiff } from "./diff.ts";
import { diffHunks, merge3, resolveSegments, splitLines, type MergeOptions, type Choice, type Segment } from "./merge.ts";
import { DEFAULT_POLICY, scoreRisk, type Need, type Policy, type RiskReport } from "./review.ts";
import { semanticRisk, symbols, type Risk } from "./semantic.ts";
import { shardOf } from "./shard.ts";

export type Status = "active" | "conflicted" | "needs_verify" | "verifying" | "in_review" | "landed" | "rejected";
export const LIVE: Status[] = ["active", "conflicted", "needs_verify", "verifying", "in_review"];

export type Kind = "agent" | "human" | "verifier" | "reviewer" | "runner" | "admin";
export type Scope = "read" | "write" | "review" | "verify" | "runner" | "admin";

export const DEFAULT_SCOPES: Record<Kind, Scope[]> = {
  agent: ["read", "write"],
  human: ["read", "write", "review"],
  verifier: ["read", "verify"],
  reviewer: ["read", "review"],
  runner: ["read", "runner"],
  admin: ["read", "write", "review", "verify", "runner", "admin"],
};

export interface Identity {
  id: string;
  name: string;
  kind: Kind;
  scopes: Scope[];
  /** path prefixes this identity may write; empty = anywhere */
  paths: string[];
  budget: { sessionsPerHour?: number; landsPerHour?: number };
  model?: string;
  tokenHash: string;
  createdAt: number;
  disabled?: boolean;
}

export interface Actor {
  id: string;
  name: string;
  kind: Kind;
  scopes: Scope[];
  paths: string[];
  /** true in dev "open mode" where nothing is enforced */
  open?: boolean;
}

export interface Check {
  name: string;
  command: string;
  timeoutMs?: number;
}

export interface Webhook {
  id: string;
  url: string;
  secret: string;
  events: string[]; // event types, or ["*"]
}

export interface Config {
  reviewPaths: string[];
  /** shard name -> path prefixes; paths matching none belong to "main" */
  shards: Record<string, string[]>;
  /** the shard this repo instance serves (only meaningful when shards is non-empty) */
  shard: string;
  checks: Check[];
  policy: Partial<Policy>;
  webhooks: Webhook[];
  mirror?: { url: string };
  /** hot-spot merge strategies: list-aware merging (default on) and union paths (globs, default none) */
  merge: { lists: boolean; union: string[] };
  /** set on forks: where this repository's history was copied from */
  forkedFrom?: { repo: string; rev: number };
}

export interface Conflict {
  path: string;
  kind: "text" | "delete-modify" | "add-add";
  segments: Segment[];
}

export interface Evidence {
  check: string;
  passed: boolean;
  jobId: string;
  rev: number;
  ts: number;
  runner?: string;
  output?: string;
}

export interface Approval {
  by: string;
  kind: Kind | "unknown";
  ts: number;
}

export interface Session {
  id: string;
  agent: string;
  actorId?: string;
  model?: string;
  promptHash?: string;
  goal: string;
  baseRev: number;
  /** path -> new content, or null for deletion */
  edits: Record<string, string | null>;
  /** per-path rebase point, set when a conflict on that path was resolved */
  pathBase: Record<string, number>;
  intent: string[];
  status: Status;
  conflicts: Conflict[];
  /** concurrent-change interactions a verifier must sign off on before landing */
  risks: Risk[];
  risk?: RiskReport;
  verified?: { by: string; rev: number };
  approvals: Approval[];
  evidence: Evidence[];
  previews: string[];
  verifyingSince?: number;
  /** train mode: queued changes this one would conflict with; it is not built until they resolve */
  blockedOn?: string[];
  /** what reviewers/verifiers told the author, so the reason is never only in the audit log */
  feedback?: { type: "rejected" | "verify_failed" | "reverts" | "duplicates" | "config"; by: string; note: string; ts: number }[];
  /** the task this session works on (landing it completes the task) */
  taskNumber?: number;
  /** a reviewer who has taken this change; others cannot review it while the lease is live */
  reviewClaim?: { by: string; since: number; leaseUntil: number };
  /** overlapping edits resolved by the list/union strategies at the last evaluation */
  autoResolved?: { path: string; count: number }[];
  /** trunk revision at which the current conflicts were computed; resolutions are based on it */
  conflictRev?: number;
  reviewer?: string;
  landedRev?: number;
  createdAt: number;
}

export interface Provenance {
  rev: number;
  sessionId: string;
  goal: string;
  actor: { id: string; name: string; kind: string; model?: string };
  promptHash?: string;
  baseRev: number;
  paths: string[];
  merged: boolean;
  risk?: { score: number; tier: string; reasons: string[] };
  semantic: Risk[];
  /** overlapping edits Weave resolved automatically (list items, appended blocks) instead of reporting a conflict */
  autoResolved?: { path: string; count: number }[];
  evidence: { check: string; passed: boolean; jobId: string; rev: number }[];
  verifiedBy?: string;
  approvals: { by: string; kind: string }[];
  ts: number;
  prevHash: string;
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
  provenance?: Provenance;
  /** sha256 over prevHash + provenance: tamper-evident chain */
  hash?: string;
}

export interface WeaveEvent {
  id: number;
  ts: number;
  type: string;
  agent?: string;
  session?: string;
  by?: string;
  message: string;
  /** audit chain: sha256(prevHash + event) */
  hash?: string;
}

export interface Job {
  id: string;
  sessionId: string;
  check: string;
  command: string;
  timeoutMs: number;
  status: "queued" | "running" | "passed" | "failed";
  rev: number;
  /** sessions speculatively layered under this one (train mode) */
  basis: string[];
  /** full set of changes applied on top of rev's tree when running */
  overlay: Record<string, string | null>;
  editHash: string;
  createdAt: number;
  claimedBy?: string;
  leaseUntil?: number;
  output?: string;
  durationMs?: number;
  previewUrl?: string;
  finishedAt?: number;
}

export interface Comment {
  id: string;
  sessionId: string;
  path: string;
  line: number;
  endLine?: number;
  author: string;
  body: string;
  suggestion?: string;
  parent?: string;
  blocking: boolean;
  resolved: boolean;
  ts: number;
}

export interface OutboxItem {
  id: string;
  hookId: string;
  event: WeaveEvent;
  attempts: number;
  nextAt: number;
  status: "pending" | "delivered" | "failed";
  lastError?: string;
}

export type TaskStatus = "open" | "claimed" | "done" | "closed";
export type Priority = "low" | "normal" | "high" | "urgent";
export const PRIORITIES: Priority[] = ["low", "normal", "high", "urgent"];

export interface TaskComment {
  id: string;
  author: string;
  body: string;
  ts: number;
}

/** An issue, built for agents: it can be claimed with a lease, linked to sessions, and closed by landing. */
export interface Task {
  id: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  priority: Priority;
  status: TaskStatus;
  creator: string;
  assignee?: string;
  claim?: { by: string; since: number; leaseUntil: number };
  sessions: string[];
  comments: TaskComment[];
  dependsOn: number[];
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
}

export type NotificationType = "mention" | "task_assigned" | "task_commented" | "review_requested" | "change_landed" | "change_conflicted" | "change_commented";

export interface Notification {
  id: string;
  to: string;
  ts: number;
  type: NotificationType;
  message: string;
  ref: { kind: "task" | "session"; id: string };
  read: boolean;
}

export interface Tag {
  name: string;
  rev: number;
  message: string;
  tagger: string;
  ts: number;
}

export interface Release {
  tag: string;
  title: string;
  notes: string;
  author: string;
  ts: number;
  draft: boolean;
  prerelease: boolean;
}

export const CONFIG_FILE = "weave.json";

export interface State {
  rev: number;
  tasks: Record<string, Task>;
  notifications: Notification[];
  tags: Record<string, Tag>;
  releases: Record<string, Release>;
  /** path -> versions, ascending by rev; content null = deleted */
  files: Record<string, { rev: number; content: string | null }[]>;
  commits: Commit[];
  sessions: Record<string, Session>;
  events: WeaveEvent[];
  identities: Record<string, Identity>;
  comments: Record<string, Comment>;
  jobs: Record<string, Job>;
  outbox: OutboxItem[];
  config: Config;
  secrets: { signingKey: string };
  auditHead: string;
  mirror: { lastRev: number };
  seq: { event: number; comment: number; job: number; outbox: number; identity: number; task: number; notification: number; verifyStamp?: number };
  /** legacy mirror of config.reviewPaths, kept for older clients */
  reviewPaths: string[];
}

export class WeaveError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export const defaultConfig = (): Config => ({ reviewPaths: [], shards: {}, shard: "main", checks: [], policy: {}, webhooks: [], merge: { lists: true, union: [] } });

export const emptyState = (): State => ({
  rev: 0, tasks: {}, notifications: [], tags: {}, releases: {}, files: {}, commits: [], sessions: {}, events: [], identities: {}, comments: {}, jobs: {}, outbox: [],
  config: defaultConfig(), secrets: { signingKey: randomToken("sk", 32) }, auditHead: "", mirror: { lastRev: 0 },
  seq: { event: 0, comment: 0, job: 0, outbox: 0, identity: 0, task: 0, notification: 0 }, reviewPaths: [],
});

/** Fill fields older persisted states don't have. */
export function upgradeState(s: Partial<State>): State {
  const e = emptyState();
  const st = { ...e, ...s } as State;
  st.config = { ...defaultConfig(), ...(s.config ?? {}) };
  if (s.reviewPaths?.length && !st.config.reviewPaths.length) st.config.reviewPaths = s.reviewPaths;
  st.seq = { ...e.seq, ...(s.seq ?? {}) };
  st.secrets = s.secrets ?? e.secrets;
  for (const x of Object.values(st.sessions)) {
    x.approvals ??= [];
    x.evidence ??= [];
    x.previews ??= [];
    x.risks ??= [];
  }
  return st;
}

const clip = (s: string, n = 4000) => (s.length > n ? s.slice(0, n) + `\n…[${s.length - n} more chars]` : s);

export interface Revert {
  rev: number;
  agent: string;
  path: string;
  lines: number;
}

const significant = (l: string) => l.trim().length > 3;

/** Minimal glob: `*` within a segment, `**` across segments; a pattern without `/` matches the file name anywhere. */
export function globMatch(path: string, pattern: string): boolean {
  const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*") + "$");
  return re.test(pattern.includes("/") ? path : path.slice(path.lastIndexOf("/") + 1));
}

export class Repo {
  s: State;
  /** session ids mutated since the last persist (the store diffs everything else) */
  dirtySessions = new Set<string>();
  private now: () => number;
  private pumping = false;

  constructor(s: State = emptyState(), now: () => number = Date.now) {
    this.s = s;
    this.now = now;
  }

  get config(): Config {
    return this.s.config;
  }
  policy(): Policy {
    return { ...DEFAULT_POLICY, ...this.s.config.policy };
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
  filesAt(rev = this.s.rev): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of this.listFiles(rev)) out[p] = this.fileAt(p, rev)!;
    return out;
  }

  private commit(sessionId: string, agent: string, message: string, changes: Record<string, string | null>, merged: boolean, prov?: Omit<Provenance, "rev" | "prevHash" | "ts" | "paths" | "merged" | "sessionId" | "baseRev"> & { baseRev?: number }) {
    const rev = ++this.s.rev;
    for (const [p, content] of Object.entries(changes)) (this.s.files[p] ??= []).push({ rev, content });
    const ts = this.now();
    const prevHash = this.s.commits.at(-1)?.hash ?? "";
    const provenance: Provenance = {
      semantic: [], evidence: [], approvals: [], goal: message, actor: { id: "system", name: agent, kind: "system" },
      ...prov, rev, sessionId, baseRev: prov?.baseRev ?? rev - 1, paths: Object.keys(changes).sort(), merged, ts, prevHash,
    };
    const hash = sha256(prevHash + canonical(provenance));
    this.s.commits.push({ rev, sessionId, agent, message, paths: Object.keys(changes), merged, ts, provenance, hash });
    return rev;
  }

  /** Seed trunk directly (no session). */
  seed(files: Record<string, string>, message = "seed") {
    return this.commit("seed", "system", message, files, false);
  }

  setReviewPaths(paths: string[]) {
    this.s.config.reviewPaths = paths;
    this.s.reviewPaths = paths;
  }

  setConfig(patch: Partial<Config>) {
    const c = this.s.config;
    if (patch.reviewPaths) this.setReviewPaths(patch.reviewPaths);
    if (patch.shards) c.shards = patch.shards;
    if (patch.shard) c.shard = patch.shard;
    if (patch.checks) c.checks = patch.checks.map((k) => ({ name: k.name, command: k.command, timeoutMs: k.timeoutMs ?? 120_000 }));
    if (patch.policy) c.policy = patch.policy;
    if (patch.merge) c.merge = { lists: patch.merge.lists !== false, union: patch.merge.union ?? [] };
    if (patch.mirror !== undefined) c.mirror = patch.mirror;
    if (patch.webhooks)
      c.webhooks = patch.webhooks.map((w, i) => ({ id: w.id ?? `wh${i + 1}`, url: w.url, secret: w.secret ?? "", events: w.events?.length ? w.events : ["*"] }));
    this.log("config", "repository configuration updated");
  }

  // ---- audit log + webhook outbox --------------------------------------
  private log(type: string, message: string, s?: Session, by?: string) {
    const id = ++this.s.seq.event;
    const base = { id, ts: this.now(), type, message, agent: s?.agent, session: s?.id, by };
    const hash = sha256(this.s.auditHead + canonical(base));
    this.s.auditHead = hash;
    const ev: WeaveEvent = { ...base, hash };
    this.s.events.push(ev);
    if (this.s.events.length > 500) this.s.events.splice(0, this.s.events.length - 500);
    for (const w of this.s.config.webhooks) {
      if (w.events.includes("*") || w.events.includes(type))
        this.s.outbox.push({ id: `d${++this.s.seq.outbox}`, hookId: w.id, event: ev, attempts: 0, nextAt: ev.ts, status: "pending" });
    }
    if (this.s.outbox.length > 500) this.s.outbox = this.s.outbox.filter((o) => o.status === "pending").concat(this.s.outbox.filter((o) => o.status !== "pending").slice(-200));
  }

  /** Record an operational event (e.g. from the mirror) in the audit log. */
  note(type: string, message: string) {
    this.log(type, message);
  }

  // ---- identities ------------------------------------------------------
  createIdentity(o: { name: string; kind: Kind; scopes?: Scope[]; paths?: string[]; budget?: Identity["budget"]; model?: string }) {
    if (!o.name || !/^[\w.-]+$/.test(o.name)) throw new WeaveError("identity name must match [A-Za-z0-9_.-]+");
    if (!(o.kind in DEFAULT_SCOPES)) throw new WeaveError(`unknown kind: ${o.kind}`);
    if (Object.values(this.s.identities).some((i) => i.name === o.name && !i.disabled)) throw new WeaveError(`identity ${o.name} already exists`, 409);
    const token = randomToken("wv", 24);
    const id = `id${++this.s.seq.identity}`;
    const identity: Identity = {
      id, name: o.name, kind: o.kind, scopes: o.scopes ?? DEFAULT_SCOPES[o.kind], paths: o.paths ?? [], budget: o.budget ?? {},
      model: o.model, tokenHash: sha256(token), createdAt: this.now(),
    };
    this.s.identities[id] = identity;
    this.log("identity", `created ${o.kind} identity ${o.name}`);
    return { identity: this.publicIdentity(identity), token };
  }
  private publicIdentity(i: Identity) {
    const { tokenHash: _t, ...rest } = i;
    return rest;
  }
  listIdentities() {
    return Object.values(this.s.identities).map((i) => this.publicIdentity(i));
  }
  authenticate(token: string): Actor | null {
    const h = sha256(token);
    for (const i of Object.values(this.s.identities)) {
      if (!i.disabled && i.tokenHash === h) return { id: i.id, name: i.name, kind: i.kind, scopes: i.scopes, paths: i.paths };
    }
    return null;
  }
  revokeIdentity(id: string) {
    const i = this.s.identities[id];
    if (!i) throw new WeaveError(`no such identity: ${id}`, 404);
    i.disabled = true;
    this.log("identity", `revoked identity ${i.name}`);
  }
  identityOf(actorId?: string): Identity | undefined {
    return actorId ? this.s.identities[actorId] : undefined;
  }

  private checkBudget(actor: Actor | undefined, what: "open" | "land") {
    if (!actor || actor.open) return;
    const b = this.s.identities[actor.id]?.budget;
    const limit = what === "open" ? b?.sessionsPerHour : b?.landsPerHour;
    if (limit === undefined) return;
    const since = this.now() - 3_600_000;
    const used =
      what === "open"
        ? Object.values(this.s.sessions).filter((x) => x.actorId === actor.id && x.createdAt > since).length
        : this.s.commits.filter((c) => c.ts > since && c.provenance?.actor.id === actor.id).length;
    if (used >= limit) throw new WeaveError(`${actor.name} exceeded its budget of ${limit} ${what === "open" ? "sessions" : "landings"} per hour`, 429);
  }

  // ---- sessions -------------------------------------------------------
  session(id: string): Session {
    const s = this.s.sessions[id];
    if (!s) throw new WeaveError(`no such session: ${id}`, 404);
    this.dirtySessions.add(id);
    return s;
  }
  sessionRO(id: string): Session {
    const s = this.s.sessions[id];
    if (!s) throw new WeaveError(`no such session: ${id}`, 404);
    return s;
  }

  private assertOwner(s: Session, actor?: Actor) {
    if (!actor || actor.open || actor.scopes.includes("admin")) return;
    if (s.actorId && s.actorId !== actor.id) throw new WeaveError(`session ${s.id} belongs to ${s.agent}`, 403);
  }

  open(opts: { id?: string; agent: string; goal: string; intent?: string[]; actor?: Actor; model?: string; prompt?: string; baseRev?: number; taskNumber?: number }): { session: Session; warnings: string[] } {
    this.checkBudget(opts.actor, "open");
    if (opts.baseRev !== undefined && (!Number.isInteger(opts.baseRev) || opts.baseRev < 0 || opts.baseRev > this.s.rev))
      throw new WeaveError(`baseRev must be an integer between 0 and the current revision (r${this.s.rev})`);
    const id = opts.id ?? `${opts.agent}-${Object.keys(this.s.sessions).length + 1}`;
    const existing = this.s.sessions[id];
    if (existing && LIVE.includes(existing.status)) throw new WeaveError(`session ${id} is still ${existing.status}`, 409);
    if (opts.taskNumber !== undefined) this.claimTask(opts.taskNumber, opts.agent);
    const ident = this.identityOf(opts.actor?.id);
    const session: Session = {
      id, agent: opts.agent, actorId: opts.actor && !opts.actor.open ? opts.actor.id : undefined, model: opts.model ?? ident?.model,
      promptHash: opts.prompt ? sha256(opts.prompt) : undefined, goal: opts.goal, taskNumber: opts.taskNumber, baseRev: opts.baseRev ?? this.s.rev, edits: {}, pathBase: {},
      intent: [], status: "active", conflicts: [], risks: [], approvals: [], evidence: [], previews: [], createdAt: this.now(),
    };
    this.s.sessions[id] = session;
    this.dirtySessions.add(id);
    this.log("open", `${opts.agent} started: ${opts.goal}`, session);
    if (opts.taskNumber !== undefined) this.getTaskRaw(opts.taskNumber).sessions.push(id);
    this.notifyMentions(opts.goal, opts.agent, { kind: "session", id }, `session ${id}`);
    return { session, warnings: this.declare(id, opts.intent ?? [], true) };
  }

  /** Declare which paths this session intends to touch; returns overlap warnings with live sessions. */
  declare(id: string, paths: string[], quiet = false): string[] {
    const s = this.session(id);
    s.intent = [...new Set([...s.intent, ...paths])];
    const warnings: string[] = [];
    for (const o of Object.values(this.s.sessions)) {
      if (o.id === id || !LIVE.includes(o.status)) continue;
      const overlap = s.intent.filter((p) => o.intent.includes(p) || p in o.edits);
      if (overlap.length) warnings.push(`${o.agent} is also working on ${overlap.join(", ")} (${o.goal})`);
    }
    if (!quiet && paths.length) this.log("intent", `${s.agent} intends to touch ${paths.join(", ")}`, s);
    if (warnings.length) this.log("overlap", `heads-up for ${s.agent}: ${warnings.join("; ")}`, s);
    return warnings;
  }

  read(id: string, path: string): string | null {
    const s = this.sessionRO(id);
    return path in s.edits ? s.edits[path] : this.fileAt(path, s.baseRev);
  }

  private assertWritable(path: string, actor?: Actor) {
    const c = this.s.config;
    if (Object.keys(c.shards).length) {
      const owner = shardOf(path, c.shards);
      if (owner !== c.shard) throw new WeaveError(`${path} belongs to shard "${owner}", this session is on shard "${c.shard}"; open a session there`, 409);
    }
    if (actor && !actor.open && actor.paths.length && !actor.paths.some((p) => path.startsWith(p)))
      throw new WeaveError(`${actor.name} may not write ${path} (allowed: ${actor.paths.join(", ")})`, 403);
  }

  /**
   * `basedOn` is the trunk revision the agent read the file at. If the file changed between that
   * revision and the session's base, the edit was derived from stale content and would silently
   * revert the intervening change, so it is rejected.
   */
  write(id: string, path: string, content: string | null, actor?: Actor, basedOn?: number) {
    const s = this.session(id);
    this.assertOwner(s, actor);
    const base = s.pathBase[path] ?? s.baseRev;
    if (basedOn !== undefined && basedOn < base && this.fileAt(path, basedOn) !== this.fileAt(path, base)) {
      const rev = this.s.files[path]?.find((v) => v.rev > basedOn && v.rev <= base)?.rev ?? base;
      throw new WeaveError(`you read r${basedOn} of ${path}, but it changed in r${rev} (your session is based on r${base}); re-read it with the session file endpoint (or open the session with baseRev=${basedOn}) and redo your edit`, 409);
    }
    if (s.status === "landed" || s.status === "rejected") throw new WeaveError(`session ${id} is ${s.status}`, 409);
    if (s.status === "conflicted") throw new WeaveError(`session ${id} has unresolved conflicts; resolve them first`, 409);
    this.assertWritable(path, actor);
    s.edits[path] = content;
    s.verified = undefined; // an attestation covers the content it saw
    s.approvals = [];
    if (!s.intent.includes(path)) s.intent.push(path);
    s.status = "active";
  }

  // ---- landing --------------------------------------------------------
  private mergeAll(s: Session, overlay: Record<string, string | null> = {}): { changes: Record<string, string | null>; conflicts: Conflict[]; merged: boolean; risks: Risk[]; auto: { path: string; count: number }[] } {
    const changes: Record<string, string | null> = {};
    const conflicts: Conflict[] = [];
    const risks: Risk[] = [];
    const auto: { path: string; count: number }[] = [];
    let merged = false;
    for (const [path, theirs] of Object.entries(s.edits)) {
      const baseRev = s.pathBase[path] ?? s.baseRev;
      const base = this.fileAt(path, baseRev);
      const ours = path in overlay ? overlay[path] : this.head(path);
      if (theirs === ours) { if (ours !== base) merged = true; continue; } // already there
      if (ours === base) { changes[path] = theirs; continue; } // trunk untouched: fast-forward
      merged = true;
      const whole = (kind: Conflict["kind"]) =>
        conflicts.push({ path, kind, segments: [{ kind: "conflict", base: splitLines(base ?? ""), ours: splitLines(ours ?? ""), theirs: splitLines(theirs ?? "") }] });
      if (base === null) { whole("add-add"); continue; }
      if (ours === null || theirs === null) { whole("delete-modify"); continue; }
      const r = this.mergeMemo(base, ours, theirs, { lists: this.s.config.merge.lists, union: this.s.config.merge.union.some((g) => globMatch(path, g)) });
      if (r.conflicts) conflicts.push({ path, kind: "text", segments: r.segments });
      else {
        if (r.auto) auto.push({ path, count: r.auto });
        changes[path] = r.text;
        risks.push(...r.risks.map((k) => ({ ...k, path })));
      }
    }
    return { changes, conflicts, merged, risks, auto };
  }

  /** Queue evaluation re-merges the same inputs many times; results are pure, so cache them by content hash. */
  private hashes = new Map<string, string>();
  private hashOf(s: string): string {
    let h = this.hashes.get(s);
    if (h === undefined) {
      h = sha256(s);
      this.hashes.set(s, h);
      if (this.hashes.size > 2000) this.hashes.delete(this.hashes.keys().next().value!);
    }
    return h;
  }
  private memo = new Map<string, ReturnType<typeof merge3> & { risks: Risk[] }>();
  private mergeMemo(base: string, ours: string, theirs: string, opts: MergeOptions) {
    const key = `${this.hashOf(base)}.${this.hashOf(ours)}.${this.hashOf(theirs)}.${opts.lists ? 1 : 0}${opts.union ? 1 : 0}`;
    let hit = this.memo.get(key);
    if (!hit) {
      const m = merge3(base, ours, theirs, opts);
      hit = { ...m, risks: m.conflicts ? [] : semanticRisk("", base, ours, theirs) };
      this.memo.set(key, hit);
      if (this.memo.size > 400) this.memo.delete(this.memo.keys().next().value!);
    }
    return hit;
  }

  private editHash(s: Session) {
    return sha256(canonical(s.edits));
  }

  /** An attestation holds while no later trunk commit has touched this session's paths. */
  private attested(s: Session): boolean {
    const v = s.verified;
    if (!v) return false;
    const paths = new Set(Object.keys(s.edits));
    return !this.s.commits.some((c) => c.rev > v.rev && c.paths.some((p) => paths.has(p)));
  }

  /** Dry-run: what trunk would look like for this session's paths if it landed now. */
  preview(id: string) {
    const s = this.sessionRO(id);
    const r = this.mergeAll(s);
    return { baseRev: this.s.rev, merged: r.merged, files: r.changes, conflicts: r.conflicts, risks: r.risks };
  }

  private addedLines = new Map<string, string[]>();
  /** Significant lines a commit added to a path (cached: commits are immutable). */
  private addedBy(path: string, rev: number): string[] {
    const key = `${path}@${rev}`;
    let v = this.addedLines.get(key);
    if (!v) {
      const before = splitLines(this.fileAt(path, rev - 1) ?? "");
      v = diffHunks(before, splitLines(this.fileAt(path, rev) ?? "")).flatMap((h) => h.lines).filter(significant);
      this.addedLines.set(key, v);
      if (this.addedLines.size > 2000) this.addedLines.delete(this.addedLines.keys().next().value!);
    }
    return v;
  }

  /**
   * Would landing this session erase substantial code another agent recently landed? A textual merge can
   * be perfectly clean and still do this (an edit derived from a stale read, or a resolution written
   * against an older trunk), and passing tests prove nothing when the tests were erased with the code.
   * Looks at recent history (not only commits after the session's base) because a stale read can predate it.
   */
  private revertsOf(s: Session, changes: Record<string, string | null>): Revert[] {
    const out: Revert[] = [];
    for (const [path, merged] of Object.entries(changes)) {
      const head = this.head(path);
      if (head === null) continue;
      const headLines = splitLines(head);
      const removed = new Set(diffHunks(headLines, splitLines(merged ?? "")).flatMap((h) => headLines.slice(h.start, h.end)).filter(significant));
      if (!removed.size) continue;
      for (const c of this.s.commits) {
        if (c.rev <= s.baseRev - 8 || c.agent === s.agent || c.sessionId === s.id || c.sessionId === "seed" || !c.paths.includes(path)) continue;
        const hit = this.addedBy(path, c.rev).filter((l) => removed.has(l)).length;
        if (hit >= 3) out.push({ rev: c.rev, agent: c.agent, path, lines: hit });
      }
    }
    return out;
  }

  /**
   * Top-level names the merged result declares more than once that trunk does not already. Union and list
   * merges can combine two sides that each added the same function; in many languages that is legal (the
   * last one silently wins), so neither the compiler nor the tests would notice.
   */
  private duplicatesOf(changes: Record<string, string | null>): { path: string; name: string }[] {
    const count = (text: string | null) => {
      const m = new Map<string, number>();
      if (text) for (const s of symbols(splitLines(text))) if (s.name !== "<top>") m.set(s.name, (m.get(s.name) ?? 0) + 1);
      return m;
    };
    const out: { path: string; name: string }[] = [];
    for (const [path, merged] of Object.entries(changes)) {
      if (merged === null) continue;
      const after = count(merged);
      const before = count(this.head(path));
      for (const [name, n] of after) if (n > 1 && n > (before.get(name) ?? 0)) out.push({ path, name });
    }
    return out;
  }

  private riskOf(s: Session, r: ReturnType<Repo["mergeAll"]>, reverts: Revert[] = []): RiskReport {
    const mine = Object.values(this.s.sessions).filter((x) => x.agent === s.agent && x.id !== s.id).slice(-5);
    const risk = scoreRisk({
      reverts, autoResolved: r.auto.reduce((n, a) => n + a.count, 0),
      paths: Object.keys(r.changes), before: (p) => this.head(p), after: r.changes, semantic: r.risks, merged: r.merged,
      protectedPaths: this.s.config.reviewPaths, recentRejects: mine.filter((x) => x.status === "rejected").length, policy: this.policy(),
    });
    if (r.changes[CONFIG_FILE] !== undefined && risk.need !== "human")
      return { ...risk, score: Math.max(risk.score, this.policy().humanAbove), tier: "high", need: "human", reasons: [...risk.reasons, `+config: ${CONFIG_FILE} changes checks, policy and review rules, so a human approves it`] };
    return risk;
  }

  /** Try to land a session onto trunk atomically, subject to policy gates. */
  submit(id: string, message?: string, actor?: Actor, opts: { allowRevert?: boolean } = {}): { status: Status; rev?: number; conflicts?: Conflict[]; risks?: Risk[]; risk?: RiskReport; jobs?: string[]; evidence?: Evidence[]; reverts?: Revert[]; duplicates?: { path: string; name: string }[] } {
    const s = this.session(id);
    this.assertOwner(s, actor);
    if (s.status === "landed" || s.status === "rejected") throw new WeaveError(`session ${id} is ${s.status}`, 409);
    if (!Object.keys(s.edits).length) throw new WeaveError("nothing to land: session has no edits");
    const r = this.mergeAll(s);
    if (r.conflicts.length) {
      s.status = "conflicted";
      s.conflicts = r.conflicts;
      s.conflictRev = this.s.rev;
      s.blockedOn = undefined;
      s.approvals = [];
      this.log("conflict", `${s.agent} hit ${r.conflicts.length} conflict(s) in ${r.conflicts.map((c) => c.path).join(", ")}`, s);
      return { status: "conflicted", conflicts: r.conflicts };
    }
    s.conflicts = [];
    s.risks = r.risks;
    if (!Object.keys(r.changes).length) {
      // every edit already matches trunk: nothing to commit
      s.status = "landed";
      s.landedRev = this.s.rev;
      this.log("noop", `${s.agent}'s change was already on trunk; nothing to land`, s);
      return { status: "landed", rev: this.s.rev };
    }
    const reverts = this.revertsOf(s, r.changes);
    if (reverts.length && !opts.allowRevert) {
      s.status = "active";
      s.blockedOn = undefined;
      const what = reverts.map((x) => `${x.lines} lines that ${x.agent} landed in r${x.rev} (${x.path})`).join("; ");
      (s.feedback ??= []).push({ type: "reverts", by: "weave", ts: this.now(), note: `landing this would remove ${what}. Re-read the current trunk, re-apply your change on top of it and put the result in your session; if removing that work is intended, submit with allowRevert.` });
      this.log("reverts", `${s.agent}'s change would remove work landed by ${[...new Set(reverts.map((x) => x.agent))].join(", ")}; sent back to the author`, s);
      return { status: "active", reverts };
    }
    const cfg = r.changes[CONFIG_FILE];
    if (typeof cfg === "string") {
      const parsed = Repo.parseConfigFile(cfg);
      if ("error" in parsed) {
        s.status = "active";
        s.blockedOn = undefined;
        (s.feedback ??= []).push({ type: "config", by: "weave", ts: this.now(), note: parsed.error });
        this.log("config_invalid", `${s.agent}'s ${CONFIG_FILE} was rejected: ${parsed.error}`, s);
        return { status: "active" };
      }
    }
    const dupes = this.duplicatesOf(r.changes);
    if (dupes.length && !opts.allowRevert) {
      s.status = "active";
      s.blockedOn = undefined;
      (s.feedback ??= []).push({ type: "duplicates", by: "weave", ts: this.now(), note: `after merging with concurrent work this would declare ${dupes.map((d) => `\`${d.name}\` twice (${d.path})`).join(", ")}; someone already landed it. Re-read trunk and keep only what is still missing; submit with allowRevert if the duplicate is intended (e.g. overloads).` });
      this.log("duplicates", `${s.agent}'s change would declare ${dupes.map((d) => d.name).join(", ")} twice; sent back to the author`, s);
      return { status: "active", duplicates: dupes };
    }
    const risk = (s.risk = this.riskOf(s, r, reverts));
    s.autoResolved = r.auto;

    // 1. required checks, run by pull-based runners
    let checked = false;
    if (this.s.config.checks.length) {
      if (this.policy().evidence === "train") {
        // Don't spend a build on a change that is about to conflict with one queued ahead of it: park it
        // until that one lands (then it gets a definite answer against the real trunk) or fails.
        s.verifyingSince ??= this.stamp();
        const blockers = this.blockedBy(s);
        if (blockers.length) {
          if (!s.blockedOn?.length) this.log("blocked", `${s.agent}'s change overlaps queued change(s) ${blockers.join(", ")}; waiting for them before spending a build`, s);
          s.blockedOn = blockers;
          s.status = "verifying";
          return { status: "verifying", jobs: [], risk };
        }
        s.blockedOn = undefined;
      }
      const st = this.ensureChecks(s, r.changes);
      if (st === "fail") {
        s.status = "active";
        const failed = s.evidence.filter((e) => !e.passed).slice(-3);
        this.log("checks_failed", `${s.agent}'s checks failed: ${failed.map((e) => e.check).join(", ")}`, s);
        return { status: "active", evidence: failed, risk };
      }
      if (st === "pending") {
        s.verifyingSince ??= this.stamp();
        if (s.status !== "verifying") this.log("verifying", `${s.agent}'s change is waiting on ${this.s.config.checks.length} check(s)`, s);
        s.status = "verifying";
        return { status: "verifying", jobs: Object.values(this.s.jobs).filter((j) => j.sessionId === id && (j.status === "queued" || j.status === "running")).map((j) => j.id), risk };
      }
      checked = true;
    }
    // 2. semantic-interaction gate: checks passing on the merged result, or a verifier's attestation, clears it
    if (r.risks.length && !checked && !this.attested(s)) {
      s.status = "needs_verify";
      this.log("needs_verify", `${s.agent}'s change merged cleanly but interacts with concurrent work (${r.risks.map((k) => k.symbols[0] + ` in ${k.path}`).join(", ")}); needs a verifier`, s);
      return { status: "needs_verify", risks: r.risks, risk };
    }
    // 3. risk-tiered review
    if (risk.need !== "none" && !this.approved(s, risk.need)) {
      if (s.status !== "in_review") this.log("review_requested", `${s.agent}'s ${risk.tier}-risk change (${risk.score}) needs ${risk.need === "human" ? "a human" : "a"} reviewer: ${risk.reasons.slice(0, 3).join("; ")}`, s);
      if (s.status !== "in_review") this.notifyReviewers(s, risk.need);
      s.status = "in_review";
      return { status: "in_review", risk };
    }
    return this.land(s, r.changes, r.merged, risk, message, actor);
  }

  private approved(s: Session, need: Need): boolean {
    const ok = s.approvals.filter((a) => a.by !== s.agent);
    if (need === "any") return ok.length > 0;
    return ok.some((a) => a.kind === "human");
  }

  private land(s: Session, changes: Record<string, string | null>, merged: boolean, risk: RiskReport, message?: string, actor?: Actor) {
    this.checkBudget(actor ?? this.actorFor(s), "land");
    const msg = message ?? s.goal;
    const wasWaiting = s.status === "in_review" || s.status === "verifying" || s.status === "needs_verify";
    const ident = this.identityOf(s.actorId);
    s.landedRev = this.commit(s.id, s.agent, msg, changes, merged, {
      goal: s.goal, actor: { id: s.actorId ?? "open", name: s.agent, kind: ident?.kind ?? "agent", model: s.model }, promptHash: s.promptHash,
      baseRev: s.baseRev, risk: { score: risk.score, tier: risk.tier, reasons: risk.reasons }, semantic: s.risks, autoResolved: s.autoResolved?.length ? s.autoResolved : undefined,
      evidence: s.evidence.filter((e) => e.passed).map((e) => ({ check: e.check, passed: e.passed, jobId: e.jobId, rev: e.rev })),
      verifiedBy: s.verified?.by, approvals: s.approvals.map((a) => ({ by: a.by, kind: a.kind })),
    });
    s.status = "landed";
    s.blockedOn = undefined;
    s.reviewClaim = undefined;
    const task = s.taskNumber ? this.s.tasks[`t${s.taskNumber}`] : undefined;
    if (task && task.status !== "closed") {
      task.status = "done";
      task.claim = undefined;
      task.closedAt = task.updatedAt = this.now();
      task.comments.push({ id: `tc${task.comments.length + 1}`, author: "weave", body: `${s.agent} landed in r${s.landedRev}: ${msg}`, ts: this.now() });
    }
    if (wasWaiting) this.notify(s.agent, "change_landed", `your change landed as r${s.landedRev}: ${msg}`, { kind: "session", id: s.id });
    if (changes[CONFIG_FILE]) this.applyConfigFile(changes[CONFIG_FILE]!);
    this.log("landed", `${s.agent} landed r${s.landedRev}${merged ? " (auto-merged with concurrent work)" : ""}: ${msg}`, s);
    this.pump();
    return { status: "landed" as Status, rev: s.landedRev, risk };
  }

  private actorFor(s: Session): Actor | undefined {
    const i = this.identityOf(s.actorId);
    return i ? { id: i.id, name: i.name, kind: i.kind, scopes: i.scopes, paths: i.paths } : undefined;
  }

  private applyConfigFile(text: string) {
    const r = Repo.parseConfigFile(text);
    if ("patch" in r) this.setConfig(r.patch);
  }

  /** After a landing, sessions parked on checks may now be able to land. */
  private pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      // Only sessions whose situation can have changed need another look: parked ones, and ones with no
      // build outstanding (all passed, or stale). A session with a queued/running build is waiting on that
      // build, whose completion re-evaluates it; re-merging it here would be O(queue^2) work per landing.
      for (const x of Object.values(this.s.sessions)) {
        if (x.status !== "in_review" && x.status !== "needs_verify") continue;
        const fresh = this.mergeAll(x);
        if (!fresh.conflicts.length) {
          if (!Object.keys(fresh.changes).length) {
            // everything this change did is already on trunk (someone landed the same thing): nothing left to review
            x.status = "landed";
            x.landedRev = this.s.rev;
            x.blockedOn = undefined;
            this.log("noop", `${x.agent}'s change was already on trunk; nothing left to review`, x);
          } else x.risk = this.riskOf(x, fresh, this.revertsOf(x, fresh.changes)); // keep the queue's ranking current
          continue;
        }
        x.status = "conflicted";
        x.conflicts = fresh.conflicts;
        x.conflictRev = this.s.rev;
        x.approvals = [];
        x.verified = undefined;
        x.reviewClaim = undefined;
        this.notify(x.agent, "change_conflicted", `your change no longer merges with trunk: ${fresh.conflicts.map((c) => c.path).join(", ")}`, { kind: "session", id: x.id });
        this.log("conflict", `${x.agent}'s change no longer merges with trunk (${fresh.conflicts.map((c) => c.path).join(", ")}); sent back to the author`, x);
      }
      const busy = new Set(Object.values(this.s.jobs).filter((j) => j.status === "queued" || j.status === "running").map((j) => j.sessionId));
      const waiting = Object.values(this.s.sessions)
        .filter((x) => x.status === "verifying" && (x.blockedOn?.length || !busy.has(x.id) || this.hasStaleBuild(x)))
        .sort((a, b) => (a.verifyingSince ?? 0) - (b.verifyingSince ?? 0));
      for (const w of waiting) if (w.status === "verifying") this.submit(w.id);
    } finally {
      this.pumping = false;
    }
  }

  // ---- checks / runner jobs -------------------------------------------
  private jobState(j: Job, s: Session): "pass" | "fail" | "pending" | "stale" {
    if (j.status === "queued" || j.status === "running") return "pending";
    if (j.status === "failed") return "fail";
    const later = this.s.commits.filter((c) => c.rev > j.rev);
    const mode = this.policy().evidence;
    if (mode === "strict") return later.length ? "stale" : "pass";
    if (mode === "train") {
      for (const id of j.basis) {
        const b = this.s.sessions[id];
        if (!b) return "stale";
        if (b.status === "landed") continue;
        if (b.status === "verifying" || b.status === "in_review" || b.status === "needs_verify") return "pending";
        return "stale";
      }
      return later.every((c) => j.basis.includes(c.sessionId)) ? "pass" : "stale";
    }
    const paths = new Set(Object.keys(s.edits));
    return later.some((c) => c.paths.some((p) => paths.has(p))) ? "stale" : "pass";
  }

  /** True if a session's outstanding build was made obsolete (e.g. the change it was speculatively built on failed). */
  private hasStaleBuild(s: Session): boolean {
    if (this.policy().evidence !== "train") return false;
    const eh = this.editHash(s);
    return Object.values(this.s.jobs).some((j) => j.sessionId === s.id && j.editHash === eh && (j.status === "queued" || j.status === "running") && j.basis.some((id) => !["verifying", "in_review", "needs_verify", "landed"].includes(this.s.sessions[id]?.status ?? "")));
  }

  /** Strictly increasing queue-order stamp (wall-clock based, but never ties). */
  private stamp(): number {
    this.s.seq.verifyStamp = Math.max(this.now(), (this.s.seq.verifyStamp ?? 0) + 1);
    return this.s.seq.verifyStamp;
  }

  /** Queued (verifying, unparked) changes ahead of `s` whose pending content would conflict with it. */
  private blockedBy(s: Session): string[] {
    const preds = Object.values(this.s.sessions)
      .filter((x) => x.id !== s.id && x.status === "verifying" && !x.blockedOn?.length && (x.verifyingSince ?? 0) < (s.verifyingSince ?? 0))
      .sort((a, b) => (a.verifyingSince ?? 0) - (b.verifyingSince ?? 0));
    const overlay: Record<string, string | null> = {};
    const included: Session[] = [];
    for (const p of preds) {
      const pr = this.mergeAll(p, overlay);
      if (!pr.conflicts.length) {
        Object.assign(overlay, pr.changes);
        included.push(p);
      }
    }
    if (!included.length) return [];
    const mr = this.mergeAll(s, overlay);
    if (!mr.conflicts.length) return [];
    const bad = new Set(mr.conflicts.map((c) => c.path));
    return included.filter((p) => Object.keys(p.edits).some((path) => bad.has(path))).map((p) => p.id);
  }

  private ensureChecks(s: Session, changes: Record<string, string | null>): "pass" | "pending" | "fail" {
    const eh = this.editHash(s);
    let pending = false;
    for (const check of this.s.config.checks) {
      const latest = Object.values(this.s.jobs).filter((j) => j.sessionId === s.id && j.check === check.name && j.editHash === eh).sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)))[0];
      if (latest) {
        const st = this.jobState(latest, s);
        if (st === "pass") continue;
        if (st === "fail") return "fail";
        if (st === "pending") { pending = true; continue; }
      }
      this.enqueue(s, check, changes, eh);
      pending = true;
    }
    return pending ? "pending" : "pass";
  }

  private enqueue(s: Session, check: Check, changes: Record<string, string | null>, editHash: string) {
    let overlay: Record<string, string | null> = {};
    const basis: string[] = [];
    let mine = changes;
    if (this.policy().evidence === "train") {
      s.verifyingSince ??= this.stamp();
      const preds = Object.values(this.s.sessions).filter((x) => x.id !== s.id && x.status === "verifying" && (x.verifyingSince ?? 0) < s.verifyingSince!).sort((a, b) => (a.verifyingSince ?? 0) - (b.verifyingSince ?? 0));
      for (const p of preds) {
        const pr = this.mergeAll(p, overlay);
        if (!pr.conflicts.length) { Object.assign(overlay, pr.changes); basis.push(p.id); }
      }
      if (basis.length) {
        const mr = this.mergeAll(s, overlay);
        if (mr.conflicts.length) { overlay = {}; basis.length = 0; } else mine = mr.changes;
      }
    }
    const id = `j${++this.s.seq.job}`;
    this.s.jobs[id] = { id, sessionId: s.id, check: check.name, command: check.command, timeoutMs: check.timeoutMs ?? 120_000, status: "queued", rev: this.s.rev, basis, overlay: { ...overlay, ...mine }, editHash, createdAt: this.now() };
    this.log("job_queued", `check "${check.name}" queued for ${s.agent}${basis.length ? ` (speculatively on top of ${basis.length} queued change(s))` : ""}`, s);
    const live = Object.values(this.s.jobs);
    if (live.length > 300) for (const j of live.slice(0, live.length - 300)) if (j.status === "passed" || j.status === "failed") delete this.s.jobs[j.id];
  }

  /** A runner pulls the next job. Expired leases are requeued first. */
  claimJob(runner: string, leaseMs = 300_000): (Job & { files: Record<string, string> }) | null {
    const t = this.now();
    for (const j of Object.values(this.s.jobs)) if (j.status === "running" && (j.leaseUntil ?? 0) < t) j.status = "queued";
    const next = Object.values(this.s.jobs)
      .filter((j) => j.status === "queued" && this.s.sessions[j.sessionId]?.status === "verifying")
      .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))[0];
    if (!next) return null;
    next.status = "running";
    next.claimedBy = runner;
    next.leaseUntil = t + leaseMs;
    const files = this.filesAt(next.rev);
    for (const [p, c] of Object.entries(next.overlay)) c === null ? delete files[p] : (files[p] = c);
    return { ...next, files };
  }

  jobResult(id: string, runner: string, r: { passed: boolean; output?: string; durationMs?: number; previewUrl?: string }) {
    const j = this.s.jobs[id];
    if (!j) throw new WeaveError(`no such job: ${id}`, 404);
    if (j.status !== "running") throw new WeaveError(`job ${id} is ${j.status}`, 409);
    if (j.claimedBy && j.claimedBy !== runner) throw new WeaveError(`job ${id} is leased to another runner`, 403);
    j.status = r.passed ? "passed" : "failed";
    j.output = clip(r.output ?? "");
    j.durationMs = r.durationMs;
    j.previewUrl = r.previewUrl;
    j.finishedAt = this.now();
    const s = this.session(j.sessionId);
    s.evidence.push({ check: j.check, passed: r.passed, jobId: j.id, rev: j.rev, ts: this.now(), runner, output: j.output });
    if (r.previewUrl) s.previews.push(r.previewUrl);
    this.log(r.passed ? "check_passed" : "check_failed", `${runner} ran "${j.check}" for ${s.agent}: ${r.passed ? "passed" : "FAILED"}`, s, runner);
    if (s.status === "verifying") this.submit(s.id);
    this.pump(); // a failure may invalidate speculative jobs queued behind this one
    return { job: j, session: s.status };
  }

  /** Forget failed evidence for the session's current edits so checks run again (e.g. after a flake). */
  rerunChecks(id: string) {
    const s = this.session(id);
    const eh = this.editHash(s);
    for (const j of Object.values(this.s.jobs)) if (j.sessionId === id && j.editHash === eh && j.status === "failed") delete this.s.jobs[j.id];
    return this.submit(id);
  }

  // ---- conflicts, verification, review ---------------------------------
  /** Resolve conflicts on one path with explicit choices or a blanket strategy; keeps the session open. */
  resolve(id: string, path: string, how: Choice[] | "ours" | "theirs" | "both", actor?: Actor) {
    const s = this.session(id);
    this.assertOwner(s, actor);
    let c = s.conflicts.find((x) => x.path === path);
    if (!c) {
      // trunk may have moved since the last submit: look at the current merge instead of making the author round-trip
      const fresh = this.mergeAll(s);
      c = fresh.conflicts.find((x) => x.path === path);
      if (!c) throw new WeaveError(`no conflict on ${path} against the current trunk`, 404);
      s.conflicts = fresh.conflicts;
      s.conflictRev = this.s.rev;
    }
    const n = c.segments.filter((x) => x.kind === "conflict").length;
    const choices = typeof how === "string" ? Array<Choice>(n).fill(how) : how;
    if (c.kind !== "text") {
      const ch = choices[0];
      const seg = c.segments[0] as Extract<Segment, { kind: "conflict" }>;
      const pick = ch === "ours" ? seg.ours : ch === "theirs" ? seg.theirs : ch === "both" ? [...seg.ours, ...seg.theirs] : splitLines((ch as { text: string }).text);
      const deleted = (ch === "ours" && this.head(path) === null) || (ch === "theirs" && s.edits[path] === null);
      s.edits[path] = deleted ? null : pick.join("\n");
    } else s.edits[path] = resolveSegments(c.segments, choices);
    s.pathBase[path] = s.conflictRev ?? this.s.rev;
    s.conflicts = s.conflicts.filter((x) => x !== c);
    s.verified = undefined;
    s.approvals = [];
    this.log("resolve", `${s.agent} resolved ${path}`, s);
    if (!s.conflicts.length) s.status = "active";
    return s;
  }

  /** Resolve a conflicted path by supplying the final merged file (the easy path for agents). */
  resolveWith(id: string, path: string, content: string, actor?: Actor, basedOn?: number) {
    const s = this.session(id);
    this.assertOwner(s, actor);
    if (!s.conflicts.some((x) => x.path === path)) {
      const fresh = this.mergeAll(s);
      const c = fresh.conflicts.find((x) => x.path === path);
      if (!c) throw new WeaveError(`no conflict on ${path} against the current trunk`, 404);
      s.conflicts = fresh.conflicts;
      s.conflictRev = this.s.rev;
    }
    if (basedOn !== undefined && (!Number.isInteger(basedOn) || basedOn < 0 || basedOn > this.s.rev)) throw new WeaveError(`basedOn must be an integer between 0 and the current revision (r${this.s.rev})`);
    s.edits[path] = content;
    // The base must be the trunk the content was derived from. The agent knows it (it read it); we do not.
    // Defaulting to the conflict's revision would invent false conflicts whenever trunk moved between
    // detection and the agent's re-read, so default to "current trunk" and rely on revert detection to
    // stop a stale file from erasing landed work.
    s.pathBase[path] = basedOn ?? this.s.rev;
    s.conflicts = s.conflicts.filter((x) => x.path !== path);
    s.verified = undefined;
    s.approvals = [];
    this.log("resolve", `${s.agent} resolved ${path}`, s);
    if (!s.conflicts.length) s.status = "active";
    return s;
  }

  /** A verifier (test runner, reviewer agent) attests the merged result is sound, or sends it back. */
  verify(id: string, verifier: string, passed: boolean, note = "") {
    const s = this.session(id);
    if (s.status !== "needs_verify") throw new WeaveError(`session ${id} is not awaiting verification`, 409);
    if (verifier === s.agent) throw new WeaveError("an agent cannot verify its own change", 403);
    if (!passed) {
      s.status = "active";
      (s.feedback ??= []).push({ type: "verify_failed", by: verifier, note, ts: this.now() });
      this.log("verify_failed", `${verifier} rejected the merged result of ${s.agent}'s change${note ? `: ${note}` : ""}`, s, verifier);
      return { status: s.status };
    }
    s.verified = { by: verifier, rev: this.s.rev };
    this.log("verified", `${verifier} verified ${s.agent}'s merged change`, s, verifier);
    s.status = "active";
    return this.submit(id);
  }

  review(id: string, reviewer: string | { name: string; kind?: Kind | "unknown" }, approve: boolean, note = "") {
    const who = typeof reviewer === "string" ? { name: reviewer, kind: "unknown" as const } : { name: reviewer.name, kind: reviewer.kind ?? "unknown" };
    const s = this.session(id);
    if (s.status !== "in_review") {
      const last = s.feedback?.at(-1);
      throw new WeaveError(`session ${id} is not awaiting review: it is ${s.status}${s.status === "landed" ? ` (r${s.landedRev})` : ""}${last ? `; last feedback from ${last.by}: ${last.note.slice(0, 120)}` : ""}`, 409);
    }
    if (who.name === s.agent) throw new WeaveError("an agent cannot review its own change", 403);
    const claim = this.liveReviewClaim(s);
    if (claim && claim.by !== who.name) throw new WeaveError(`review of ${id} is claimed by ${claim.by} until ${new Date(claim.leaseUntil).toISOString()}`, 409);
    if (!approve) {
      s.status = "rejected";
      s.reviewClaim = undefined;
      this.releaseTaskFor(s);
      (s.feedback ??= []).push({ type: "rejected", by: who.name, note, ts: this.now() });
      this.log("rejected", `${who.name} rejected ${s.agent}'s change${note ? `: ${note}` : ""}`, s, who.name);
      return { status: s.status };
    }
    const open = Object.values(this.s.comments).filter((c) => c.sessionId === id && c.blocking && !c.resolved && !c.parent);
    if (open.length) throw new WeaveError(`${open.length} blocking comment thread(s) are unresolved`, 409);
    s.approvals.push({ by: who.name, kind: who.kind, ts: this.now() });
    s.reviewer = who.name;
    this.log("approved", `${who.name} approved ${s.agent}'s change`, s, who.name);
    return this.submit(id); // re-merge against *current* trunk; approval never lands a stale diff
  }

  abandon(id: string, actor?: Actor) {
    const s = this.session(id);
    this.assertOwner(s, actor);
    s.status = "rejected";
    s.reviewClaim = undefined;
    this.releaseTaskFor(s);
    this.log("abandoned", `${s.agent} abandoned their session`, s);
    this.pump();
  }

  // ---- review experience ------------------------------------------------
  addComment(id: string, c: { path: string; line: number; endLine?: number; author: string; body: string; suggestion?: string; parent?: string; blocking?: boolean }): Comment {
    const s = this.session(id);
    if (!c.body?.trim() && c.suggestion === undefined) throw new WeaveError("comment needs a body or a suggestion");
    if (c.parent && !this.s.comments[c.parent]) throw new WeaveError(`no such comment: ${c.parent}`, 404);
    const cm: Comment = { id: `c${++this.s.seq.comment}`, sessionId: id, path: c.path, line: c.line, endLine: c.endLine, author: c.author, body: c.body ?? "", suggestion: c.suggestion, parent: c.parent, blocking: !!c.blocking, resolved: false, ts: this.now() };
    this.s.comments[cm.id] = cm;
    this.notifyMentions(cm.body, c.author, { kind: "session", id }, `a review comment on ${c.path}:${c.line}`);
    if (c.author !== s.agent) this.notify(s.agent, "change_commented", `${c.author} commented on ${c.path}:${c.line}`, { kind: "session", id }, c.author);
    this.log("comment", `${c.author} commented on ${c.path}:${c.line}${c.suggestion !== undefined ? " (with a suggested change)" : ""}`, s, c.author);
    return cm;
  }
  resolveComment(commentId: string, by: string) {
    const c = this.s.comments[commentId];
    if (!c) throw new WeaveError(`no such comment: ${commentId}`, 404);
    const root = c.parent ? this.s.comments[c.parent] ?? c : c;
    root.resolved = true;
    this.log("comment_resolved", `${by} resolved a thread on ${root.path}:${root.line}`, this.sessionRO(root.sessionId), by);
    return root;
  }
  /** Apply a reviewer's suggested change to the session's own overlay (owner only). */
  applySuggestion(commentId: string, actor?: Actor) {
    const c = this.s.comments[commentId];
    if (!c || c.suggestion === undefined) throw new WeaveError("comment has no suggestion", 404);
    const s = this.session(c.sessionId);
    const cur = this.read(s.id, c.path);
    if (cur === null) throw new WeaveError(`${c.path} does not exist in this session`, 409);
    const lines = splitLines(cur);
    lines.splice(c.line - 1, (c.endLine ?? c.line) - c.line + 1, ...splitLines(c.suggestion));
    this.write(s.id, c.path, lines.join("\n"), actor);
    this.resolveComment(commentId, s.agent);
    return s;
  }
  comments(id: string) {
    return Object.values(this.s.comments).filter((c) => c.sessionId === id);
  }

  /** Everything a reviewer needs, ranked by what matters: risk, evidence, then per-file diffs. */
  reviewPack(id: string) {
    const s = this.sessionRO(id);
    const r = this.mergeAll(s);
    const risk = r.conflicts.length ? undefined : this.riskOf(s, r);
    const files: FileDiff[] = Object.entries(r.changes).map(([p, after]) => fileDiff(p, this.head(p), after));
    const behindBy = this.s.rev - s.baseRev;
    const evidence = s.evidence.map((e) => {
      const job = this.s.jobs[e.jobId];
      // evidence only counts if it was produced for exactly these edits and has not gone stale
      const current = !!job && job.editHash === this.editHash(s) && (job.status === "failed" || this.jobState(job, s) === "pass");
      return { check: e.check, passed: e.passed, rev: e.rev, runner: e.runner, current };
    });
    // Lead with what a reviewer most needs to know: is the diff below even the whole picture?
    const warnings: string[] = [];
    if (behindBy > 0) warnings.push(`Behind trunk by ${behindBy} revision(s): this change was started at r${s.baseRev} and trunk is at r${this.s.rev}.`);
    for (const c of r.conflicts) warnings.push(`This change no longer merges with trunk in ${c.path} (${c.kind}); that file is NOT in the diff below. It needs to go back to the author.`);
    if (this.s.config.checks.length && !evidence.some((e) => e.current && e.passed)) warnings.push(evidence.length ? "Check evidence is not current for these edits (stale or from earlier code); a pass on other code proves little." : "No check evidence yet.");
    for (const v of this.revertsOf(s, r.changes)) warnings.push(`Would remove ${v.lines} lines that ${v.agent} landed in r${v.rev} (${v.path}).`);
    for (const k of r.risks) warnings.push(`Interacts with concurrent work: ${k.detail}`);
    return {
      warnings, behindBy,
      id: s.id, agent: s.agent, goal: s.goal, status: s.status, model: s.model, baseRev: s.baseRev, headRev: this.s.rev,
      risk, need: risk?.need, approvals: s.approvals, semantic: r.risks, conflicts: r.conflicts.map((c) => ({ path: c.path, kind: c.kind })),
      evidence,
      previews: s.previews,
      stats: { files: files.length, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) },
      files, comments: this.comments(id),
    };
  }

  /** Human attention budget: the riskiest waiting items first, capped; the rest are deferred. */
  reviewQueue(kind: Kind | "unknown" = "unknown") {
    const waiting = Object.values(this.s.sessions).filter((x) => x.status === "in_review");
    const ranked = waiting
      .map((x) => ({ id: x.id, agent: x.agent, goal: x.goal, score: x.risk?.score ?? 0, tier: x.risk?.tier ?? "medium", need: x.risk?.need ?? "any", waitingMs: this.now() - x.createdAt, claimedBy: this.liveReviewClaim(x)?.by }))
      .sort((a, b) => b.score - a.score || b.waitingMs - a.waitingMs);
    const eligible = ranked.filter((x) => x.need !== "human" || kind === "human" || kind === "admin" || kind === "unknown");
    const budget = this.policy().attentionBudget;
    return { budget, next: eligible.slice(0, budget), deferred: eligible.slice(budget), notForYou: ranked.filter((x) => !eligible.includes(x)) };
  }

  // ---- forks ----------------------------------------------------------------
  /** Everything a fork needs: history up to `rev` (file versions, commits, tags, releases). No sessions, identities or secrets. */
  snapshot(rev = this.s.rev) {
    if (!Number.isInteger(rev) || rev < 0 || rev > this.s.rev) throw new WeaveError(`revision must be an integer between 0 and r${this.s.rev}`);
    const files: State["files"] = {};
    for (const [p, vs] of Object.entries(this.s.files)) {
      const keep = vs.filter((v) => v.rev <= rev);
      if (keep.length) files[p] = keep;
    }
    const tags = Object.fromEntries(Object.entries(this.s.tags).filter(([, x]) => x.rev <= rev));
    const releases = Object.fromEntries(Object.entries(this.s.releases).filter(([k]) => k in tags));
    return { rev, files, commits: this.s.commits.filter((c) => c.rev <= rev), tags, releases };
  }
  /** A new repository holding a copy of another's history. It has its own signing key, identities and config. */
  static fromSnapshot(snap: ReturnType<Repo["snapshot"]>, from: { repo: string }, now?: () => number): Repo {
    const r = new Repo(undefined, now);
    r.s.rev = snap.rev;
    r.s.files = snap.files;
    r.s.commits = snap.commits;
    r.s.tags = snap.tags;
    r.s.releases = snap.releases;
    r.s.mirror.lastRev = snap.rev;
    r.s.config.forkedFrom = { repo: from.repo, rev: snap.rev };
    r.log("forked", `forked from ${from.repo} at r${snap.rev}`);
    return r;
  }

  // ---- tasks (agent-native issues) ---------------------------------------
  private getTaskRaw(n: number): Task {
    const t = this.s.tasks[`t${n}`];
    if (!t) throw new WeaveError(`no such task #${n}`, 404);
    return t;
  }
  /** A claim whose lease ran out no longer holds the task. */
  private expireClaim(t: Task) {
    if (t.status === "claimed" && t.claim && t.claim.leaseUntil <= this.now()) {
      if (t.assignee === t.claim.by) t.assignee = undefined;
      t.claim = undefined;
      t.status = "open";
    }
    return t;
  }
  getTask(n: number): Task {
    return this.expireClaim(this.getTaskRaw(n));
  }
  private taskBlockers(t: Task): number[] {
    return t.dependsOn.filter((d) => {
      const x = this.s.tasks[`t${d}`];
      return x && x.status !== "done" && x.status !== "closed";
    });
  }
  private mentionsIn(text: string): string[] {
    return [...new Set([...text.matchAll(/(?<![\w@])@([A-Za-z][\w-]{0,38})/g)].map((m) => m[1]))];
  }
  private notify(to: string, type: NotificationType, message: string, ref: Notification["ref"], from?: string) {
    if (!to || to === from) return;
    const n: Notification = { id: `n${++this.s.seq.notification}`, to, ts: this.now(), type, message, ref, read: false };
    this.s.notifications.push(n);
    const mine = this.s.notifications.filter((x) => x.to === to);
    if (mine.length > 200) {
      const drop = new Set(mine.slice(0, mine.length - 200));
      this.s.notifications = this.s.notifications.filter((x) => !drop.has(x));
    }
  }
  private notifyMentions(text: string, from: string, ref: Notification["ref"], what: string, skip: string[] = []) {
    for (const who of this.mentionsIn(text)) if (!skip.includes(who)) this.notify(who, "mention", `${from} mentioned you in ${what}`, ref, from);
  }

  createTask(creator: string, o: { title: string; body?: string; labels?: string[]; priority?: Priority; dependsOn?: number[] }): Task {
    const title = (o.title ?? "").trim();
    if (!title) throw new WeaveError("task needs a title");
    if (title.length > 300) throw new WeaveError("task title is too long (300 characters max)");
    const priority = o.priority ?? "normal";
    if (!PRIORITIES.includes(priority)) throw new WeaveError(`priority must be one of ${PRIORITIES.join(", ")}`);
    const dependsOn = [...new Set(o.dependsOn ?? [])];
    for (const d of dependsOn) this.getTaskRaw(d);
    const number = ++this.s.seq.task;
    const now = this.now();
    const t: Task = { id: `t${number}`, number, title, body: o.body ?? "", labels: [...new Set(o.labels ?? [])], priority, status: "open", creator, sessions: [], comments: [], dependsOn, createdAt: now, updatedAt: now };
    this.s.tasks[t.id] = t;
    this.log("task_created", `${creator} opened task #${number}: ${title}`, undefined, creator);
    this.notifyMentions(`${title}\n${t.body}`, creator, { kind: "task", id: String(number) }, `task #${number}`);
    return t;
  }

  listTasks(f: { status?: TaskStatus; label?: string; q?: string; assignee?: string } = {}): Task[] {
    const q = f.q?.toLowerCase();
    return Object.values(this.s.tasks)
      .map((t) => this.expireClaim(t))
      .filter((t) => (!f.status || t.status === f.status) && (!f.label || t.labels.includes(f.label)) && (!f.assignee || t.assignee === f.assignee) && (!q || `${t.title}\n${t.body}`.toLowerCase().includes(q)))
      .sort((a, b) => b.number - a.number);
  }

  /** The best task for an agent to pick up: unclaimed, unblocked, highest priority, then oldest. */
  nextTask(f: { labels?: string[] } = {}): Task | null {
    const rank = (p: Priority) => PRIORITIES.indexOf(p);
    const c = this.listTasks({ status: "open" })
      .filter((t) => !this.taskBlockers(t).length && (!f.labels?.length || t.labels.some((l) => f.labels!.includes(l))))
      .sort((a, b) => rank(b.priority) - rank(a.priority) || a.createdAt - b.createdAt || a.number - b.number);
    return c[0] ?? null;
  }

  claimTask(n: number, by: string, leaseSec = 900): Task {
    const t = this.getTask(n);
    if (t.status === "done" || t.status === "closed") throw new WeaveError(`task #${n} is ${t.status}`, 409);
    if (t.claim && t.claim.by !== by) throw new WeaveError(`task #${n} is claimed by ${t.claim.by} until ${new Date(t.claim.leaseUntil).toISOString()}`, 409);
    const blockers = this.taskBlockers(t);
    if (blockers.length) throw new WeaveError(`task #${n} is blocked by ${blockers.map((b) => "#" + b).join(", ")}`, 409);
    const now = this.now();
    t.claim = { by, since: t.claim?.since ?? now, leaseUntil: now + Math.max(1, leaseSec) * 1000 };
    t.status = "claimed";
    t.assignee = by;
    t.updatedAt = now;
    if (!t.claim || t.claim.since === now) this.log("task_claimed", `${by} claimed task #${n}`, undefined, by);
    return t;
  }
  heartbeatTask(n: number, by: string, leaseSec = 900): Task {
    const t = this.getTask(n);
    if (!t.claim || t.claim.by !== by) throw new WeaveError(t.claim ? `task #${n} is claimed by ${t.claim.by}, not ${by}` : `task #${n} is not claimed (the lease may have expired)`, 409);
    t.claim.leaseUntil = this.now() + Math.max(1, leaseSec) * 1000;
    return t;
  }
  releaseTask(n: number, by: string): Task {
    const t = this.getTask(n);
    if (t.claim && t.claim.by !== by) throw new WeaveError(`task #${n} is claimed by ${t.claim.by}, not ${by}`, 409);
    if (t.status === "claimed") {
      if (t.assignee === t.claim?.by) t.assignee = undefined;
      t.claim = undefined;
      t.status = "open";
      t.updatedAt = this.now();
      this.log("task_released", `${by} released task #${n}`, undefined, by);
    }
    return t;
  }
  closeTask(n: number, by: string): Task {
    const t = this.getTask(n);
    t.status = "closed";
    t.claim = undefined;
    t.closedAt = t.updatedAt = this.now();
    this.log("task_closed", `${by} closed task #${n}`, undefined, by);
    return t;
  }
  reopenTask(n: number, by: string): Task {
    const t = this.getTask(n);
    t.status = "open";
    t.closedAt = undefined;
    t.updatedAt = this.now();
    this.log("task_reopened", `${by} reopened task #${n}`, undefined, by);
    return t;
  }
  commentTask(n: number, by: string, body: string): Task {
    const t = this.getTask(n);
    if (!body?.trim()) throw new WeaveError("comment needs a body");
    t.comments.push({ id: `tc${t.comments.length + 1}`, author: by, body, ts: this.now() });
    t.updatedAt = this.now();
    const ref = { kind: "task" as const, id: String(n) };
    const mentioned = this.mentionsIn(body);
    this.notifyMentions(body, by, ref, `task #${n}`);
    for (const who of new Set([t.assignee, t.claim?.by])) if (who && !mentioned.includes(who)) this.notify(who, "task_commented", `${by} commented on task #${n}`, ref, by);
    return t;
  }
  assignTask(n: number, assignee: string, by: string): Task {
    const t = this.getTask(n);
    t.assignee = assignee;
    t.updatedAt = this.now();
    this.notify(assignee, "task_assigned", `${by} assigned you task #${n}: ${t.title}`, { kind: "task", id: String(n) }, by);
    return t;
  }
  updateTask(n: number, p: { title?: string; body?: string; labels?: string[]; priority?: Priority; dependsOn?: number[] }): Task {
    const t = this.getTask(n);
    if (p.title !== undefined) {
      if (!p.title.trim()) throw new WeaveError("task needs a title");
      t.title = p.title.trim();
    }
    if (p.body !== undefined) t.body = p.body;
    if (p.labels) t.labels = [...new Set(p.labels)];
    if (p.priority) {
      if (!PRIORITIES.includes(p.priority)) throw new WeaveError(`priority must be one of ${PRIORITIES.join(", ")}`);
      t.priority = p.priority;
    }
    if (p.dependsOn) {
      for (const d of p.dependsOn) if (d === n) throw new WeaveError("a task cannot depend on itself");
      for (const d of p.dependsOn) this.getTaskRaw(d);
      t.dependsOn = [...new Set(p.dependsOn)];
    }
    t.updatedAt = this.now();
    return t;
  }
  private releaseTaskFor(s: Session) {
    const t = s.taskNumber ? this.s.tasks[`t${s.taskNumber}`] : undefined;
    if (t && t.status === "claimed" && t.claim?.by === s.agent) this.releaseTask(t.number, s.agent);
  }

  // ---- notifications -------------------------------------------------------
  notificationsFor(to: string, f: { unread?: boolean } = {}): Notification[] {
    return this.s.notifications.filter((n) => n.to === to && (!f.unread || !n.read)).reverse();
  }
  markRead(to: string, f: { ids?: string[]; all?: boolean }) {
    let n = 0;
    for (const x of this.s.notifications) if (x.to === to && !x.read && (f.all || f.ids?.includes(x.id))) (x.read = true), n++;
    return { marked: n };
  }
  private notifyReviewers(s: Session, need: Need) {
    for (const i of Object.values(this.s.identities)) {
      if (i.disabled || i.name === s.agent) continue;
      if (i.kind === "human" || (i.kind === "reviewer" && need !== "human")) this.notify(i.name, "review_requested", `${s.agent}'s change needs review: ${s.goal}`, { kind: "session", id: s.id }, s.agent);
    }
  }

  // ---- tags and releases ---------------------------------------------------
  createTag(name: string, o: { rev?: number; message?: string; tagger: string }): Tag {
    if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/.test(name) || name.includes("..")) throw new WeaveError("invalid tag name: use letters, digits, '.', '_', '-', '/' (max 100)");
    if (this.s.tags[name]) throw new WeaveError(`tag ${name} already exists (tags are immutable)`, 409);
    const rev = o.rev ?? this.s.rev;
    if (!Number.isInteger(rev) || rev < 0 || rev > this.s.rev) throw new WeaveError(`revision must be an integer between 0 and r${this.s.rev}`);
    const t: Tag = { name, rev, message: o.message ?? "", tagger: o.tagger, ts: this.now() };
    this.s.tags[name] = t;
    this.log("tag", `${o.tagger} tagged ${name} at r${rev}`, undefined, o.tagger);
    return t;
  }
  listTags(): Tag[] {
    return Object.values(this.s.tags).sort((a, b) => b.ts - a.ts || a.name.localeCompare(b.name));
  }
  createRelease(o: { tag: string; title: string; notes: string; draft?: boolean; prerelease?: boolean }, author: string): Release {
    if (!this.s.tags[o.tag]) throw new WeaveError(`no such tag: ${o.tag}`, 404);
    if (this.s.releases[o.tag]) throw new WeaveError(`tag ${o.tag} already has a release`, 409);
    const r: Release = { tag: o.tag, title: o.title || o.tag, notes: o.notes ?? "", author, ts: this.now(), draft: !!o.draft, prerelease: !!o.prerelease };
    this.s.releases[o.tag] = r;
    this.log("release", `${author} published release ${r.title} (${o.tag})`, undefined, author);
    return r;
  }
  getRelease(tag: string): Release {
    const r = this.s.releases[tag];
    if (!r) throw new WeaveError(`no release for tag ${tag}`, 404);
    return r;
  }
  listReleases(): Release[] {
    return Object.values(this.s.releases).sort((a, b) => b.ts - a.ts);
  }

  // ---- review claims -------------------------------------------------------
  private liveReviewClaim(s: Session) {
    return s.reviewClaim && s.reviewClaim.leaseUntil > this.now() ? s.reviewClaim : undefined;
  }
  claimReview(id: string, by: string, leaseSec = 900): Session {
    const s = this.session(id);
    if (s.status !== "in_review") throw new WeaveError(`session ${id} is not awaiting review: it is ${s.status}`, 409);
    const c = this.liveReviewClaim(s);
    if (c && c.by !== by) throw new WeaveError(`review of ${id} is claimed by ${c.by} until ${new Date(c.leaseUntil).toISOString()}`, 409);
    const now = this.now();
    s.reviewClaim = { by, since: c?.since ?? now, leaseUntil: now + Math.max(1, leaseSec) * 1000 };
    this.dirtySessions.add(id);
    if (!c) this.log("review_claimed", `${by} is reviewing ${s.agent}'s change`, s, by);
    return s;
  }

  // ---- config as code (weave.json) -----------------------------------------
  /** Validate weave.json and turn it into a config patch. Webhooks, mirrors and shards are never taken from a file. */
  static parseConfigFile(text: string): { patch: Partial<Config> } | { error: string } {
    let j: any;
    try {
      j = JSON.parse(text);
    } catch (e) {
      return { error: `weave.json is not valid JSON (${(e as Error).message})` };
    }
    if (!j || typeof j !== "object" || Array.isArray(j)) return { error: "weave.json must be a JSON object" };
    const patch: Partial<Config> = {};
    const strs = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
    if (j.checks !== undefined) {
      if (!Array.isArray(j.checks) || !j.checks.every((c: any) => c && typeof c.name === "string" && typeof c.command === "string" && (c.timeoutMs === undefined || typeof c.timeoutMs === "number")))
        return { error: "weave.json: checks must be a list of {name, command, timeoutMs?}" };
      patch.checks = j.checks;
    }
    if (j.reviewPaths !== undefined) {
      if (!strs(j.reviewPaths)) return { error: "weave.json: reviewPaths must be a list of strings" };
      patch.reviewPaths = j.reviewPaths;
    }
    if (j.policy !== undefined) {
      if (!j.policy || typeof j.policy !== "object" || Array.isArray(j.policy)) return { error: "weave.json: policy must be an object" };
      const p: Record<string, unknown> = {};
      for (const k of Object.keys(DEFAULT_POLICY)) if (k in j.policy) {
        if (typeof j.policy[k] !== typeof (DEFAULT_POLICY as any)[k]) return { error: `weave.json: policy.${k} must be a ${typeof (DEFAULT_POLICY as any)[k]}` };
        p[k] = j.policy[k];
      }
      patch.policy = p as unknown as Policy;
    }
    if (j.merge !== undefined) {
      if (!j.merge || typeof j.merge !== "object" || (j.merge.union !== undefined && !strs(j.merge.union))) return { error: "weave.json: merge must be {lists?, union?: string[]}" };
      patch.merge = { lists: j.merge.lists !== false, union: j.merge.union ?? [] };
    }
    return { patch };
  }

  // ---- provenance -----------------------------------------------------
  signature(c: Commit): string {
    return hmacSha256(this.s.secrets.signingKey, c.hash ?? "");
  }
  provenance(rev: number) {
    const c = this.s.commits.find((x) => x.rev === rev);
    if (!c) throw new WeaveError(`no such revision: r${rev}`, 404);
    return { rev, record: c.provenance, hash: c.hash, signature: this.signature(c) };
  }
  /** Recompute the whole chain; any edited, removed or reordered record is detected. */
  verifyChain(): { ok: boolean; checked: number; firstBad?: number } {
    let prev = "";
    for (const c of this.s.commits) {
      if (!c.provenance) continue;
      if (c.provenance.prevHash !== prev || sha256(prev + canonical(c.provenance)) !== c.hash) return { ok: false, checked: c.rev - 1, firstBad: c.rev };
      prev = c.hash!;
    }
    return { ok: true, checked: this.s.commits.length };
  }
  verifyAudit(): { ok: boolean; checked: number } {
    // the in-memory window is a suffix of the chain; verify internal consistency of the window
    let prev: string | undefined;
    for (const e of this.s.events) {
      if (prev !== undefined) {
        const { hash, ...base } = e;
        if (sha256(prev + canonical(base)) !== hash) return { ok: false, checked: e.id };
      }
      prev = e.hash;
    }
    return { ok: true, checked: this.s.events.length };
  }

  /** Snapshot for read APIs (never includes secrets or token hashes). */
  publicState() {
    const { secrets: _s, identities: _i, jobs: _j, outbox: _o, ...rest } = this.s;
    return rest;
  }
}
