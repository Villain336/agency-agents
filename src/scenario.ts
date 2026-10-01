// A scripted multi-agent scenario, replayed by both the dashboard and scripts/demo.ts.
export const SEED: Record<string, string> = {
  "README.md": "# Shop API\n\nA tiny storefront backend.\n\n## Endpoints\n- GET /items\n- POST /cart",
  "src/items.ts": "export function listItems() {\n  const sql = 'SELECT * FROM items';\n  return db.query(sql);\n}\n\nexport function getItem(id: string) {\n  return db.query('SELECT * FROM items WHERE id = ' + id);\n}\n",
  "src/cart.ts": "export function addToCart(userId: string, itemId: string) {\n  const cart = carts.get(userId) ?? [];\n  cart.push(itemId);\n  carts.set(userId, cart);\n}\n",
  "src/auth.ts": "export function login(user: string, pass: string) {\n  return pass === 'hunter2';\n}\n",
};

export type Step =
  | { op: "open"; id: string; agent: string; goal: string; intent?: string[] }
  | { op: "write"; id: string; path: string; content: string }
  | { op: "submit"; id: string; message?: string }
  | { op: "resolve"; id: string; path: string; how: "ours" | "theirs" | "both" }
  | { op: "verify"; id: string; verifier: string; passed: boolean }
  | { op: "review"; id: string; reviewer: string; approve: boolean }
  | { op: "note"; text: string };

const items = SEED["src/items.ts"];
export const SCENARIO: Step[] = [
  { op: "note", text: "Five agents start work at the same time, all on the same trunk." },
  { op: "open", id: "sec", agent: "SecurityBot", goal: "Fix SQL injection in items", intent: ["src/items.ts"] },
  { op: "open", id: "perf", agent: "PerfBot", goal: "Add caching to items", intent: ["src/items.ts"] },
  { op: "open", id: "docs", agent: "DocsBot", goal: "Document the cart endpoint", intent: ["README.md"] },
  { op: "open", id: "feat", agent: "FeatureBot", goal: "Add removeFromCart", intent: ["src/cart.ts"] },
  { op: "open", id: "auth", agent: "AuthBot", goal: "Hash passwords at login", intent: ["src/auth.ts"] },
  { op: "open", id: "page", agent: "PageBot", goal: "Add limit param to listItems", intent: ["src/items.ts"] },
  { op: "open", id: "late", agent: "LintBot", goal: "Tidy getItem query", intent: ["src/items.ts"] },
  { op: "write", id: "sec", path: "src/items.ts", content: items.replace("'SELECT * FROM items WHERE id = ' + id", "'SELECT * FROM items WHERE id = ?', [id]") },
  { op: "write", id: "perf", path: "src/items.ts", content: items.replace("return db.query(sql);", "return cache.get(sql) ?? db.query(sql);") + "\nconst cache = new Map();\n" },
  { op: "write", id: "docs", path: "README.md", content: SEED["README.md"] + "\n  Body: { userId, itemId }\n" },
  { op: "write", id: "feat", path: "src/cart.ts", content: SEED["src/cart.ts"] + "\nexport function removeFromCart(userId: string, itemId: string) {\n  carts.set(userId, (carts.get(userId) ?? []).filter((i) => i !== itemId));\n}\n" },
  { op: "write", id: "auth", path: "src/auth.ts", content: "export function login(user: string, pass: string) {\n  return hash(pass) === users.get(user)?.hash;\n}\n" },
  { op: "write", id: "page", path: "src/items.ts", content: items.replace("export function listItems() {", "export function listItems(limit = 50) {") },
  { op: "write", id: "late", path: "src/items.ts", content: items.replace("'SELECT * FROM items WHERE id = ' + id", "`SELECT * FROM items WHERE id = ${id}`") },
  { op: "note", text: "DocsBot and FeatureBot land instantly. No branches, no PR queue." },
  { op: "submit", id: "docs" },
  { op: "submit", id: "feat" },
  { op: "note", text: "SecurityBot lands. PerfBot edited a different part of the same file: auto-merged." },
  { op: "submit", id: "sec" },
  { op: "submit", id: "perf" },
  { op: "note", text: "PageBot changed listItems' signature; PerfBot changed its body. The text merges cleanly, but Weave sees both touched one function and holds it for a verifier." },
  { op: "submit", id: "page" },
  { op: "verify", id: "page", verifier: "TestBot", passed: true },
  { op: "note", text: "AuthBot touched a protected path, so it waits for a reviewer agent." },
  { op: "submit", id: "auth" },
  { op: "review", id: "auth", reviewer: "ReviewBot", approve: true },
  { op: "note", text: "LintBot has been sitting on an old snapshot and edited the line SecurityBot fixed: a real conflict, handed back as data." },
  { op: "submit", id: "late" },
  { op: "resolve", id: "late", path: "src/items.ts", how: "ours" },
  { op: "submit", id: "late", message: "Tidy getItem query (kept the parameterized version)" },
];

