import { DurableObject } from "cloudflare:workers";
import { ALL_SCOPES, openActor, requiredScopes, route } from "./api.ts";
import { hmacSha256, timingSafeEqual } from "./crypto.ts";
import { handleGitRequest, mirrorPush } from "./git/index.ts";
import { Repo, WeaveError, emptyState, type Actor } from "./repo.ts";
import { shardOf } from "./shard.ts";
import { DASHBOARD } from "./dashboard.ts";
import { handleMcpRequest } from "./mcp.ts";
import { Store } from "./store.ts";

export interface Env {
  REPO: DurableObjectNamespace<RepoDO>;
  /** optional: large file contents are offloaded here */
  BLOBS?: R2Bucket;
  /** when set, every API call must carry a token; when unset the service runs in open dev mode */
  WEAVE_ADMIN_TOKEN?: string;
  /** token used to push history to the configured mirror remote (e.g. a GitHub PAT) */
  MIRROR_TOKEN?: string;
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One Durable Object per repo shard: a single-threaded, strongly-consistent trunk with SQLite storage. */
export class RepoDO extends DurableObject<Env> {
  private repo!: Repo;
  private store!: Store;
  private saving: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const bucket = env.BLOBS;
      this.store = new Store({
        sql: ctx.storage.sql,
        transactionSync: (fn) => ctx.storage.transactionSync(fn),
        blobs: bucket ? { put: async (k, v) => void (await bucket.put(k, v)), get: async (k) => (await (await bucket.get(k))?.text()) ?? null } : undefined,
      });
      this.repo = new Repo(await this.store.load());
    });
  }

  // ---- RPC (called by the Worker) ----
  async authenticate(token: string): Promise<Actor | null> {
    return this.repo.authenticate(token);
  }
  async shardConfig(): Promise<{ shards: Record<string, string[]> }> {
    return { shards: this.repo.config.shards };
  }

  /** Serialize persistence so concurrent requests can never interleave partial writes. */
  private persist(): Promise<unknown> {
    const run = async () => {
      try {
        await this.store.save(this.repo);
      } catch (e) {
        this.repo = new Repo(await this.store.load()); // roll memory back to what is durable
        throw e;
      }
    };
    this.saving = this.saving.then(run, run);
    return this.saving;
  }

  private gitAuth(req: Request): { agent: string; actor?: Actor } | null {
    const h = req.headers.get("authorization") ?? "";
    let user = "";
    let pass = "";
    if (h.startsWith("Basic ")) {
      try {
        const d = atob(h.slice(6));
        user = d.slice(0, d.indexOf(":"));
        pass = d.slice(d.indexOf(":") + 1);
      } catch {}
    } else if (h.startsWith("Bearer ")) pass = h.slice(7).trim();
    const admin = this.env.WEAVE_ADMIN_TOKEN;
    if (!admin) return { agent: user || "git" }; // open dev mode
    if (!pass) return null;
    if (timingSafeEqual(pass, admin)) return { agent: user || "root", actor: { id: "root", name: user || "root", kind: "admin", scopes: ALL_SCOPES, paths: [] } };
    const a = this.repo.authenticate(pass);
    return a ? { agent: a.name, actor: a } : null;
  }

  /** Push new trunk history to the configured mirror (e.g. GitHub). Serialized; retried on the next landing. */
  private mirroring = false;
  async mirror() {
    const url = this.repo.config.mirror?.url;
    const token = this.env.MIRROR_TOKEN;
    if (!url || !token || this.mirroring || this.repo.s.rev <= this.repo.s.mirror.lastRev || Object.keys(this.repo.config.shards).length) return;
    this.mirroring = true;
    try {
      const r = await mirrorPush(this.repo, url, token, this.repo.s.mirror.lastRev);
      this.repo.s.mirror.lastRev = r.pushedRev;
    } catch (e) {
      this.repo.note("mirror_failed", `mirror push failed: ${String((e as Error).message ?? e).slice(0, 300)}`);
    } finally {
      this.mirroring = false;
    }
    await this.persist().catch(() => {});
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/git/")) {
      const host = { repo: this.repo, authenticate: (r: Request) => this.gitAuth(r), persist: async () => { await this.persist(); this.ctx.waitUntil(this.deliver()); this.ctx.waitUntil(this.mirror()); } };
      return handleGitRequest(req, host, "/git");
    }
    const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
    const actor: Actor = req.headers.get("x-weave-actor") ? JSON.parse(req.headers.get("x-weave-actor")!) : openActor();
    const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    try {
      if (req.method === "GET" && parts[0] === "events") return await this.events(url);
      let replaced = false;
      const out: any = route({ repo: this.repo, actor, method: req.method, parts, url, body, replace: (r) => ((this.repo = r), (replaced = true)) });
      if (out?.__raw !== undefined) return new Response(out.__raw, { headers: { "content-type": "text/plain; charset=utf-8" } });
      if (req.method !== "GET") {
        if (replaced) this.store.reset();
        await this.persist();
        this.ctx.waitUntil(this.deliver());
        this.ctx.waitUntil(this.mirror());
      }
      return json(out);
    } catch (e) {
      if (e instanceof WeaveError) return json({ error: e.message }, e.status);
      return json({ error: String((e as Error)?.message ?? e) }, 500);
    }
  }

  /** Long-poll: GET /api/events?after=<id>&wait=<seconds> */
  private async events(url: URL) {
    const after = Number(url.searchParams.get("after") ?? 0);
    const until = Date.now() + Math.min(25, Number(url.searchParams.get("wait") ?? 0)) * 1000;
    for (;;) {
      const ev = this.repo.s.events.filter((e) => e.id > after);
      if (ev.length || Date.now() >= until) return json({ events: ev, last: this.repo.s.seq.event });
      await sleep(250);
    }
  }

  // ---- webhooks: signed deliveries with exponential backoff, retried from alarms ----
  async deliver() {
    const now = Date.now();
    const due = this.repo.s.outbox.filter((o) => o.status === "pending" && o.nextAt <= now).slice(0, 20);
    await Promise.all(
      due.map(async (o) => {
        const hook = this.repo.config.webhooks.find((w) => w.id === o.hookId);
        if (!hook) return void ((o.status = "failed"), (o.lastError = "webhook removed"));
        const payload = JSON.stringify({ delivery: o.id, event: o.event });
        try {
          const res = await fetch(hook.url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-weave-event": o.event.type, "x-weave-delivery": o.id, "x-weave-signature": "sha256=" + hmacSha256(hook.secret, payload) },
            body: payload,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          o.status = "delivered";
        } catch (e) {
          o.attempts++;
          o.lastError = String((e as Error).message ?? e);
          if (o.attempts >= 8) o.status = "failed";
          else o.nextAt = Date.now() + Math.min(2 ** o.attempts * 5000, 3_600_000);
        }
      }),
    );
    if (due.length) await this.persist().catch(() => {});
    const next = this.repo.s.outbox.filter((o) => o.status === "pending").map((o) => o.nextAt).sort((a, b) => a - b)[0];
    if (next !== undefined) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1000));
  }
  async alarm() {
    await this.deliver();
  }
}

// ---------------------------------------------------------------------------------------------
// Worker: authentication, scopes, shard routing

const stubFor = (env: Env, repo: string, shard: string) => env.REPO.get(env.REPO.idFromName(shard === "main" ? repo : `${repo}~${shard}`));
const shardCache = new Map<string, { at: number; shards: Record<string, string[]> }>();

async function shardsOf(env: Env, repo: string) {
  const hit = shardCache.get(repo);
  if (hit && Date.now() - hit.at < 5000) return hit.shards;
  const { shards } = await stubFor(env, repo, "main").shardConfig();
  shardCache.set(repo, { at: Date.now(), shards });
  return shards;
}

function tokenOf(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (h?.startsWith("Bearer ")) return h.slice(7).trim();
  if (h?.startsWith("Basic ")) {
    try {
      const d = atob(h.slice(6));
      return d.slice(d.indexOf(":") + 1);
    } catch {
      return null;
    }
  }
  return req.headers.get("x-weave-token");
}

export async function authenticate(req: Request, env: Env, repo: string): Promise<Actor | null> {
  if (!env.WEAVE_ADMIN_TOKEN) return null; // open mode, handled by caller
  const t = tokenOf(req);
  if (!t) return null;
  if (timingSafeEqual(t, env.WEAVE_ADMIN_TOKEN)) return { id: "root", name: "root", kind: "admin", scopes: ALL_SCOPES, paths: [] };
  return stubFor(env, repo, "main").authenticate(t);
}

async function call(env: Env, repo: string, shard: string, method: string, path: string, search: string, actor: Actor, body?: unknown): Promise<Response> {
  return stubFor(env, repo, shard).fetch(
    new Request(`https://do/api/${path}${search}`, {
      method,
      headers: { "content-type": "application/json", "x-weave-actor": JSON.stringify(actor) },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    }),
  );
}

async function handleApi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const repo = url.searchParams.get("repo") ?? "default";
  const parts = url.pathname.split("/").filter(Boolean).slice(1);
  const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};

  let actor = await authenticate(req, env, repo);
  if (!actor) {
    if (env.WEAVE_ADMIN_TOKEN) return json({ error: "authentication required: send Authorization: Bearer <token>" }, 401, { "www-authenticate": "Bearer" });
    actor = openActor(String(body.agent ?? body.reviewer ?? body.verifier ?? body.runner ?? body.author ?? "anonymous"));
  }
  if (!actor.open) {
    const need = requiredScopes(req.method, parts);
    if (!need.some((s) => actor!.scopes.includes(s))) return json({ error: `forbidden: ${actor.name} lacks scope ${need.join(" or ")}` }, 403);
  }

  const shards = await shardsOf(env, repo);
  const names = ["main", ...Object.keys(shards).filter((n) => n !== "main")];
  const search = url.search.replace(/[?&]repo=[^&]*/, "").replace(/^&/, "?");
  const path = parts.join("/");
  const sharded = names.length > 1;
  const one = (shard: string, b: unknown = body, p = path) => call(env, repo, shard, req.method, p, search, actor!, b);

  // Configuration is applied to every shard it defines, and the routing cache is dropped, so the
  // first call that turns an unsharded repo into a sharded one takes effect immediately.
  if (parts[0] === "config" && req.method === "POST") {
    const next: Record<string, string[]> = body.shards ?? shards;
    let last: Response = json({});
    for (const n of ["main", ...Object.keys(next).filter((k) => k !== "main")]) last = await one(n, { ...body, shard: n, shards: next });
    shardCache.delete(repo);
    return last;
  }
  if (!sharded) return one("main");

  // ---- sharded repositories ----
  const [a, id] = parts;
  const shardOfId = (sid: string) => (sid.includes("~") ? sid.split("~")[0] : "main");
  const strip = (sid: string) => (sid.includes("~") ? sid.slice(sid.indexOf("~") + 1) : sid);
  if (a === "sessions" && id) return one(shardOfId(id), body, path.replace(id, strip(id)));
  if (a === "sessions" && req.method === "POST") {
    const shard = String(body.shard ?? shardOf(String(body.intent?.[0] ?? ""), shards));
    if (!names.includes(shard)) return json({ error: `unknown shard: ${shard}` }, 400);
    const local = String(body.id ?? `${body.agent ?? actor.name}-${Date.now().toString(36)}`);
    const res = await one(shard, { ...body, id: local });
    const out: any = await res.json();
    if (out.session) out.session.id = shard === "main" ? local : `${shard}~${local}`;
    return json(out, res.status);
  }
  if (a === "runner" && id === "claim") {
    for (const n of names) {
      const out: any = await (await one(n)).json();
      if (out.job) return json({ job: { ...out.job, id: n === "main" ? out.job.id : `${n}~${out.job.id}`, shard: n } });
    }
    return json({ job: null });
  }
  if (a === "runner" && id === "jobs") return one(shardOfId(parts[2]), body, path.replace(parts[2], strip(parts[2])));
  if (a === "reset" && req.method === "POST") {
    for (const n of names) await one(n, { ...body, empty: true });
    return json({ ok: true, note: "sharded repositories reset empty; use /api/import to load files" });
  }
  if (a === "import" && req.method === "POST") {
    const by: Record<string, Record<string, string>> = {};
    for (const [p, c] of Object.entries<string>(body.files ?? {})) ((by[shardOf(p, shards)] ??= {})[p] = c);
    const revs: Record<string, unknown> = {};
    for (const [n, files] of Object.entries(by)) revs[n] = ((await (await one(n, { ...body, files })).json()) as any).rev;
    return json({ revs });
  }
  if (req.method === "GET" && a === "state") {
    const all = await Promise.all(names.map(async (n) => [n, (await (await one(n)).json()) as any] as const));
    const merged: any = { rev: Math.max(...all.map(([, s]) => s.rev)), shards: Object.fromEntries(all.map(([n, s]) => [n, s.rev])), files: {}, commits: [], sessions: [], events: [], reviewPaths: all[0][1].reviewPaths, config: all[0][1].config, policy: all[0][1].policy };
    for (const [n, s] of all) {
      Object.assign(merged.files, s.files);
      merged.commits.push(...s.commits.map((c: any) => ({ ...c, shard: n })));
      merged.sessions.push(...s.sessions.map((x: any) => ({ ...x, id: n === "main" ? x.id : `${n}~${x.id}`, shard: n })));
      merged.events.push(...s.events.map((e: any) => ({ ...e, shard: n })));
    }
    merged.commits.sort((x: any, y: any) => x.ts - y.ts);
    merged.events.sort((x: any, y: any) => x.ts - y.ts);
    return json(merged);
  }
  if (a === "events") return one(url.searchParams.get("shard") ?? "main");
  if (a === "trunk" && id === "file") return one(shardOf(url.searchParams.get("path") ?? "", shards));
  if (a === "trunk" && id === "files") {
    const all = await Promise.all(names.map(async (n) => (await (await one(n)).json()) as any));
    return json({ files: all.flatMap((s) => s.files).sort(), revs: all.map((s) => s.rev) });
  }
  return one("main"); // identities, provenance of main, review queue of main, export of main, …
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json({ ok: true, auth: env.WEAVE_ADMIN_TOKEN ? "required" : "open" });
    const g = /^\/git\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (g) {
      // `git clone https://<host>/git/<repo>`; served by the repo's main shard, credentials checked inside the DO
      const inner = new URL(req.url);
      inner.pathname = `/git${g[2]}`;
      return stubFor(env, decodeURIComponent(g[1]), "main").fetch(new Request(inner, req));
    }
    if (url.pathname === "/mcp") {
      if (env.WEAVE_ADMIN_TOKEN && !(await authenticate(req, env, url.searchParams.get("repo") ?? "default")))
        return json({ error: "authentication required: send Authorization: Bearer <token>" }, 401, { "www-authenticate": "Bearer" });
      // MCP tools dispatch through the same authenticated API path as everything else
      const dispatch = async (method: "GET" | "POST", path: string, body?: unknown) => {
        const headers = new Headers(req.headers);
        headers.set("content-type", "application/json");
        const r = await handleApi(new Request(`${url.origin}/api/${path}${url.search ? (path.includes("?") ? "&" : "?") + url.search.slice(1) : ""}`, { method, headers, body: method === "POST" ? JSON.stringify(body ?? {}) : undefined }), env);
        return { status: r.status, json: await r.json().catch(() => ({})) };
      };
      return handleMcpRequest(req, dispatch);
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(req, env);
      } catch (e) {
        return json({ error: String((e as Error)?.message ?? e) }, 500);
      }
    }
    return new Response(DASHBOARD, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};
