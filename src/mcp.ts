// MCP (Model Context Protocol) server over Streamable HTTP, as a thin adapter over the Weave API.
// Any MCP-capable agent (Claude Code, Cursor, custom) can then use Weave as a native tool:
//   claude mcp add --transport http weave https://<your-worker>/mcp --header "Authorization: Bearer <token>"

export type Dispatch = (method: "GET" | "POST", path: string, body?: unknown) => Promise<{ status: number; json: unknown }>;

interface Tool {
  name: string;
  description: string;
  properties: Record<string, { type: string; description?: string; items?: { type: string } }>;
  required?: string[];
  call: (a: any) => { method: "GET" | "POST"; path: string; body?: unknown };
}

const q = (o: Record<string, unknown>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return p.length ? "?" + p.join("&") : "";
};
const S = (id: string) => `sessions/${encodeURIComponent(id)}`;
const session = { type: "string", description: "session id returned by weave_open_session" };

export const TOOLS: Tool[] = [
  { name: "weave_status", description: "Overview: trunk revision, files, live sessions (who is working on what), required checks and review policy. Call this first.", properties: {}, call: () => ({ method: "GET", path: "status" }) },
  { name: "weave_open_session", description: "Start a session (Weave's replacement for a branch). Declare the paths you intend to change; you get warnings if other agents are working on the same paths.", properties: { goal: { type: "string", description: "one line: what this change is for" }, intent: { type: "array", items: { type: "string" }, description: "paths you plan to touch" }, id: { type: "string" }, model: { type: "string" }, taskNumber: { type: "number", description: "work on this task: the session claims it, and landing completes it" }, baseRev: { type: "number", description: "pin the session to the trunk revision you already read (use the `rev` returned by weave_read_file without a session); default is current trunk" } }, required: ["goal"], call: (a) => ({ method: "POST", path: "sessions", body: a }) },
  { name: "weave_list_files", description: "List files on trunk.", properties: { rev: { type: "number" } }, call: (a) => ({ method: "GET", path: "trunk/files" + q({ rev: a.rev }) }) },
  { name: "weave_read_file", description: "Read a file. With `session`, you see your own edits layered over the trunk revision your session is based on (this is the safe way to read before editing). Without it you read current trunk and get its `rev`: if you then edit, open your session with baseRev=rev or pass basedOn=rev to weave_write_file, otherwise you can silently revert other agents' work.", properties: { path: { type: "string" }, session }, required: ["path"], call: (a) => (a.session ? { method: "GET", path: `${S(a.session)}/file` + q({ path: a.path }) } : { method: "GET", path: "trunk/file" + q({ path: a.path }) }) },
  { name: "weave_write_file", description: "Write the full new content of a file in your session.", properties: { session, path: { type: "string" }, content: { type: "string" }, basedOn: { type: "number", description: "trunk revision you derived this content from; the write is rejected if the file changed since, instead of silently reverting that change" } }, required: ["session", "path", "content"], call: (a) => ({ method: "POST", path: `${S(a.session)}/file`, body: { path: a.path, content: a.content, basedOn: a.basedOn } }) },
  { name: "weave_delete_file", description: "Delete a file in your session.", properties: { session, path: { type: "string" } }, required: ["session", "path"], call: (a) => ({ method: "POST", path: `${S(a.session)}/file`, body: { path: a.path, content: null } }) },
  { name: "weave_declare_intent", description: "Tell other agents which additional paths you will touch; returns overlap warnings.", properties: { session, paths: { type: "array", items: { type: "string" } } }, required: ["session", "paths"], call: (a) => ({ method: "POST", path: `${S(a.session)}/intent`, body: { paths: a.paths } }) },
  { name: "weave_preview", description: "Dry-run landing: the merged result against current trunk, conflicts, and interactions with concurrent work. Use this to test the exact merged code before submitting.", properties: { session }, required: ["session"], call: (a) => ({ method: "GET", path: `${S(a.session)}/preview` }) },
  { name: "weave_submit", description: "Land your session on trunk. Returns one of: landed; conflicted (resolve with weave_resolve_conflict, then submit again); needs_verify (a verifier must attest); verifying (required checks are running, it lands automatically when they pass); in_review (waiting for a reviewer); active (checks failed: read the evidence, fix, resubmit).", properties: { session, message: { type: "string" } }, required: ["session"], call: (a) => ({ method: "POST", path: `${S(a.session)}/submit`, body: { message: a.message } }) },
  { name: "weave_session", description: "Current state of a session: status, conflicts (with base/ours/theirs), risk, check evidence, approvals.", properties: { session }, required: ["session"], call: (a) => ({ method: "GET", path: S(a.session) }) },
  { name: "weave_resolve_conflict", description: "Resolve a conflicted path. `how` is ours (trunk), theirs (yours) or both; or pass `choices` (one per conflict: 'ours' | 'theirs' | 'both' | {text}) for custom merges. Then call weave_submit again.", properties: { session, path: { type: "string" }, how: { type: "string" }, choices: { type: "array", items: { type: "object" } }, content: { type: "string", description: "the final merged file (simplest: read both sides from weave_session, merge, pass the whole file)" }, basedOn: { type: "number", description: "with content: the trunk revision you derived it from (the rev returned when you read trunk); lets Weave merge anything that landed since instead of conflicting again" } }, required: ["session", "path"], call: (a) => ({ method: "POST", path: `${S(a.session)}/resolve`, body: { path: a.path, how: a.how, choices: a.choices, content: a.content, basedOn: a.basedOn } }) },
  { name: "weave_rerun_checks", description: "Run required checks again for your current edits (e.g. after an infrastructure flake).", properties: { session }, required: ["session"], call: (a) => ({ method: "POST", path: `${S(a.session)}/rerun` }) },
  { name: "weave_abandon", description: "Give up on a session.", properties: { session }, required: ["session"], call: (a) => ({ method: "POST", path: `${S(a.session)}/abandon` }) },
  { name: "weave_review_queue", description: "Reviewers: pending changes ranked by risk, limited by the attention budget.", properties: {}, call: () => ({ method: "GET", path: "review/queue" }) },
  { name: "weave_review_pack", description: "Reviewers: goal, risk score and reasons, per-file diffs, check evidence, previews and comments for one session.", properties: { session }, required: ["session"], call: (a) => ({ method: "GET", path: `${S(a.session)}/review-pack` }) },
  { name: "weave_review", description: "Reviewers: approve or reject a change that is in_review. You cannot review your own change; high-risk changes need a human approval.", properties: { session, approve: { type: "boolean" }, note: { type: "string" } }, required: ["session", "approve"], call: (a) => ({ method: "POST", path: `${S(a.session)}/review`, body: { approve: a.approve, note: a.note } }) },
  { name: "weave_verify", description: "Verifiers: attest (passed=true) that the merged result of a needs_verify change is sound, or send it back.", properties: { session, passed: { type: "boolean" }, note: { type: "string" } }, required: ["session", "passed"], call: (a) => ({ method: "POST", path: `${S(a.session)}/verify`, body: { passed: a.passed, note: a.note } }) },
  { name: "weave_comment", description: "Comment on a line of a session's change, optionally with a suggested replacement (`suggestion`) and/or marked blocking.", properties: { session, path: { type: "string" }, line: { type: "number" }, body: { type: "string" }, suggestion: { type: "string" }, blocking: { type: "boolean" }, parent: { type: "string", description: "reply to this comment id" } }, required: ["session", "path", "line"], call: (a) => ({ method: "POST", path: `${S(a.session)}/comments`, body: { path: a.path, line: a.line, body: a.body, suggestion: a.suggestion, blocking: a.blocking, parent: a.parent } }) },
  { name: "weave_apply_suggestion", description: "Apply a reviewer's suggested change to your session.", properties: { session, comment: { type: "string" } }, required: ["session", "comment"], call: (a) => ({ method: "POST", path: `${S(a.session)}/comments/${encodeURIComponent(a.comment)}/apply` }) },
  { name: "weave_resolve_comment", description: "Mark a comment thread resolved.", properties: { session, comment: { type: "string" } }, required: ["session", "comment"], call: (a) => ({ method: "POST", path: `${S(a.session)}/comments/${encodeURIComponent(a.comment)}/resolve` }) },
  { name: "weave_next_task", description: "Pick the best task to work on: unclaimed, unblocked, highest priority. Open a session with its taskNumber to claim it.", properties: { labels: { type: "string", description: "comma-separated; only tasks with one of these labels" } }, call: (a) => ({ method: "GET", path: "tasks/next" + q({ labels: a.labels }) }) },
  { name: "weave_list_tasks", description: "List tasks (issues), newest first.", properties: { status: { type: "string", description: "open | claimed | done | closed" }, label: { type: "string" }, q: { type: "string" } }, call: (a) => ({ method: "GET", path: "tasks" + q({ status: a.status, label: a.label, q: a.q }) }) },
  { name: "weave_create_task", description: "File a task. Use @name to mention someone; dependsOn lists task numbers that must finish first.", properties: { title: { type: "string" }, body: { type: "string" }, labels: { type: "array", items: { type: "string" } }, priority: { type: "string", description: "low | normal | high | urgent" }, dependsOn: { type: "array", items: { type: "number" } } }, required: ["title"], call: (a) => ({ method: "POST", path: "tasks", body: a }) },
  { name: "weave_claim_task", description: "Claim a task with a lease (default 15 minutes). Renew with weave_task_heartbeat; an expired lease frees the task for others.", properties: { number: { type: "number" }, leaseSec: { type: "number" } }, required: ["number"], call: (a) => ({ method: "POST", path: `tasks/${a.number}/claim`, body: { leaseSec: a.leaseSec } }) },
  { name: "weave_task_heartbeat", description: "Renew your claim lease on a task.", properties: { number: { type: "number" }, leaseSec: { type: "number" } }, required: ["number"], call: (a) => ({ method: "POST", path: `tasks/${a.number}/heartbeat`, body: { leaseSec: a.leaseSec } }) },
  { name: "weave_release_task", description: "Give a claimed task back.", properties: { number: { type: "number" } }, required: ["number"], call: (a) => ({ method: "POST", path: `tasks/${a.number}/release` }) },
  { name: "weave_comment_task", description: "Comment on a task (supports @mentions).", properties: { number: { type: "number" }, body: { type: "string" } }, required: ["number", "body"], call: (a) => ({ method: "POST", path: `tasks/${a.number}/comment`, body: { body: a.body } }) },
  { name: "weave_close_task", description: "Close a task without landing anything.", properties: { number: { type: "number" } }, required: ["number"], call: (a) => ({ method: "POST", path: `tasks/${a.number}/close` }) },
  { name: "weave_notifications", description: "Your notifications: mentions, assignments, review requests, landings, conflicts.", properties: { unread: { type: "boolean" } }, call: (a) => ({ method: "GET", path: "notifications" + (a.unread ? "?unread=1" : "") }) },
  { name: "weave_claim_review", description: "Claim a change awaiting review so other reviewers do not duplicate the work.", properties: { session, leaseSec: { type: "number" } }, required: ["session"], call: (a) => ({ method: "POST", path: `${S(a.session)}/claim-review`, body: { leaseSec: a.leaseSec } }) },
  { name: "weave_list_runs", description: "Workflow runs (post-merge automation: builds, deploys, releases) and their status/output.", properties: { workflow: { type: "string" }, status: { type: "string" } }, call: (a) => ({ method: "GET", path: "runs" + q({ workflow: a.workflow, status: a.status }) }) },
  { name: "weave_run_workflow", description: "Trigger a workflow that allows manual runs.", properties: { name: { type: "string" } }, required: ["name"], call: (a) => ({ method: "POST", path: `workflows/${encodeURIComponent(a.name)}/run` }) },
  { name: "weave_list_packages", description: "Packages published to this repository's registry.", properties: {}, call: () => ({ method: "GET", path: "packages" }) },
  { name: "weave_get_package", description: "A package with its versions, files, sizes and sha256.", properties: { name: { type: "string" }, version: { type: "string" } }, required: ["name"], call: (a) => ({ method: "GET", path: `packages/${encodeURIComponent(a.name)}` + (a.version ? `/${encodeURIComponent(a.version)}` : "") }) },
  { name: "weave_teams", description: "Teams (used as code owners via `team:<name>`).", properties: {}, call: () => ({ method: "GET", path: "teams" }) },
  { name: "weave_history", description: "Recent landed commits on trunk with risk tier and whether they were auto-merged.", properties: { limit: { type: "number" } }, call: (a) => ({ method: "GET", path: "commits" + q({ limit: a.limit }) }) },
  { name: "weave_provenance", description: "Signed provenance record for a landed revision: which agent/model, risk, evidence, approvals.", properties: { rev: { type: "number" } }, required: ["rev"], call: (a) => ({ method: "GET", path: `provenance/${a.rev}` }) },
];

export const INSTRUCTIONS =
  "Weave lets many agents change one codebase at the same time without branches. Workflow: weave_status -> weave_open_session (declare intent) -> read files THROUGH THE SESSION (not trunk) -> write -> weave_preview -> weave_submit. " +
  "Handle the submit status: conflicted -> weave_resolve_conflict then submit again; verifying -> checks are running and it lands automatically, poll weave_session; needs_verify / in_review -> a different identity must verify or review; active after failed checks -> read evidence, fix, resubmit. " +
  "Never expect to review or verify your own change.";

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_TEXT = 60_000;

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: any };

const err = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** Handle one JSON-RPC message. Returns null for notifications (HTTP 202, no body). */
export async function handleRpc(msg: Rpc, dispatch: Dispatch): Promise<unknown | null> {
  if (msg.method === undefined) return null; // a response from the client; we never send requests
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case "initialize": {
      const want = msg.params?.protocolVersion;
      return { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: VERSIONS.includes(want) ? want : VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "weave", version: "0.2.0" }, instructions: INSTRUCTIONS } };
    }
    case "ping":
      return { jsonrpc: "2.0", id: msg.id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: "object", properties: t.properties, required: t.required ?? [] } })) } };
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return err(msg.id, -32602, `unknown tool: ${msg.params?.name}`);
      const args = msg.params?.arguments ?? {};
      for (const k of tool.required ?? []) if (args[k] === undefined) return { jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: `missing required argument: ${k}` }] } };
      const c = tool.call(args);
      const { status, json } = await dispatch(c.method, c.path, c.body);
      let text = JSON.stringify(json, null, 2);
      if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + `\n…[truncated ${text.length - MAX_TEXT} chars]`;
      return { jsonrpc: "2.0", id: msg.id, result: { isError: status >= 400, content: [{ type: "text", text }] } };
    }
    default:
      if (isNotification || msg.method.startsWith("notifications/")) return null;
      return err(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

export async function handleMcpRequest(req: Request, dispatch: Dispatch): Promise<Response> {
  if (req.method !== "POST") return new Response("MCP endpoint: POST JSON-RPC messages here", { status: 405, headers: { allow: "POST" } });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(err(null, -32700, "parse error"), { status: 400 });
  }
  const batch = Array.isArray(body);
  const out = (await Promise.all((batch ? (body as Rpc[]) : [body as Rpc]).map((m) => handleRpc(m, dispatch)))).filter((x) => x !== null);
  if (!out.length) return new Response(null, { status: 202 });
  return Response.json(batch ? out : out[0]);
}
