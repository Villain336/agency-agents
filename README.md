# Weave

**Many agents, one trunk, zero branches.** A Cloudflare-native collaboration platform where AI agents
change one codebase concurrently, built for the "Build the Next GitHub" challenge.

Git's model (branches, PRs, a serial merge queue, textual conflicts) was designed for a few humans
working for days. Weave is designed for many agents working for minutes.

## The model

| Git/GitHub | Weave |
|---|---|
| Branch / worktree | **Session**: a cheap overlay pinned to a trunk revision. Nothing to create, push or clean up. |
| Surprise conflicts at merge time | **Intent declarations**: agents say what they'll touch; overlaps warn *before* code is written. |
| PR + serial merge queue | **Atomic landing**: a 3-way merge against trunk *as it is now*. Independent work lands instantly; concurrent edits to one file auto-merge. |
| Conflict markers | **Structured conflicts**: base/ours/theirs as data; the agent resolves and resubmits while others keep landing. |
| Hot lines everyone edits (exports, index files, appended tests) | **Merge strategies**: single-line lists (exports, imports, arrays) merge item by item, and same-point inserts can be unioned for configured paths. Opt-in, counted in risk and provenance, never silent. |
| A stale edit that quietly deletes a teammate's work | **Revert detection**: a clean merge that would remove substantial code someone else recently landed is stopped and explained to the author; `allowRevert` confirms an intentional removal (then it needs review). Writes can declare `basedOn`. |
| "It merged cleanly but broke" | **Semantic gate**: if two changes touch the same function, or one changes something the other's function uses, landing waits for evidence on the *merged* result. |
| Required status checks | **Pull-based runners**: checks run against the exact merged result (optionally speculatively, queued behind earlier changes: `evidence: "train"`). Failures go back to the agent with the output. |
| CODEOWNERS + review everything | **Risk-tiered review**: low-risk changes land on evidence; medium needs a reviewer (agent or human); high needs a human. A review queue ranks by risk and respects a human attention budget. |
| Comments | Line comments, blocking threads, **suggested changes** the author applies with one call. |
| Who wrote this? | **Signed provenance** on every commit (identity, model, prompt *hash*, risk, evidence, approvals) in a hash chain; the audit log is hash-chained too. |
| Accounts, PATs | **Scoped identities**: kind (agent, human, reviewer, verifier, runner, admin), path scopes, hourly budgets; separation of duties (no self-review, no self-verify). |
| Clone / push | **Real Git remote**: `git clone`/`fetch`/`push` over smart HTTP (protocol v2 and v0). A push to `main` lands through Weave's merge; session refs are `refs/weave/sessions/*`. Optional mirror to GitHub. |
| Issues | **Tasks**: agent-native issues with priorities, dependencies, and **claim leases** (`next` picks the best unclaimed, unblocked task; an expired lease frees it). A session opened with `taskNumber` claims the task, and landing completes it. |
| Notifications, @mentions | Per-identity inbox: mentions, assignments, review requests, landings, conflicts. |
| Releases, tags | Immutable **tags** (also over git: `refs/tags/*`) and **releases** with notes. |
| Settings pages | **Config as code**: `weave.json` in the repo sets checks, review paths, policy and merge strategies; changes need a human, and webhooks/mirrors can never come from a file. |
| Duplicate review work | **Review claims**: a reviewer takes a change with a lease so others don't repeat it. |
| Repos, forks | **Registry** (`/api/repos`): create, list, and **fork** with full history copied (own keys, own identities). |
| Code browser, blame, search | **Browse API**: tree, blob, history, commit, diff, blame, search, readme, stats. |
| CODEOWNERS, teams | **Teams** and required code owners: rules from a `CODEOWNERS` file, `weave.json` or the config (last match wins, `team:<name>` expands to members); owned paths cannot land without an owner's approval, whatever the risk score. |
| GitHub Actions / Forgejo Actions | **Workflows**: post-merge runs (on landing, on tag, or manual) executed by the same pull-based runners, with path filters and **repository secrets** that only workflow runs (never agent-controlled check jobs) receive. |
| Package registry | **Packages**: immutable semver versions with files, sha256, yank, and semver-aware `latest` (generic registry, 1 MB per version; not npm/PyPI wire-compatible yet). |
| Webhooks, API, SDKs | Signed webhooks with retries, REST API, **MCP server**, TypeScript and Python SDKs, long-poll event stream. |

Each repo shard is one **Durable Object** (single-threaded, strongly consistent, SQLite storage;
large files offload to R2). Repos can be **sharded by path prefix** so unrelated areas land in parallel.

**Web UI** at `/` (served as static assets by the Worker): code browser with blame and search, history and commit pages with provenance, the change/review page with inline comments and suggestions, tasks (list and board), releases, notifications, repositories and settings. The earlier live swarm dashboard is at `/legacy`. `npm run ui:mock` runs the UI against a mock server; `npm run ui:shots` captures screenshots.

## Quick start

```sh
npm install --legacy-peer-deps
npm test                  # 130+ unit and integration tests (real `git` against the git bridge; differential fuzz vs `git merge-file`)
npm run dev               # http://localhost:8787, open dev mode (no auth); click "Run multi-agent demo"
npm run e2e               # boots the Worker with auth + R2, drives every feature end to end (needs python3, git)
```

### Production setup

```sh
npx wrangler secret put WEAVE_ADMIN_TOKEN     # enables auth; without it Weave runs in open dev mode
npx wrangler r2 bucket create weave-blobs     # optional, then add an r2_buckets binding named BLOBS
npx wrangler secret put MIRROR_TOKEN          # optional: token for pushing to a GitHub mirror
npm run deploy
```

Create identities (agents get their own token; tokens are shown once):

```sh
curl -X POST $URL/api/identities -H "Authorization: Bearer $ADMIN" \
  -d '{"name":"fixer-bot","kind":"agent","paths":["src/"],"model":"claude-…","budget":{"sessionsPerHour":60}}'
```

Configure policy, checks and protected paths:

```sh
curl -X POST $URL/api/config -H "Authorization: Bearer $ADMIN" -d '{
  "checks":[{"name":"unit","command":"npm test","timeoutMs":120000}],
  "reviewPaths":["src/auth","infra/"],
  "policy":{"autoLandBelow":30,"humanAbove":70,"attentionBudget":5,"evidence":"train"},
  "merge":{"lists":true,"union":["*.test.js","CHANGELOG.md"]},
  "webhooks":[{"url":"https://example.com/hook","secret":"…","events":["landed","conflict"]}],
  "mirror":{"url":"https://github.com/you/repo.git"}
}'
```

Run a check runner (inside a sandbox: it executes agent-written code; see Security):

```sh
node scripts/runner.ts --url $URL --token $RUNNER_TOKEN --name runner-1
```

## Using Weave

**From an MCP-capable agent** (Claude Code, Cursor, …):
`claude mcp add --transport http weave $URL/mcp --header "Authorization: Bearer $TOKEN"`.
Tools: `weave_status`, `weave_open_session`, `weave_read_file`, `weave_write_file`, `weave_preview`,
`weave_submit`, `weave_resolve_conflict`, `weave_review_pack`, `weave_review`, `weave_verify`,
`weave_comment`, `weave_history`, `weave_provenance`, and more.

**From the command line** (`scripts/wv.ts`, built for agents and humans): `open`, `cat [--session ID]`, `put`,
`preview`, `submit`, `session`, `resolve ID path file`, `wait`, `queue`, `pack`, `review`. It remembers which
trunk revision each `cat` read and sends it as `basedOn`, so resolutions merge with what landed since.

**From code:**

```ts
import { Weave } from "./sdk/ts/weave.ts";
const weave = new Weave({ url, token });
const s = await weave.open({ goal: "fix the bug", intent: ["src/a.ts"] });
await weave.write(s.id, "src/a.ts", fixed);
const r = await weave.submit(s.id);  // landed | verifying | conflicted | needs_verify | in_review | active
```

(Python: `sdk/python/weave.py`, standard library only.)

**From Git:** `git clone http://alice:$TOKEN@host/git/<repo>`; `git push origin HEAD:main` lands through
Weave. Divergent pushes need `--force` client-side (Weave merges them server-side). A push that needs
checks or review is *not* rejected: it stays open as `refs/weave/sessions/<id>` and lands when ready.

**Read through the session.** Open your session first and read via `GET /api/sessions/:id/file`.
If you read trunk directly, keep the `rev` it returns and pass it as `baseRev` when opening the
session (or `basedOn` on each write); Weave rejects edits derived from a stale read rather than
silently reverting other agents' work. See [docs/LIVE-TRIAL.md](docs/LIVE-TRIAL.md).

### What `submit` returns

| status | meaning | agent should |
|---|---|---|
| `landed` | on trunk | done |
| `verifying` | required checks are running | wait; it lands automatically |
| `conflicted` | real overlapping edits | `resolve` each path, submit again |
| `needs_verify` | merged cleanly but interacts with concurrent work | a different identity verifies |
| `in_review` | risk tier needs approval | a reviewer/human approves |
| `active` | checks failed (see `evidence`) | fix, resubmit |

## API

All routes accept `?repo=<name>` (default `default`) and `Authorization: Bearer <token>`.

| Route | Purpose |
|---|---|
| `GET /api/status` · `/api/trunk/files` · `/api/trunk/file?path=` · `/api/commits` | Read trunk |
| `POST /api/sessions` · `GET/POST /api/sessions/:id/{file,intent,preview,submit,resolve,rerun,abandon}` | Work |
| `GET /api/sessions/:id/review-pack` · `POST …/review` · `POST …/verify` | Review and verification |
| `GET/POST /api/sessions/:id/comments` · `POST …/comments/:c/{resolve,apply}` | Comments and suggestions |
| `GET /api/review/queue` | Ranked review queue within the attention budget |
| `GET /api/provenance[/:rev]` | Signed record for a revision; chain + audit verification |
| `POST /api/runner/claim` · `POST /api/runner/jobs/:id/result` | Runner protocol |
| `GET /api/events?after=&wait=` | Long-poll audit events |
| `POST /api/identities` · `POST /api/config` · `POST /api/import` · `GET /api/export` | Admin, import, `git fast-import` export |
| `GET /api/{tree,blob,history,diff,blame,search,readme,stats}` · `GET /api/commit/:rev` | Browse code |
| `/api/tasks[/next\|/:n/{claim,release,heartbeat,close,reopen,comment,assign,update}]` | Tasks (issues) |
| `GET /api/notifications` · `POST …/read` | Inbox |
| `GET/POST /api/tags` · `GET/POST /api/releases[/:tag]` | Tags and releases |
| `GET/POST /api/repos` (fork: `{name, from, rev?}`) · `POST /api/sessions/:id/claim-review` | Registry, forks, review claims |
| `/git/<repo>/…` · `/mcp` | Git smart HTTP · MCP (Streamable HTTP) |

## Security notes

- **Runners execute agent-written code.** Run them in a sandbox with no secrets and a restricted
  network. `scripts/runner.ts` scrubs the environment, enforces a timeout and a command allowlist, and
  refuses path traversal, but it is not a sandbox. Cloudflare Containers/Sandbox are the natural home.
- Without `WEAVE_ADMIN_TOKEN` the service is in **open dev mode**: no authentication at all.
- Provenance signatures are HMAC with a per-repo server key: they prove the record came from this
  server and is unmodified; the hash chain makes tampering evident. They are not publicly verifiable
  (asymmetric signatures are on the roadmap). Only a hash of the prompt is stored.
- Identities and tokens are per repository.

## Known limits (honest list)

- **Not tested against GitHub.** The mirror was verified against a local `git http-backend`, never a
  real GitHub remote. Try it on a scratch repo first.
- Sharded repos: a session lives on one shard (no cross-shard atomic landing); the git bridge, mirror
  and `export` serve the `main` shard only.
- The semantic gate is a regex-based heuristic (TS/JS/Go/Python declarations); it flags
  conservatively and cannot see runtime behavior. Tree-sitter would replace it.
- The Git bridge is text-only (no binaries, symlinks, submodules), linear history, no tags or other
  branches, full-pack fetches. See `src/git/README.md`.
- State is loaded into memory per Durable Object (large repos need lazy loading). Check runners are
  pull-based and bring-your-own; Weave does not provision preview environments (runners can report
  a preview URL).
- **Hot lines still serialize.** Sixteen agents all editing one line is the worst case for optimistic merging.
  List merging and union fix the common shapes (exports, imports, appended tests); other hot spots (one
  function everyone rewrites) still conflict, and agents re-apply their change. See docs/SWARM-RUN.md.
- Not yet: SSO/OIDC, Pages, hosted runners (bring your own; Cloudflare Containers is the natural home), npm/PyPI-compatible
  package protocols, package storage in R2 (packages live in Durable Object SQLite, 1 MB per version), a wiki beyond
  markdown files in the repo (see docs/ROADMAP.md). Forks copy history but there are no cross-repo pull requests yet; forked history keeps
  the upstream's provenance hashes, but signatures were made with the upstream's key.

## Layout

`src/repo.ts` core state machine · `src/merge.ts` diff3 · `src/semantic.ts` interaction detector ·
`src/review.ts` risk scoring · `src/store.ts` SQLite/R2 persistence · `src/api.ts` router ·
`src/forge-api.ts` tasks/inbox/tags routes · `src/browse.ts` code browser API · `src/registry.ts` repo index ·
`src/index.ts` Worker + Durable Object · `src/mcp.ts` MCP · `src/git/` Git bridge ·
`sdk/` clients · `scripts/` runner, demo, import · `test/` unit tests · `test-e2e/` live end-to-end ·
`docs/` BENCHMARK (simulation vs push-and-retry and a merge queue, with caveats), SWARM-RUN (16 real agents, three runs, what broke), LIVE-TRIAL, RESEARCH (design rationale).

MIT licensed.
