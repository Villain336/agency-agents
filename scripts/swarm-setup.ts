// Seeds a Weave instance for a larger live swarm: N developer identities, reviewers, runners, and a
// small utility library whose exports line and test file every agent must touch.
//   node scripts/swarm-setup.ts <url> <admin-token> <tokens.json> [agents=16] [repo=swarm]
import { writeFileSync } from "node:fs";
import { Weave } from "../sdk/ts/weave.ts";

const [url = "http://localhost:8788", adminToken = "test-admin-token", out = "swarm-tokens.json", n = "16", repo = "swarm"] = process.argv.slice(2);
const admin = new Weave({ url, token: adminToken, repo });
const dev = ["ada", "ben", "cai", "dev", "eli", "fay", "gus", "hui", "ivy", "jon", "kim", "leo", "mia", "ned", "oli", "pia", "quin", "rae", "sam", "tia"].slice(0, Number(n));
const tokens: Record<string, string> = {};
for (const name of dev) tokens[name] = (await admin.createIdentity({ name, kind: "agent" })).token;
for (const name of ["rev1", "rev2"]) tokens[name] = (await admin.createIdentity({ name, kind: "reviewer" })).token;
for (const name of ["runner1", "runner2", "runner3", "runner4"]) tokens[name] = (await admin.createIdentity({ name, kind: "runner" })).token;

await admin.request("POST", "import", {
  message: "initial utility library",
  files: {
    "lib.js": `'use strict';

// A tiny utility library. Each function is exported in the single exports object at the bottom.

function sum(xs) {
  return xs.reduce((a, b) => a + b, 0);
}

function last(xs) {
  return xs[xs.length - 1];
}

module.exports = { sum, last };
`,
    "lib.test.js": `const test = require('node:test');
const assert = require('node:assert');
const lib = require('./lib.js');

test('sum adds numbers', () => {
  assert.equal(lib.sum([1, 2, 3]), 6);
});

test('last returns the final element', () => {
  assert.equal(lib.last([1, 2, 3]), 3);
});
`,
    "README.md": "# lib\n\nA tiny utility library.\n\n## Functions\n\n- `sum(xs)`\n- `last(xs)`\n",
  },
});
await admin.configure({ checks: [{ name: "unit", command: "node --test", timeoutMs: 60000 }], reviewPaths: ["README.md"], policy: { evidence: "train" } });
writeFileSync(out, JSON.stringify({ url, repo, developers: dev, tokens }, null, 2));
console.log(`seeded ${dev.length} developers, 2 reviewers, 4 runners in repo "${repo}"; tokens in ${out}`);
