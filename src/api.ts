// Pure request router over a Repo. The Durable Object wraps this with auth + persistence.
import { exportFastImport } from "./export.ts";
import { LIVE, Repo, WeaveError, type Actor, type Kind, type Scope } from "./repo.ts";
import { SCENARIO, SEED } from "./scenario.ts";

export const ALL_SCOPES: Scope[] = ["read", "write", "review", "verify", "runner", "admin"];
export const openActor = (name = "anonymous"): Actor => ({ id: "open", name, kind: "admin", scopes: ALL_SCOPES, paths: [], open: true });

/** Which scope(s) a route needs; any one of them suffices. */
export function requiredScopes(method: string, parts: string[]): Scope[] {
  const [a, , c, d] = parts;
  if (a === "identities" || a === "config" || a === "reset" || a === "import") return method === "GET" && a === "config" ? ["read"] : ["admin"];
  if (a === "runner") return ["runner"];
  if (a === "sessions" && method === "POST") {
    if (c === "verify") return ["verify"];
    if (c === "review") return ["review"];
    if (c === "comments") return d === "resolve" ? ["review", "write"] : ["review", "write"];
  }
  if (method === "POST") return ["write"];
  return ["read"];
}

const mask = (r: Repo) => ({ ...r.config, webhooks: r.config.webhooks.map((w) => ({ ...w, secret: w.secret ? "***" : "" })) });

export interface Ctx {
  repo: Repo;
  actor: Actor;
  method: string;
  parts: string[]; // path after /api/
  url: URL;
  body: any;
  /** called when the whole repo is replaced (reset) */
  replace?: (r: Repo) => void;
}

const who = (c: Ctx, field: string, fallback = "anonymous") => (c.actor.open ? String(c.body[field] ?? c.body.agent ?? fallback) : c.actor.name);
const kindOf = (c: Ctx): Kind | "unknown" => (c.actor.open ? (c.body.kind ?? "unknown") : c.actor.kind);

export function route(c: Ctx): unknown {
  const { repo, method, parts, url, body } = c;
  const [a, id, sub, sid, act] = parts;
  const headState = () => ({ rev: repo.s.rev, files: repo.filesAt(), commits: repo.s.commits.slice(-50).map(({ provenance: _p, ...x }) => x), sessions: Object.values(repo.s.sessions).map(({ edits, conflicts, ...x }) => ({ ...x, edits: Object.fromEntries(Object.keys(edits).map((k) => [k, true])), conflictPaths: conflicts.map((k) => k.path) })), events: repo.s.events.slice(-100), reviewPaths: repo.config.reviewPaths, config: mask(repo), policy: repo.policy() });

  if (method === "GET") {
    if (a === "state") return headState();
    if (a === "status")
      return {
        rev: repo.s.rev, files: repo.listFiles(), policy: repo.policy(), checks: repo.config.checks, protectedPaths: repo.config.reviewPaths,
        shard: Object.keys(repo.config.shards).length ? repo.config.shard : undefined,
        sessions: Object.values(repo.s.sessions).filter((s) => LIVE.includes(s.status)).map((s) => ({ id: s.id, agent: s.agent, goal: s.goal, status: s.status, intent: s.intent, paths: Object.keys(s.edits), risk: s.risk?.tier })),
      };
    if (a === "commits") {
      const n = Math.min(100, Number(url.searchParams.get("limit") ?? 20));
      return repo.s.commits.slice(-n).reverse().map((c) => ({ rev: c.rev, agent: c.agent, message: c.message, paths: c.paths, merged: c.merged, ts: c.ts, risk: c.provenance?.risk?.tier, hash: c.hash }));
    }
    if (a === "scenario") return { steps: SCENARIO };
    if (a === "export") return { __raw: exportFastImport(repo.s) };
    if (a === "config") return mask(repo);
    if (a === "identities") return repo.listIdentities();
    if (a === "jobs") return Object.values(repo.s.jobs).map(({ overlay: _o, ...j }) => j);
    if (a === "trunk" && id === "files") return { rev: repo.s.rev, files: repo.listFiles(url.searchParams.has("rev") ? Number(url.searchParams.get("rev")) : undefined) };
    if (a === "trunk" && id === "file") {
      const p = url.searchParams.get("path") ?? "";
      const rev = url.searchParams.has("rev") ? Number(url.searchParams.get("rev")) : repo.s.rev;
      return { path: p, rev, content: repo.fileAt(p, rev) };
    }
    if (a === "review" && id === "queue") return repo.reviewQueue(kindOf(c));
    if (a === "provenance") return id ? repo.provenance(Number(id)) : { chain: repo.verifyChain(), audit: repo.verifyAudit(), head: repo.s.commits.at(-1)?.hash };
    if (a === "sessions" && !id) return Object.values(repo.s.sessions).map(({ edits, conflicts, ...x }) => ({ ...x, paths: Object.keys(edits), conflictPaths: conflicts.map((k) => k.path) }));
    if (a === "sessions" && id) {
      if (sub === "file") return { path: url.searchParams.get("path"), content: repo.read(id, url.searchParams.get("path")!) };
      if (sub === "preview") return repo.preview(id);
      if (sub === "review-pack") return repo.reviewPack(id);
      if (sub === "comments") return repo.comments(id);
      const { edits, ...s } = repo.sessionRO(id);
      return { ...s, paths: Object.keys(edits) };
    }
  }

  if (method === "POST") {
    if (a === "reset") {
      const fresh = new Repo();
      if (!body.empty) {
        fresh.seed(SEED, "initial import");
        fresh.setReviewPaths(["src/auth"]);
      }
      // keep identities and config: reset only clears repository content and sessions
      fresh.s.identities = repo.s.identities;
      fresh.s.seq.identity = repo.s.seq.identity;
      fresh.s.config = { ...repo.s.config, ...(body.empty ? {} : { reviewPaths: ["src/auth"] }) };
      fresh.s.reviewPaths = fresh.s.config.reviewPaths;
      c.replace?.(fresh);
      return { ok: true };
    }
    if (a === "import") {
      if (!body.files || typeof body.files !== "object") throw new WeaveError("body must be {files: {path: content}}");
      return { rev: repo.seed(body.files, body.message ?? "import from git") };
    }
    if (a === "config") {
      repo.setConfig(body);
      return mask(repo);
    }
    if (a === "identities" && !id) return repo.createIdentity(body);
    if (a === "identities" && id && sub === "revoke") return (repo.revokeIdentity(id), { ok: true });
    if (a === "runner" && id === "claim") {
      const j = repo.claimJob(c.actor.open ? String(body.runner ?? "runner") : c.actor.name);
      return j ? { job: j } : { job: null };
    }
    if (a === "runner" && id === "jobs" && sid === "result")
      return repo.jobResult(sub, c.actor.open ? String(body.runner ?? "runner") : c.actor.name, { passed: !!body.passed, output: body.output, durationMs: body.durationMs, previewUrl: body.previewUrl });
    if (a === "sessions" && !id) {
      const agent = c.actor.open ? String(body.agent ?? "anonymous") : c.actor.name;
      return repo.open({ id: body.id, agent, goal: String(body.goal ?? ""), intent: body.intent, actor: c.actor, model: body.model, prompt: body.prompt, baseRev: body.baseRev });
    }
    if (a === "sessions" && id) {
      if (sub === "file") return (repo.write(id, body.path, body.content, c.actor, body.basedOn), { ok: true });
      if (sub === "intent") return { warnings: repo.declare(id, body.paths ?? []) };
      if (sub === "submit") return repo.submit(id, body.message, c.actor, { allowRevert: !!body.allowRevert });
      if (sub === "resolve") return typeof body.content === "string" ? repo.resolveWith(id, body.path, body.content, c.actor) : repo.resolve(id, body.path, body.choices ?? body.how, c.actor);
      if (sub === "rerun") return repo.rerunChecks(id);
      if (sub === "abandon") return (repo.abandon(id, c.actor), { ok: true });
      if (sub === "verify") return repo.verify(id, who(c, "verifier"), !!body.passed, body.note);
      if (sub === "review") return repo.review(id, { name: who(c, "reviewer"), kind: kindOf(c) }, !!body.approve, body.note);
      if (sub === "comments" && !sid) return repo.addComment(id, { path: body.path, line: Number(body.line), endLine: body.endLine, author: who(c, "author"), body: body.body ?? "", suggestion: body.suggestion, parent: body.parent, blocking: body.blocking });
      if (sub === "comments" && sid && act === "resolve") return repo.resolveComment(sid, who(c, "author"));
      if (sub === "comments" && sid && act === "apply") return repo.applySuggestion(sid, c.actor);
    }
  }
  throw new WeaveError(`no route: ${method} /${parts.join("/")}`, 404);
}
