// Weave TypeScript client. Zero dependencies; works in Node 18+, Workers, Deno, Bun and browsers.
//
//   const weave = new Weave({ url: "https://weave.example.com", token: "wv_..." });
//   const s = await weave.open({ goal: "fix the bug", intent: ["src/a.ts"] });
//   await weave.write(s.id, "src/a.ts", newContent);
//   const result = await weave.submit(s.id);   // landed | conflicted | verifying | in_review | ...

export type Status = "active" | "conflicted" | "needs_verify" | "verifying" | "in_review" | "landed" | "rejected";

export interface SubmitResult {
  status: Status;
  rev?: number;
  conflicts?: { path: string; kind: string; segments: unknown[] }[];
  risks?: unknown[];
  risk?: { score: number; tier: "low" | "medium" | "high"; need: string; reasons: string[] };
  jobs?: string[];
  evidence?: unknown[];
}

export class WeaveError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface WeaveOptions {
  url: string;
  token?: string;
  repo?: string;
  fetch?: typeof fetch;
}

export class Weave {
  private o: WeaveOptions;
  constructor(o: WeaveOptions) {
    this.o = { repo: "default", ...o, url: o.url.replace(/\/$/, "") };
  }

  async request<T = any>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const sep = path.includes("?") ? "&" : "?";
    const f = this.o.fetch ?? fetch;
    const r = await f(`${this.o.url}/api/${path}${sep}repo=${encodeURIComponent(this.o.repo!)}`, {
      method,
      headers: { "content-type": "application/json", ...(this.o.token ? { authorization: `Bearer ${this.o.token}` } : {}) },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
    const text = await r.text();
    let json: any;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text }; }
    if (!r.ok) throw new WeaveError(json.error ?? `HTTP ${r.status}`, r.status);
    return json;
  }

  // trunk
  status = () => this.request("GET", "status");
  files = (rev?: number) => this.request<{ rev: number; files: string[] }>("GET", `trunk/files${rev ? `?rev=${rev}` : ""}`);
  readTrunk = async (path: string) => (await this.request("GET", `trunk/file?path=${encodeURIComponent(path)}`)).content as string | null;
  /** Read trunk and learn which revision you read; pass it as `baseRev` to open() or `basedOn` to write(). */
  readTrunkAt = async (path: string) => (await this.request("GET", `trunk/file?path=${encodeURIComponent(path)}`)) as { content: string | null; rev: number };
  history = (limit = 20) => this.request("GET", `commits?limit=${limit}`);
  provenance = (rev: number) => this.request("GET", `provenance/${rev}`);

  // sessions
  open = async (o: { goal: string; intent?: string[]; id?: string; model?: string; prompt?: string; agent?: string; baseRev?: number }) => (await this.request("POST", "sessions", o)).session as { id: string; status: Status; baseRev: number };
  read = async (id: string, path: string) => (await this.request("GET", `sessions/${id}/file?path=${encodeURIComponent(path)}`)).content as string | null;
  /** `basedOn`: the trunk revision you derived `content` from; stale edits are rejected instead of reverting others. */
  write = (id: string, path: string, content: string | null, basedOn?: number) => this.request("POST", `sessions/${id}/file`, { path, content, basedOn });
  declare = (id: string, paths: string[]) => this.request("POST", `sessions/${id}/intent`, { paths });
  preview = (id: string) => this.request("GET", `sessions/${id}/preview`);
  submit = (id: string, message?: string) => this.request<SubmitResult>("POST", `sessions/${id}/submit`, { message });
  session = (id: string) => this.request("GET", `sessions/${id}`);
  resolve = (id: string, path: string, how: "ours" | "theirs" | "both" | unknown[]) => this.request("POST", `sessions/${id}/resolve`, Array.isArray(how) ? { path, choices: how } : { path, how });
  rerunChecks = (id: string) => this.request<SubmitResult>("POST", `sessions/${id}/rerun`);
  abandon = (id: string) => this.request("POST", `sessions/${id}/abandon`);

  // review & verification
  reviewQueue = () => this.request("GET", "review/queue");
  reviewPack = (id: string) => this.request("GET", `sessions/${id}/review-pack`);
  review = (id: string, approve: boolean, note?: string) => this.request<SubmitResult>("POST", `sessions/${id}/review`, { approve, note });
  verify = (id: string, passed: boolean, note?: string) => this.request<SubmitResult>("POST", `sessions/${id}/verify`, { passed, note });
  comment = (id: string, c: { path: string; line: number; body?: string; suggestion?: string; blocking?: boolean; parent?: string }) => this.request("POST", `sessions/${id}/comments`, c);
  applySuggestion = (id: string, commentId: string) => this.request("POST", `sessions/${id}/comments/${commentId}/apply`);

  // admin
  createIdentity = (o: { name: string; kind: "agent" | "human" | "verifier" | "reviewer" | "runner" | "admin"; paths?: string[]; budget?: { sessionsPerHour?: number; landsPerHour?: number }; model?: string }) =>
    this.request<{ identity: { id: string }; token: string }>("POST", "identities", o);
  configure = (cfg: Record<string, unknown>) => this.request("POST", "config", cfg);

  /** Wait until a session reaches a terminal state (landed/rejected), resubmitting as checks complete. */
  async waitForLanding(id: string, timeoutMs = 120_000): Promise<Status> {
    const t0 = Date.now();
    for (;;) {
      const s = await this.session(id);
      if (s.status === "landed" || s.status === "rejected") return s.status;
      if (s.status === "conflicted" || s.status === "active") return s.status; // needs the agent
      if (Date.now() - t0 > timeoutMs) throw new WeaveError(`timed out waiting for ${id} (status ${s.status})`, 408);
      await new Promise((r) => setTimeout(r, 750));
    }
  }

  /** Stream audit events using long-polling. */
  async *events(after = 0, signal?: AbortSignal) {
    let last = after;
    while (!signal?.aborted) {
      const r = await this.request("GET", `events?after=${last}&wait=20`);
      for (const e of r.events) yield e;
      last = r.last;
    }
  }
}
