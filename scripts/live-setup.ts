// Seeds a Weave instance for a live multi-agent trial: identities, a small project with tests,
// required checks, and a protected path. Writes tokens to the given JSON file.
//   node scripts/live-setup.ts http://localhost:8788 admin-token /tmp/tokens.json
import { writeFileSync } from "node:fs";
import { Weave } from "../sdk/ts/weave.ts";

const [url = "http://localhost:8788", adminToken = "test-admin-token", out = "tokens.json"] = process.argv.slice(2);
const admin = new Weave({ url, token: adminToken, repo: "live" });

const tokens: Record<string, string> = {};
for (const [name, kind] of [["alice", "agent"], ["bruno", "agent"], ["chen", "agent"], ["dara", "agent"], ["rhea", "reviewer"], ["vik", "verifier"], ["runner1", "runner"]] as const)
  tokens[name] = (await admin.createIdentity({ name, kind })).token;

await admin.request("POST", "import", {
  message: "initial todo library",
  files: {
    "todo.js": `const todos = [];

function add(title) {
  const t = { id: todos.length + 1, title, done: false };
  todos.push(t);
  return t;
}

function complete(id) {
  const t = todos.find((x) => x.id === id);
  if (!t) throw new Error('no such todo: ' + id);
  t.done = true;
  return t;
}

function list() {
  return todos.slice();
}

function reset() {
  todos.length = 0;
}

module.exports = { add, complete, list, reset };
`,
    "todo.test.js": `const test = require('node:test');
const assert = require('node:assert');
const todo = require('./todo.js');

test.beforeEach(() => todo.reset());

test('add creates a todo', () => {
  const t = todo.add('write tests');
  assert.equal(t.title, 'write tests');
  assert.equal(t.done, false);
});

test('complete marks done', () => {
  const t = todo.add('x');
  assert.equal(todo.complete(t.id).done, true);
});
`,
    "README.md": "# todo\n\nA tiny todo library.\n",
  },
});
await admin.configure({ checks: [{ name: "unit", command: "node --test", timeoutMs: 60000 }], reviewPaths: ["README.md"] });
writeFileSync(out, JSON.stringify({ url, repo: "live", tokens }, null, 2));
console.log("seeded; tokens written to", out);
