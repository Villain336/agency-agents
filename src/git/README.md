# Weave as a Git remote (`src/git/`)

Self-contained smart-HTTP Git server and mirror for Weave. Runtime code uses no Node APIs and no `crypto.subtle`, so it runs in Cloudflare Workers.

```ts
import { handleGitRequest, mirrorPush, type GitHost } from "./git/index.ts";
// GitHost: { repo, authenticate(req) -> {agent} | null, persist() }
await handleGitRequest(req, host, "/git");   // GET /git/info/refs, POST /git/git-upload-pack, POST /git/git-receive-pack
await mirrorPush(repo, "https://github.com/o/r.git", token, fromRev); // -> { pushedRev }
```

Unauthenticated requests get `401` + `WWW-Authenticate: Basic` (username = agent, password = token; `authenticate()` gets the raw Request).

## Design

- **Objects** (`objects.ts`): each Weave commit rev maps to one git commit. Tree = all live files at that rev (nested trees, git sort order, mode 100644). Author/committer and message are byte-identical to `src/export.ts`, so the ids equal what `git fast-import` of the export produces. Ids are cached per `State`.
- **Primitives**: sync SHA-1 (`sha1.ts`), zlib with stored blocks for output and a full inflate (fixed + dynamic Huffman, reports consumed length) for input (`zlib.ts`), delta apply (`delta.ts`), pkt-lines (`pkt.ts`), pack build/parse incl. ofs/ref deltas and thin packs (`pack.ts`).
- **Refs**: `HEAD` -> `refs/heads/main` (trunk head) and `refs/weave/sessions/<id>` for each open session (active/conflicted/needs_verify/in_review). A session ref is a synthetic commit: its tree is the base rev's tree plus the session overlay, its parent is the base commit.
- **upload-pack** (`upload.ts`): protocol v2 (`ls-refs`, `fetch`; always answers `ready` + side-banded packfile) with v0/v1 fallback (no multi_ack: ACK on first common have, or on `done`). Objects reachable from recognised `have`s are excluded, otherwise the full reachable set is sent. gzip request bodies are supported.
- **receive-pack** (`receive.ts`): parses the pack (checksum, inflate, deltas, thin bases from the server's own objects), then
  - `refs/weave/sessions/<id>`: create or replace that session's overlay (edits = files whose blob differs from the base tree). Deleting the ref abandons the session. Only the session's owner may replace/delete it.
  - `refs/heads/main`: opens a session `git-<agent>-<n>`, writes the edits, calls `repo.submit()`. Landed -> `ok`. Conflicted / needs_verify / in_review -> `ng refs/heads/main <reason incl. paths>` and the session stays open as `refs/weave/sessions/<id>`.
  - Base revision: the Weave rev of the pushed commit's first parent, found by walking first parents through the pushed commits; else the current head. The session's `baseRev` is set to it, so stale clones are merged with Weave's 3-way merge. git refuses non-fast-forward pushes client-side, so divergent pushes need `--force` (the server ignores the old-sha).
  - `host.persist()` runs after any mutation.
- **mirrorPush** (`mirror.ts`): reads the remote `refs/heads/main` from `info/refs?service=git-receive-pack`, requires it to equal the commit of `fromRev` (or be empty when `fromRev` is 0), then POSTs a pack with the new commits and the trees/blobs not reachable from the old tip. Basic auth `x-access-token:<token>`. Throws on any rejection.

## Limits

- Text only: blobs must be UTF-8; binary, symlinks and submodules are rejected on push. `100755` is accepted but stored as plain text (mode is lost, so the next fetch shows 100644).
- A pushed multi-commit branch is squashed into one Weave commit (one session) whose message is the tip commit's message. After landing, the server's commit id differs from the pushed one, so clients must `fetch` and reset/rebase onto `origin/main`.
- History is linear (Weave revs). Only `refs/heads/main` and `refs/weave/sessions/*` can be pushed; no tags, no other branches, no shallow/filter/partial clone, no push-options or atomic push.
- Replacing a session ref needs `git push --force` (the advertised tip is a synthetic commit the client does not have).
- Packs are not compressed (stored deflate blocks) and fetches send the full object set minus recognised haves. Fine for modest repos; not tuned for large ones. SHA-1 is pure JS and is recomputed for trees on each rev build (cached afterwards per `State`).
- Pushes run to completion synchronously and are not size-limited beyond the platform's request body limit.
