import { DurableObject } from "cloudflare:workers";
import { Repo, WeaveError, emptyState, type State } from "./repo.ts";
import { SCENARIO, SEED } from "./scenario.ts";
import { DASHBOARD } from "./dashboard.ts";

interface Env {
  REPO: DurableObjectNamespace<RepoDO>;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** One Durable Object per repo: a single-threaded, strongly-consistent trunk. */
export class RepoDO extends DurableObject {
  private repo?: Repo;

  private async load(): Promise<Repo> {
    if (!this.repo) this.repo = new Repo((await this.ctx.storage.get<State>("state")) ?? emptyState());
    return this.repo;
  }

  async fetch(req: Request): Promise<Response> {
    const repo = await this.load();
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
    const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    try {
      const out = this.route(repo, req.method, parts, url, body);
      if (req.method !== "GET") await this.ctx.storage.put("state", repo.s);
      return json(out);
    } catch (e) {
      if (e instanceof WeaveError) return json({ error: e.message }, e.status);
      throw e;
    }
  }

  private route(repo: Repo, method: string, p: string[], url: URL, b: any): unknown {
    const [a, id, c] = p;
    if (method === "GET" && a === "state")
      return { rev: repo.s.rev, files: Object.fromEntries(repo.listFiles().map((f) => [f, repo.head(f)])), commits: repo.s.commits.slice(-50), sessions: Object.values(repo.s.sessions), events: repo.s.events.slice(-100), reviewPaths: repo.s.reviewPaths };
    if (method === "GET" && a === "scenario") return { steps: SCENARIO };
    if (method === "POST" && a === "reset") {
      this.repo = new Repo();
      this.repo.seed(SEED, "initial import");
      this.repo.setReviewPaths(["src/auth"]);
      return { ok: true };
    }
    if (method === "POST" && a === "sessions" && !id) return repo.open(b);
    if (a === "sessions" && id) {
      if (method === "GET" && c === "file") return { path: url.searchParams.get("path"), content: repo.read(id, url.searchParams.get("path")!) };
      if (method === "GET") return repo.session(id);
      if (method === "POST" && c === "file") return (repo.write(id, b.path, b.content), { ok: true });
      if (method === "POST" && c === "intent") return { warnings: repo.declare(id, b.paths ?? []) };
      if (method === "POST" && c === "submit") return repo.submit(id, b.message);
      if (method === "POST" && c === "resolve") return repo.resolve(id, b.path, b.choices ?? b.how);
      if (method === "POST" && c === "review") return repo.review(id, b.reviewer ?? "reviewer", !!b.approve, b.note);
      if (method === "POST" && c === "abandon") return (repo.abandon(id), { ok: true });
    }
    throw new WeaveError(`no route: ${method} /${p.join("/")}`, 404);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      const name = url.searchParams.get("repo") ?? "default";
      return env.REPO.get(env.REPO.idFromName(name)).fetch(req);
    }
    return new Response(DASHBOARD, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};
