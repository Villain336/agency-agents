# Weave

**Many agents, one trunk, zero branches.** A Cloudflare-native collaboration layer built for the
"Build the Next GitHub" challenge: a way for multiple AI agents to change one codebase concurrently.

## Why Git's model breaks for agents

Branches, PRs and merge conflicts were designed for a few humans working for days. Agents work in
parallel, in minutes, in dozens. Branch-per-agent means a pile of stale branches, a serial PR queue,
and conflicts discovered late by whoever lands last.

## The model

| Git concept | Weave replacement |
|---|---|
| Branch / worktree | **Session**: a cheap overlay pinned to a trunk revision. Nothing to create, push, or clean up. |
| Surprise conflicts at merge time | **Intent declarations**: agents say which paths they plan to touch. Overlaps raise live warnings *before* any code is written. |
| Pull request + serial queue | **Atomic landing**: `submit` 3-way merges against trunk *as it is now*. Independent work lands instantly; concurrent edits to the same file auto-merge. |
| Conflict markers in files | **Structured conflicts**: returned as data (base / ours / theirs segments). The agent resolves with `ours`, `theirs`, `both`, or custom text, then re-submits. Other agents keep landing meanwhile. |
| "It merged cleanly but broke" | **Semantic gate**: if both sides changed the same function, or one changed a function that uses something the other changed, the clean merge is held as `needs_verify` until a verifier (test runner, reviewer agent) attests against the exact merged result. |
| CODEOWNERS + human review | **Protected paths** route to a reviewer agent. Approval re-merges against current trunk, so a stale diff never lands. |

Each repo is one **Durable Object**: a single-threaded, strongly consistent trunk with durable
storage, which is exactly the serialization point atomic landing needs. The Worker is the API and
dashboard, with no other infrastructure.

## Run it

```sh
npm install --legacy-peer-deps
npm test                 # merge engine + repo semantics
npm run dev              # http://localhost:8787 - click "Run multi-agent demo"
node scripts/demo.ts     # same scenario from the terminal (needs `npm run dev` running)
npm run deploy           # deploy to your Cloudflare account
```

Requires Node 22.18+ (scripts run TypeScript natively).

## API

All routes accept `?repo=<name>` (default `default`).

| Route | Purpose |
|---|---|
| `POST /api/sessions` `{id?, agent, goal, intent?}` | Open a session; returns overlap `warnings` |
| `GET /api/sessions/:id/file?path=` | Read a file as the session sees it |
| `POST /api/sessions/:id/file` `{path, content\|null}` | Write/delete a file in the overlay |
| `POST /api/sessions/:id/intent` `{paths}` | Declare intent, get overlap warnings |
| `POST /api/sessions/:id/submit` `{message?}` | Land: `landed`, `needs_verify` (+ risks), `in_review`, or `conflicted` (+ conflicts) |
| `POST /api/sessions/:id/resolve` `{path, how \| choices}` | Resolve a conflicted path |
| `GET /api/sessions/:id/preview` | Dry-run merge: files, conflicts, semantic risks |
| `POST /api/sessions/:id/verify` `{verifier, passed, note?}` | Attest (or reject) a `needs_verify` merge; lands on success |
| `POST /api/import` `{files, message?}` | Import a snapshot (`node scripts/import.ts` from a git checkout) |
| `POST /api/sessions/:id/review` `{reviewer, approve}` | Review a protected-path change |
| `GET /api/state` | Trunk, commits, sessions, event log |
| `GET /api/export` | Trunk history as a `git fast-import` stream (`curl .../api/export \| git fast-import`) |

## Layout

- `src/merge.ts`: dependency-free diff3 merge
- `src/repo.ts`: sessions, intent, landing, review (pure logic, fully unit-tested)
- `src/index.ts`: Worker + `RepoDO` Durable Object
- `src/semantic.ts`: symbol-level risk detection for clean merges
- `src/export.ts`: Weave history to real Git commits
- `src/dashboard.ts`: live dashboard
- `src/scenario.ts`: the scripted 6-agent demo

## Roadmap

Real parsers (tree-sitter) behind the semantic gate, Weave-run test execution, and a
WebSocket event stream in place of dashboard polling.

## License

MIT

See [docs/RESEARCH.md](docs/RESEARCH.md) for what Weave's design is based on.
