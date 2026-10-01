// mirrorPush against a LOCAL bare repo served through `git http-backend` (CGI). No network, no real remotes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { GitView } from "../src/git/objects.ts";
import { mirrorPush } from "../src/git/index.ts";
import { git, land, newRepo, tmp } from "./git-helpers.ts";

const execPath = spawnSync("git", ["--exec-path"]).stdout.toString().trim();
const backend = join(execPath, "git-http-backend");
const haveBackend = existsSync(backend);

/** A fetch() stand-in that runs the CGI directly. */
function cgiFetch(root: string, seen: { auth: string[] }): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    seen.auth.push(headers.get("authorization") ?? "");
    const body = init?.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0);
    const method = init?.method ?? "GET";
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "", GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", HOME: root, GIT_CONFIG_NOSYSTEM: "1",
      REQUEST_METHOD: method, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: headers.get("content-type") ?? "", CONTENT_LENGTH: String(body.length), REMOTE_USER: "x-access-token", REMOTE_ADDR: "127.0.0.1",
    };
    const out = await new Promise<Buffer>((resolve, reject) => {
      const p = spawn(backend, [], { env });
      const chunks: Buffer[] = [];
      p.stdout.on("data", (d) => chunks.push(d));
      p.on("error", reject);
      p.on("close", () => resolve(Buffer.concat(chunks)));
      p.stdin.end(body);
    });
    const split = out.indexOf("\r\n\r\n");
    const head = out.subarray(0, split).toString();
    const status = /^Status: (\d+)/m.exec(head)?.[1] ?? "200";
    return new Response(out.subarray(split + 4), { status: Number(status) });
  };
}

test("mirrorPush publishes deterministic history to a plain git remote, incrementally", { skip: !haveBackend && "git http-backend not available" }, async () => {
  const root = tmp("mirror");
  const bare = join(root, "mirror");
  await git(root, "init", "--bare", "-b", "main", bare);
  await git(bare, "config", "http.receivepack", "true");
  const seen = { auth: [] as string[] };
  const f = cgiFetch(root, seen);

  const repo = newRepo();
  repo.seed({ "README.md": "# hi\n", "src/a.ts": "a\n", "src/deep/x/b.ts": "b\n" });
  land(repo, "alice", "second", { "src/a.ts": "a2\n" });
  land(repo, "bob", "third", { "src/deep/x/b.ts": null, "c.txt": "c\n" });

  const r1 = await mirrorPush(repo, "http://mirror.invalid/mirror", "SECRET", 0, f);
  assert.deepEqual(r1, { pushedRev: 3 });
  assert.equal(await git(bare, "rev-parse", "main"), new GitView(repo).mainSha());
  await git(bare, "fsck", "--strict", "--full");
  assert.equal(await git(bare, "rev-list", "--count", "main"), "3");
  assert.equal(await git(bare, "show", "main:c.txt"), "c");
  assert.ok(seen.auth.every((a) => a === "Basic " + Buffer.from("x-access-token:SECRET").toString("base64")));

  // nothing new: no network
  const n = seen.auth.length;
  assert.deepEqual(await mirrorPush(repo, "http://mirror.invalid/mirror", "SECRET", 3, f), { pushedRev: 3 });
  assert.equal(seen.auth.length, n);

  // incremental: only the new commits' objects are sent, history stays identical
  land(repo, "alice", "fourth", { "src/a.ts": "a3\n", "new/dir/f.txt": "f\n" });
  land(repo, "bob", "fifth", { "README.md": "# hi there\n" });
  const r2 = await mirrorPush(repo, "http://mirror.invalid/mirror/", "SECRET", 3, f);
  assert.deepEqual(r2, { pushedRev: 5 });
  assert.equal(await git(bare, "rev-parse", "main"), new GitView(repo).mainSha());
  await git(bare, "fsck", "--strict", "--full");
  assert.equal(await git(bare, "rev-list", "--count", "main"), "5");

  // wrong fromRev / diverged remote refuses to push
  land(repo, "bob", "sixth", { "z.txt": "z\n" });
  await assert.rejects(mirrorPush(repo, "http://mirror.invalid/mirror", "SECRET", 3, f), /remote .* is /);
  // and a plain clone of the mirror matches a clone of what Weave serves (same SHAs)
  assert.equal(await git(bare, "log", "-1", "--format=%an %ae", "main"), "bob bob@weave.agents");
});

test("mirrorPush surfaces remote errors", async () => {
  const repo = newRepo();
  repo.seed({ "a": "a\n" });
  const bad: typeof fetch = async () => new Response("nope", { status: 403 });
  await assert.rejects(mirrorPush(repo, "http://x.invalid/r", "t", 0, bad), /HTTP 403/);
});
