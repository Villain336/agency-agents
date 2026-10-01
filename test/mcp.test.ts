import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMcpRequest, handleRpc, TOOLS, type Dispatch } from "../src/mcp.ts";
import { Repo, openActorFor } from "./mcp-helpers.ts";

const post = (body: unknown) => new Request("http://x/mcp", { method: "POST", body: JSON.stringify(body) });

test("initialize negotiates version and advertises tools", async () => {
  const r: any = await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, async () => ({ status: 200, json: {} }));
  assert.equal(r.result.protocolVersion, "2025-03-26");
  assert.ok(r.result.capabilities.tools);
  assert.match(r.result.instructions, /weave_open_session/);
  const old: any = await handleRpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }, async () => ({ status: 200, json: {} }));
  assert.equal(old.result.protocolVersion, "2025-06-18");
});

test("tools/list exposes every tool with a valid JSON schema", async () => {
  const r: any = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, async () => ({ status: 200, json: {} }));
  assert.equal(r.result.tools.length, TOOLS.length);
  for (const t of r.result.tools) {
    assert.match(t.name, /^weave_[a-z_]+$/);
    assert.equal(t.inputSchema.type, "object");
    for (const k of t.inputSchema.required) assert.ok(k in t.inputSchema.properties, `${t.name}.${k}`);
  }
});

test("notifications get 202, unknown methods error, parse errors are 400", async () => {
  const d: Dispatch = async () => ({ status: 200, json: {} });
  assert.equal((await handleMcpRequest(post({ jsonrpc: "2.0", method: "notifications/initialized" }), d)).status, 202);
  const bad: any = await (await handleMcpRequest(post({ jsonrpc: "2.0", id: 3, method: "nope" }), d)).json();
  assert.equal(bad.error.code, -32601);
  assert.equal((await handleMcpRequest(new Request("http://x/mcp", { method: "POST", body: "{" }), d)).status, 400);
  assert.equal((await handleMcpRequest(new Request("http://x/mcp", { method: "GET" }), d)).status, 405);
});

test("tool calls map to API requests; errors surface as isError", async () => {
  const seen: any[] = [];
  const d: Dispatch = async (method, path, body) => (seen.push({ method, path, body }), path.startsWith("sessions/s1/submit") ? { status: 409, json: { error: "nope" } } : { status: 200, json: { ok: true } });
  const call = (name: string, args: any) => handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, d) as Promise<any>;
  await call("weave_read_file", { path: "a b.ts" });
  await call("weave_read_file", { path: "a.ts", session: "s1" });
  await call("weave_write_file", { session: "s1", path: "a.ts", content: "x" });
  const bad = await call("weave_submit", { session: "s1" });
  assert.deepEqual(seen.map((s) => s.path), ["trunk/file?path=a%20b.ts", "sessions/s1/file?path=a.ts", "sessions/s1/file", "sessions/s1/submit"]);
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /nope/);
  const missing = await call("weave_write_file", { session: "s1" });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /path/);
});

test("end to end through the real router: an agent lands a change via MCP tools", async () => {
  const repo = new Repo();
  repo.seed({ "a.ts": "1\n2\n3" });
  const actor = openActorFor("mcp-agent");
  const d: Dispatch = async (method, path, body) => {
    const url = new URL("http://x/api/" + path);
    try {
      const { route } = await import("../src/api.ts");
      return { status: 200, json: route({ repo, actor, method, parts: url.pathname.split("/").filter(Boolean).slice(1), url, body: body ?? {} }) };
    } catch (e: any) {
      return { status: e.status ?? 500, json: { error: e.message } };
    }
  };
  const call = async (name: string, args: any) => JSON.parse(((await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, d)) as any).result.content[0].text);
  const { session } = await call("weave_open_session", { goal: "edit", intent: ["a.ts"], id: "m1" });
  await call("weave_write_file", { session: session.id, path: "a.ts", content: "1\nTWO\n3" });
  assert.equal((await call("weave_preview", { session: "m1" })).files["a.ts"], "1\nTWO\n3");
  assert.equal((await call("weave_submit", { session: "m1" })).status, "landed");
  assert.equal((await call("weave_read_file", { path: "a.ts" })).content, "1\nTWO\n3");
  assert.equal((await call("weave_history", {}))[0].message, "edit");
});
