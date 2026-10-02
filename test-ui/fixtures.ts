// Realistic fixtures for the UI mock server: a small TypeScript service with ~25 files and ~40 commits by
// a mix of agents, built by replaying edit operations so history, blame and diffs are all consistent.

export type Op =
  | { add: string; content: string }
  | { edit: string; from: string; to: string }
  | { append: string; text: string }
  | { del: string }
  | { map: string; fn: (c: string) => string };

export interface CommitSpec {
  agent: string;
  message: string;
  ops: Op[];
  risk?: "low" | "medium" | "high";
  merged?: boolean;
  model?: string;
  goal?: string;
  ageHours: number; // how long ago it landed
}

const F = "```";
export const LONG_NAME = "src/handlers/internationalization-and-localization-formatting-helpers-for-extremely-long-names.ts";

const catalog = (n: number) =>
  `// Generated message catalog. Do not edit by hand.\nexport const CATALOG: Record<string, string> = {\n${Array.from({ length: n }, (_, i) => `  "msg.${String(i).padStart(3, "0")}": "Message number ${i} for the catalog",`).join("\n")}\n};\n\nexport const t = (key: string): string => CATALOG[key] ?? key;\n`;

export const BASE: Record<string, string> = {
  "README.md": `# Orbit API

A tiny order-tracking service that runs on Cloudflare Workers. Built and maintained mostly by agents through [Weave](https://example.com/weave).

## Quick start

${F}sh
npm install
npm test
npm run dev
${F}

## Layout

| Path | What lives there |
|---|---|
| \`src/index.ts\` | Worker entry and router wiring |
| \`src/auth/\` | Sessions and tokens (**protected**: needs review) |
| \`src/handlers/\` | One file per resource |
| \`docs/\` | Guide and API reference |

> Tip: run \`scripts/seed.py\` to load demo data.

- Fast: no framework, ~4 KB of runtime
- Typed: strict TypeScript everywhere
- Tested: every handler has a test

See the [guide](docs/guide.md) for more, or open an issue.
`,
  "package.json": `{\n  "name": "orbit-api",\n  "version": "0.0.1",\n  "type": "module",\n  "scripts": {\n    "dev": "wrangler dev",\n    "test": "node --test",\n    "lint": "eslint src"\n  },\n  "dependencies": {},\n  "devDependencies": {\n    "typescript": "^5.6.0",\n    "wrangler": "^4.0.0"\n  }\n}\n`,
  "tsconfig.json": `{\n  "compilerOptions": {\n    "target": "ES2022",\n    "module": "ES2022",\n    "strict": true,\n    "noEmit": true\n  },\n  "include": ["src", "test"]\n}\n`,
  "src/index.ts": `import { route } from "./router.ts";\nimport { health } from "./handlers/health.ts";\n\nexport interface Env {\n  DB: D1Database;\n  SESSION_SECRET: string;\n}\n\nexport default {\n  async fetch(req: Request, env: Env): Promise<Response> {\n    const url = new URL(req.url);\n    if (url.pathname === "/health") return health();\n    return route(req, env);\n  },\n};\n`,
  "src/router.ts": `import type { Env } from "./index.ts";\nimport { listUsers, getUser } from "./handlers/users.ts";\nimport { listOrders, createOrder } from "./handlers/orders.ts";\n\ntype Handler = (req: Request, env: Env, params: Record<string, string>) => Promise<Response>;\n\nconst routes: [string, RegExp, Handler][] = [\n  ["GET", /^\\/users$/, listUsers],\n  ["GET", /^\\/users\\/(?<id>\\w+)$/, getUser],\n  ["GET", /^\\/orders$/, listOrders],\n  ["POST", /^\\/orders$/, createOrder],\n];\n\nexport async function route(req: Request, env: Env): Promise<Response> {\n  const url = new URL(req.url);\n  for (const [method, re, fn] of routes) {\n    const m = re.exec(url.pathname);\n    if (m && req.method === method) return fn(req, env, m.groups ?? {});\n  }\n  return new Response("not found", { status: 404 });\n}\n`,
  "src/auth/session.ts": `import { sign, verify } from "./tokens.ts";\n\nexport interface Session {\n  userId: string;\n  expiresAt: number;\n}\n\nconst TTL_MS = 15 * 60 * 1000;\n\nexport function issue(userId: string, secret: string, now = Date.now()): string {\n  const s: Session = { userId, expiresAt: now + TTL_MS };\n  return sign(JSON.stringify(s), secret);\n}\n\nexport function read(token: string, secret: string, now = Date.now()): Session | null {\n  const raw = verify(token, secret);\n  if (!raw) return null;\n  const s = JSON.parse(raw) as Session;\n  return s.expiresAt > now ? s : null;\n}\n\nexport function refresh(token: string, secret: string, now = Date.now()): string | null {\n  const s = read(token, secret, now);\n  return s ? issue(s.userId, secret, now) : null;\n}\n`,
  "src/auth/tokens.ts": `import { createHmac, timingSafeEqual } from "node:crypto";\n\nconst b64 = (s: string) => Buffer.from(s).toString("base64url");\n\nexport function sign(payload: string, secret: string): string {\n  const body = b64(payload);\n  const mac = createHmac("sha256", secret).update(body).digest("base64url");\n  return \`\${body}.\${mac}\`;\n}\n\nexport function verify(token: string, secret: string): string | null {\n  const [body, mac] = token.split(".");\n  if (!body || !mac) return null;\n  const expect = createHmac("sha256", secret).update(body).digest("base64url");\n  const a = Buffer.from(mac);\n  const b = Buffer.from(expect);\n  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;\n  return Buffer.from(body, "base64url").toString();\n}\n`,
  "src/db/schema.sql": `CREATE TABLE users (\n  id TEXT PRIMARY KEY,\n  email TEXT NOT NULL UNIQUE,\n  name TEXT NOT NULL,\n  created_at INTEGER NOT NULL\n);\n\nCREATE TABLE orders (\n  id TEXT PRIMARY KEY,\n  user_id TEXT NOT NULL REFERENCES users(id),\n  total_cents INTEGER NOT NULL,\n  status TEXT NOT NULL DEFAULT 'pending',\n  created_at INTEGER NOT NULL\n);\n\nCREATE INDEX orders_by_user ON orders(user_id, created_at);\n`,
  "src/db/client.ts": `export interface Row { [k: string]: unknown }\n\nexport async function query<T extends Row>(db: D1Database, sql: string, ...args: unknown[]): Promise<T[]> {\n  const res = await db.prepare(sql).bind(...args).all<T>();\n  return res.results ?? [];\n}\n\nexport async function one<T extends Row>(db: D1Database, sql: string, ...args: unknown[]): Promise<T | null> {\n  const rows = await query<T>(db, sql, ...args);\n  return rows[0] ?? null;\n}\n`,
  "src/util/format.ts": `export function money(cents: number, currency = "USD"): string {\n  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);\n}\n\nexport function pad(n: number, width = 2): string {\n  return String(n).padStart(width, "0");\n}\n\nexport function truncate(s: string, max = 80): string {\n  return s.length <= max ? s : s.slice(0, max - 1) + "\\u2026";\n}\n`,
  "src/util/time.ts": `export const now = () => Date.now();\n\nexport function isoDay(ts: number): string {\n  return new Date(ts).toISOString().slice(0, 10);\n}\n\nexport function ago(ts: number, at = now()): string {\n  const s = Math.max(0, Math.round((at - ts) / 1000));\n  if (s < 60) return \`\${s}s ago\`;\n  if (s < 3600) return \`\${Math.round(s / 60)}m ago\`;\n  return \`\${Math.round(s / 3600)}h ago\`;\n}\n`,
  "src/handlers/health.ts": `export function health(): Response {\n  return Response.json({ ok: true, ts: Date.now() });\n}\n`,
  "src/handlers/users.ts": `import type { Env } from "../index.ts";\nimport { one, query } from "../db/client.ts";\n\nexport async function listUsers(_req: Request, env: Env): Promise<Response> {\n  const rows = await query(env.DB, "SELECT id, email, name FROM users ORDER BY created_at DESC LIMIT 50");\n  return Response.json(rows);\n}\n\nexport async function getUser(_req: Request, env: Env, p: Record<string, string>): Promise<Response> {\n  const u = await one(env.DB, "SELECT id, email, name FROM users WHERE id = ?", p.id);\n  return u ? Response.json(u) : new Response("no such user", { status: 404 });\n}\n`,
  "src/handlers/orders.ts": `import type { Env } from "../index.ts";\nimport { query } from "../db/client.ts";\nimport { money } from "../util/format.ts";\n\nexport async function listOrders(_req: Request, env: Env): Promise<Response> {\n  const rows = await query<{ id: string; total_cents: number }>(env.DB, "SELECT id, total_cents FROM orders ORDER BY created_at DESC LIMIT 50");\n  return Response.json(rows.map((r) => ({ ...r, total: money(r.total_cents) })));\n}\n\nexport async function createOrder(req: Request, env: Env): Promise<Response> {\n  const { userId, totalCents } = (await req.json()) as { userId: string; totalCents: number };\n  const id = crypto.randomUUID();\n  await env.DB.prepare("INSERT INTO orders (id, user_id, total_cents, created_at) VALUES (?, ?, ?, ?)").bind(id, userId, totalCents, Date.now()).run();\n  return Response.json({ id }, { status: 201 });\n}\n`,
  [LONG_NAME]: `// Locale-aware formatting helpers. The file name is deliberately long to exercise the UI.\nexport function formatList(items: string[], locale = "en"): string {\n  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items);\n}\n\nexport function formatRelative(days: number, locale = "en"): string {\n  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(days, "day");\n}\n`,
  "src/i18n/catalog.ts": catalog(320),
  "test/router.test.ts": `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { route } from "../src/router.ts";\n\ntest("unknown routes are 404", async () => {\n  const res = await route(new Request("http://x/nope"), {} as never);\n  assert.equal(res.status, 404);\n});\n`,
  "test/format.test.ts": `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { money, pad, truncate } from "../src/util/format.ts";\n\ntest("money", () => assert.equal(money(1999), "$19.99"));\ntest("pad", () => assert.equal(pad(7), "07"));\ntest("truncate", () => assert.equal(truncate("abcdef", 4), "abc\\u2026"));\n`,
  "scripts/seed.py": `#!/usr/bin/env python3\n"""Load demo users and orders into a local D1 database."""\nimport json\nimport random\nimport sys\n\nNAMES = ["ada", "grace", "linus", "margaret", "dennis"]\n\n\ndef make_users(n: int) -> list[dict]:\n    return [{"id": f"u{i}", "email": f"{random.choice(NAMES)}{i}@example.test", "name": f"User {i}"} for i in range(n)]\n\n\nif __name__ == "__main__":\n    count = int(sys.argv[1]) if len(sys.argv) > 1 else 10\n    print(json.dumps(make_users(count), indent=2))  # pipe into wrangler d1 execute\n`,
  "scripts/deploy.sh": `#!/usr/bin/env bash\nset -euo pipefail\n\nENVIRONMENT="\${1:-staging}"\necho "Deploying to $ENVIRONMENT"\n\nif [ "$ENVIRONMENT" = "production" ]; then\n  npm test\nfi\n\nnpx wrangler deploy --env "$ENVIRONMENT"\n`,
  "docs/guide.md": `# Guide\n\n## Authentication\n\nRequests carry a signed session token. Tokens live for **15 minutes** and are refreshed with \`refresh()\`.\n\n## Orders\n\nPOST \`/orders\` with \`{ "userId": "u1", "totalCents": 1999 }\`.\n\n1. Validate the user\n2. Insert the order\n3. Return \`201\` with the new id\n`,
  "docs/api.md": `# API reference\n\n| Method | Path | Description |\n|---|---|---|\n| GET | /health | liveness |\n| GET | /users | list users |\n| GET | /users/:id | one user |\n| GET | /orders | list orders |\n| POST | /orders | create an order |\n`,
  "public/style.css": `:root {\n  --bg: #0d1017;\n  --fg: #e6e9f0;\n}\n\nbody {\n  margin: 0;\n  background: var(--bg);\n  color: var(--fg);\n  font: 14px/1.5 system-ui, sans-serif;\n}\n\n.card {\n  border: 1px solid #272f3f;\n  border-radius: 8px;\n  padding: 12px;\n}\n`,
  "public/index.html": `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>Orbit</title>\n  <link rel="stylesheet" href="/style.css">\n</head>\n<body>\n  <h1 class="title">Orbit</h1>\n  <script src="/app.js"></script>\n</body>\n</html>\n`,
  "public/app.js": `const status = document.querySelector("#status");\n\nasync function load() {\n  const res = await fetch("/orders");\n  const orders = await res.json();\n  if (status) status.textContent = \`\${orders.length} orders\`;\n  return orders;\n}\n\nload().catch(console.error);\n`,
  ".github/workflows/ci.yml": `name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: npm test\n`,
};


export const COMMITS: CommitSpec[] = [
  { agent: "maria", message: "Initial import", ops: [], ageHours: 24 * 21, risk: "low" },
  { agent: "refactor-bot", message: "Extract query helper into db/client", ageHours: 24 * 20, ops: [{ edit: "src/db/client.ts", from: "export interface Row", to: "/** Thin typed wrappers over D1. */\nexport interface Row" }] },
  { agent: "docs-agent", message: "Document the session token lifetime", ageHours: 24 * 19.5, ops: [{ append: "docs/guide.md", text: "\n## Errors\n\nAll errors are JSON: `{ \"error\": \"...\" }`.\n" }] },
  { agent: "test-writer", message: "Add format helper tests", ageHours: 24 * 19, ops: [{ append: "test/format.test.ts", text: 'test("money zero", () => assert.equal(money(0), "$0.00"));\n' }] },
  { agent: "claude-fixer", message: "Fix off-by-one in truncate", model: "claude-sonnet-5", ageHours: 24 * 18, ops: [{ edit: "src/util/format.ts", from: "s.slice(0, max - 1)", to: "s.slice(0, Math.max(0, max - 1))" }] },
  { agent: "perf-agent", message: "Cache Intl.NumberFormat instances in money()", ageHours: 24 * 17, ops: [{ edit: "src/util/format.ts", from: 'export function money(cents: number, currency = "USD"): string {\n  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);\n}', to: 'const formatters = new Map<string, Intl.NumberFormat>();\n\nexport function money(cents: number, currency = "USD"): string {\n  let f = formatters.get(currency);\n  if (!f) formatters.set(currency, (f = new Intl.NumberFormat("en-US", { style: "currency", currency })));\n  return f.format(cents / 100);\n}' }] },
  { agent: "refactor-bot", message: "Add ago() relative time helper", ageHours: 24 * 16, ops: [{ append: "src/util/time.ts", text: "\nexport const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));\n" }] },
  { agent: "docs-agent", message: "Add API reference table for orders", ageHours: 24 * 15, ops: [{ edit: "docs/api.md", from: "| POST | /orders | create an order |", to: "| POST | /orders | create an order |\n| DELETE | /orders/:id | cancel an order (planned) |" }] },
  { agent: "security-reviewer", message: "Use constant-time comparison for token MACs", model: "claude-opus-4", risk: "medium", ageHours: 24 * 14, ops: [{ edit: "src/auth/tokens.ts", from: "if (a.length !== b.length || !timingSafeEqual(a, b)) return null;", to: "if (a.length !== b.length || !timingSafeEqual(a, b)) return null; // constant time" }] },
  { agent: "maria", message: "Tag v0.1.0: first deployable version", ageHours: 24 * 13.5, ops: [{ edit: "package.json", from: '"version": "0.0.1"', to: '"version": "0.1.0"' }] },
  { agent: "claude-fixer", message: "Handle missing groups in router regex match", model: "claude-sonnet-5", ageHours: 24 * 13, ops: [{ edit: "src/router.ts", from: "m.groups ?? {}", to: "{ ...(m.groups ?? {}) }" }] },
  { agent: "test-writer", message: "Router: assert 404 body is text", ageHours: 24 * 12, ops: [{ append: "test/router.test.ts", text: '\ntest("404 body", async () => {\n  const res = await route(new Request("http://x/nope"), {} as never);\n  assert.equal(await res.text(), "not found");\n});\n' }] },
  { agent: "perf-agent", message: "Index orders by user and date", ageHours: 24 * 11.5, ops: [{ edit: "src/db/schema.sql", from: "CREATE INDEX orders_by_user ON orders(user_id, created_at);", to: "CREATE INDEX orders_by_user ON orders(user_id, created_at DESC);" }] },
  { agent: "refactor-bot", message: "Move health handler out of index", ageHours: 24 * 11, ops: [{ edit: "src/handlers/health.ts", from: "ts: Date.now()", to: "ts: Date.now(), version: 1" }] },
  { agent: "docs-agent", message: "README: add layout table", ageHours: 24 * 10, ops: [{ edit: "README.md", from: "## Layout", to: "## Layout\n\nThe layout is intentionally boring." }] },
  { agent: "maria", message: "Add deploy script", ageHours: 24 * 9.5, ops: [{ edit: "scripts/deploy.sh", from: 'ENVIRONMENT="${1:-staging}"', to: 'ENVIRONMENT="${1:-staging}" # staging | production' }] },
  { agent: "claude-fixer", message: "Return 404 JSON for unknown users", model: "claude-sonnet-5", ageHours: 24 * 9, ops: [{ edit: "src/handlers/users.ts", from: 'new Response("no such user", { status: 404 })', to: 'Response.json({ error: "no such user" }, { status: 404 })' }] },
  { agent: "test-writer", message: "Add seed script smoke test notes", ageHours: 24 * 8.5, ops: [{ append: "scripts/seed.py", text: "\n# TODO: add --orders flag\n" }] },
  { agent: "refactor-bot", message: "Generate message catalog for i18n", ageHours: 24 * 8, ops: [{ edit: "src/i18n/catalog.ts", from: "Do not edit by hand.", to: "Do not edit by hand: regenerate with `npm run i18n`." }] },
  { agent: "perf-agent", message: "Batch order inserts", ageHours: 24 * 7.5, merged: true, risk: "medium", ops: [{ edit: "src/handlers/orders.ts", from: "  const id = crypto.randomUUID();", to: "  const id = crypto.randomUUID(); // one insert per request" }] },
  { agent: "docs-agent", message: "Guide: describe order creation steps", ageHours: 24 * 7, ops: [{ append: "docs/guide.md", text: "\n## Rate limits\n\nNone yet. Be kind.\n" }] },
  { agent: "claude-fixer", message: "Reject expired tokens in refresh()", model: "claude-sonnet-5", risk: "medium", ageHours: 24 * 6.5, ops: [{ edit: "src/auth/session.ts", from: "return s ? issue(s.userId, secret, now) : null;", to: "if (!s) return null; // expired or tampered\n  return issue(s.userId, secret, now);" }] },
  { agent: "maria", message: "Tag v0.2.0", ageHours: 24 * 6, ops: [{ edit: "package.json", from: '"version": "0.1.0"', to: '"version": "0.2.0"' }] },
  { agent: "refactor-bot", message: "Rename pad() width parameter", ageHours: 24 * 5.5, ops: [{ edit: "src/util/format.ts", from: "export function pad(n: number, width = 2): string {\n  return String(n).padStart(width, \"0\");", to: "export function pad(n: number, digits = 2): string {\n  return String(n).padStart(digits, \"0\");" }] },
  { agent: "test-writer", message: "Cover truncate edge cases", ageHours: 24 * 5, ops: [{ append: "test/format.test.ts", text: 'test("truncate short", () => assert.equal(truncate("ab", 10), "ab"));\n' }] },
  { agent: "perf-agent", message: "Avoid JSON.parse when token is malformed", ageHours: 24 * 4.5, ops: [{ edit: "src/auth/session.ts", from: "  const s = JSON.parse(raw) as Session;\n  return s.expiresAt > now ? s : null;", to: "  try {\n    const s = JSON.parse(raw) as Session;\n    return s.expiresAt > now ? s : null;\n  } catch {\n    return null;\n  }" }] },
  { agent: "docs-agent", message: "Style: add title spacing", ageHours: 24 * 4, ops: [{ append: "public/style.css", text: "\n.title {\n  letter-spacing: .02em;\n}\n" }] },
  { agent: "claude-fixer", message: "Add locale helper module", model: "claude-sonnet-5", ageHours: 24 * 3.5, ops: [{ add: "src/handlers/i18n-locale.ts", content: 'export const SUPPORTED = ["en", "de", "ja"] as const;\n\nexport function pick(accept: string | null): (typeof SUPPORTED)[number] {\n  const first = (accept ?? "en").split(",")[0].trim().slice(0, 2);\n  return (SUPPORTED as readonly string[]).includes(first) ? (first as (typeof SUPPORTED)[number]) : "en";\n}\n' }] },
  { agent: "refactor-bot", message: "Rewrite catalog wording (bulk edit)", ageHours: 24 * 3, merged: true, ops: [{ map: "src/i18n/catalog.ts", fn: (c) => c.replace(/Message number (\d+) for the catalog/g, (m, n) => (Number(n) % 3 === 0 ? `Message ${n} (revised)` : m)) }] },
  { agent: "security-reviewer", message: "Require SESSION_SECRET to be at least 32 chars", model: "claude-opus-4", risk: "high", ageHours: 24 * 2.6, ops: [{ edit: "src/index.ts", from: "    const url = new URL(req.url);", to: "    if (env.SESSION_SECRET.length < 32) return new Response(\"misconfigured\", { status: 500 });\n    const url = new URL(req.url);" }] },
  { agent: "maria", message: "Tag v0.3.0-rc1", ageHours: 24 * 2.4, ops: [{ edit: "package.json", from: '"version": "0.2.0"', to: '"version": "0.3.0-rc1"' }] },
  { agent: "test-writer", message: "Test session refresh", ageHours: 24 * 2.2, ops: [{ add: "test/session.test.ts", content: 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { issue, read, refresh } from "../src/auth/session.ts";\n\nconst secret = "x".repeat(32);\n\ntest("issue then read", () => {\n  const t = issue("u1", secret, 1000);\n  assert.equal(read(t, secret, 2000)?.userId, "u1");\n});\n\ntest("expired", () => {\n  const t = issue("u1", secret, 0);\n  assert.equal(read(t, secret, 20 * 60 * 1000), null);\n});\n\ntest("refresh extends", () => {\n  const t = issue("u1", secret, 0);\n  assert.ok(refresh(t, secret, 60_000));\n});\n' }] },
  { agent: "perf-agent", message: "Memoize ago() formatter", ageHours: 24 * 2, ops: [{ edit: "src/util/time.ts", from: "export const now = () => Date.now();", to: "export const now = (): number => Date.now();" }] },
  { agent: "docs-agent", message: "Guide: note about refresh()", ageHours: 24 * 1.6, ops: [{ edit: "docs/guide.md", from: "refreshed with `refresh()`.", to: "refreshed with `refresh()`; an expired token cannot be refreshed." }] },
  { agent: "refactor-bot", message: "Dedupe money() import in orders handler", ageHours: 24 * 1.3, ops: [{ edit: "src/handlers/orders.ts", from: 'import { money } from "../util/format.ts";', to: 'import { money } from "../util/format.ts"; // single import' }] },
  { agent: "claude-fixer", message: "Fix list endpoint ordering for equal timestamps", model: "claude-sonnet-5", ageHours: 24 * 1, ops: [{ edit: "src/handlers/users.ts", from: "ORDER BY created_at DESC LIMIT 50", to: "ORDER BY created_at DESC, id LIMIT 50" }] },
  { agent: "test-writer", message: "Add CI workflow notes", ageHours: 18, ops: [{ append: ".github/workflows/ci.yml", text: "      - run: npm run lint\n" }] },
  { agent: "perf-agent", message: "Switch app.js to textContent counters", ageHours: 9, ops: [{ edit: "public/app.js", from: "load().catch(console.error);", to: "load().catch((e) => console.error(\"load failed\", e));" }] },
  { agent: "docs-agent", message: "README: mention seed script", ageHours: 3, ops: [{ edit: "README.md", from: "> Tip: run `scripts/seed.py` to load demo data.", to: "> Tip: run `python3 scripts/seed.py 25` to load demo data." }] },
];

/** Replay a list of ops on top of a file map, returning the new content for every touched path (null = deleted). */
export function applyOps(files: Map<string, string>, ops: Op[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const get = (p: string) => (p in out ? out[p] : files.get(p) ?? null);
  for (const op of ops) {
    if ("add" in op) out[op.add] = op.content;
    else if ("del" in op) out[op.del] = null;
    else if ("append" in op) out[op.append] = (get(op.append) ?? "") + op.text;
    else if ("map" in op) out[op.map] = op.fn(get(op.map) ?? "");
    else {
      const cur = get(op.edit);
      if (cur === null || !cur.includes(op.from)) throw new Error(`fixture edit does not match in ${op.edit}: ${op.from.slice(0, 50)}`);
      out[op.edit] = cur.replace(op.from, () => op.to);
    }
  }
  return out;
}


// ---- forge features: teams, code owners, workflows, runs, packages -------------------------------
export const FORGE_TEAMS = [
  { name: "core", members: ["maria", "security-reviewer"], description: "Maintainers of the auth and API surface" },
  { name: "platform", members: ["maria", "ci-runner", "refactor-bot"], description: "Database client, CI and deploy tooling" },
  { name: "docs", members: ["docs-agent"], description: "" },
];

export const FORGE_CONFIG = {
  owners: [
    { pattern: "src/auth/", owners: ["team:core"] },
    { pattern: "src/db/", owners: ["team:platform", "claude-fixer"] },
    { pattern: "public/", owners: ["team:core", "maria"] },
  ],
  workflows: [
    { name: "deploy-preview", on: ["landed"], command: "npm run build && npx wrangler deploy --env preview", paths: ["src/", "public/"], secrets: ["DEPLOY_TOKEN"] },
    { name: "release-publish", on: ["tag", "manual"], command: "npm publish --provenance", secrets: ["NPM_TOKEN"] },
    { name: "nightly-audit", on: ["manual"], command: "npm audit --omit=dev && node scripts/license-check.js" },
  ],
};

export interface RunSpec { id: string; workflow: string; trigger: "landed" | "tag" | "manual"; rev: number; ref?: string; by: string; status: "queued" | "running" | "passed" | "failed"; ageMin: number; durationMs?: number; output?: string; claimedBy?: string }
export const FORGE_RUNS: RunSpec[] = [
  { id: "w1", workflow: "deploy-preview", trigger: "landed", rev: 27, by: "claude-fixer", status: "passed", ageMin: 60 * 30, durationMs: 41200, claimedBy: "ci-runner", output: "> orbit@1.4.0 build\n> tsc -p .\n\nbuilt 42 files in 3.1s\n\nUploaded orbit-preview (2.31 sec)\nPublished orbit-preview (0.42 sec)\n  https://preview.orbit.example.test\n" },
  { id: "w2", workflow: "nightly-audit", trigger: "manual", rev: 28, by: "maria", status: "passed", ageMin: 60 * 20, durationMs: 9800, claimedBy: "ci-runner", output: "found 0 vulnerabilities\nlicense-check: 118 packages, all MIT/ISC/Apache-2.0\n" },
  { id: "w3", workflow: "deploy-preview", trigger: "landed", rev: 29, by: "refactor-bot", status: "failed", ageMin: 60 * 9, durationMs: 18300, claimedBy: "ci-runner", output: "> orbit@1.4.0 build\n> tsc -p .\n\nsrc/handlers/orders.ts(41,17): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.\n\nBuild failed with 1 error.\nnpm ERR! code 2\n" },
  { id: "w4", workflow: "release-publish", trigger: "tag", rev: 30, ref: "v1.4.0", by: "maria", status: "passed", ageMin: 60 * 5, durationMs: 22500, claimedBy: "ci-runner", output: "npm notice package: @orbit/client@1.4.0\nnpm notice total files: 7\n+ @orbit/client@1.4.0\n" },
  { id: "w5", workflow: "deploy-preview", trigger: "landed", rev: 30, by: "docs-agent", status: "running", ageMin: 2, claimedBy: "ci-runner" },
  { id: "w6", workflow: "nightly-audit", trigger: "manual", rev: 30, by: "maria", status: "queued", ageMin: 1 },
];

const clientFiles = (v: string) => [
  { name: "package.json", content: JSON.stringify({ name: "@orbit/client", version: v, type: "module", main: "index.js" }, null, 2) },
  { name: "index.js", content: "export class OrbitClient {\n  constructor(base, token) { this.base = base; this.token = token; }\n  async orders(limit = 20) {\n    const r = await fetch(`${this.base}/orders?limit=${limit}`, { headers: { authorization: `Bearer ${this.token}` } });\n    if (!r.ok) throw new Error(`orbit: ${r.status}`);\n    return r.json();\n  }\n}\n".repeat(12) },
  { name: "index.d.ts", content: "export declare class OrbitClient {\n  constructor(base: string, token: string);\n  orders(limit?: number): Promise<unknown[]>;\n}\n" },
  { name: "README.md", content: "# @orbit/client\n\nTyped client for the Orbit orders API.\n" },
  { name: "dist/internationalization-and-localization-formatting-helpers/bundle.min.js", content: "(()=>{})();".repeat(300) },
];
export const FORGE_PACKAGES: { name: string; version: string; description: string; publishedBy: string; ageD: number; yanked?: string; files: { name: string; content: string; scale?: number }[] }[] = [
  { name: "@orbit/client", version: "1.0.0", description: "Typed client for the Orbit orders API", publishedBy: "maria", ageD: 40, files: clientFiles("1.0.0") },
  { name: "@orbit/client", version: "1.1.0", description: "Typed client for the Orbit orders API", publishedBy: "maria", ageD: 21, yanked: "ships a debug logger that prints bearer tokens", files: clientFiles("1.1.0") },
  { name: "@orbit/client", version: "1.2.0", description: "Typed client for the Orbit orders API", publishedBy: "claude-fixer", ageD: 9, files: clientFiles("1.2.0") },
  { name: "@orbit/client", version: "1.3.0-rc.1", description: "Typed client for the Orbit orders API", publishedBy: "claude-fixer", ageD: 3, files: clientFiles("1.3.0-rc.1") },
  { name: "orbit-cli", version: "0.4.2", description: "Command line for managing Orbit orders", publishedBy: "ci-runner", ageD: 6, files: [{ name: "orbit.sh", content: "#!/bin/sh\ncurl -fsS \"$ORBIT_URL/orders\"\n" }, { name: "package.json", content: "{\"name\":\"orbit-cli\",\"version\":\"0.4.2\"}" }] },
  { name: "legacy-sdk", version: "0.1.0", description: "Deprecated first-generation SDK", publishedBy: "maria", ageD: 90, yanked: "superseded by @orbit/client", files: [{ name: "sdk.js", content: "module.exports = {};\n" }] },
];
