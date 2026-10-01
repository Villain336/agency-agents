# API contract for platform v2

Everything here is JSON under `/api`, takes `?repo=<name>` (default `default`) and `Authorization: Bearer <token>`.
Errors are `{ "error": "..." }` with a 4xx/5xx status. Existing endpoints (`/api/state`, `/api/status`,
`/api/sessions…`, `/api/review/queue`, `/api/provenance`, `/api/config`, `/api/identities`, `/api/events`) are unchanged.

## Browse (read-only; pure functions over repository state)

| Route | Response |
|---|---|
| `GET /api/tree?path=&rev=` | `{rev, path, entries:[{name, path, type:"file"\|"dir", size?, lastRev, lastAgent, lastMessage, lastTs}]}`, dirs first, then files, each sorted by name. `path` empty = root. |
| `GET /api/blob?path=&rev=` | `{path, rev, size, lines, content, language}`. `language` from the extension (`ts`, `js`, `py`, `md`, `json`, …, or `text`). |
| `GET /api/history?path=&limit=&before=` | `{commits:[{rev, agent, message, ts, merged, hash, risk, paths}], hasMore}`, newest first; with `path`, only commits that touched it (or a path under it); `before` = a rev, return commits older than it. |
| `GET /api/commit/:rev` | `{commit:{rev, agent, message, ts, merged, hash, risk, approvals, evidence}, files:[{path, status, added, removed, patch}]}`; the diff is against the previous revision. |
| `GET /api/diff?from=&to=&path=` | `{from, to, files:[{path, status, added, removed, patch}]}` between two revisions, optionally one path/dir. |
| `GET /api/blame?path=&rev=` | `{path, rev, lines:[{n, text, rev, agent, ts, message}]}`: for each line of the file at `rev`, the revision that introduced it. |
| `GET /api/search?q=&regex=&caseSensitive=&path=&limit=` | `{q, rev, total, truncated, results:[{path, line, text, matchStart, matchEnd}]}` over files at head; `path` is a glob filter. |
| `GET /api/readme` | `{path, rev, content}` for the root README (`README.md`, case-insensitive) or `{path:null}`. |
| `GET /api/stats` | `{files, loc, languages:{ext:fileCount}, commits, contributors:[{agent, commits, lastTs}], sessions:{live, landed}}`. |

## Tasks (issues, built for agents)

A task is `{id:"t12", number:12, title, body, labels:[], priority:"low"|"normal"|"high"|"urgent", status:"open"|"claimed"|"done"|"closed",
creator, assignee?, claim?:{by, since, leaseUntil}, sessions:[sessionId], comments:[{id, author, body, ts}], dependsOn:[number], createdAt, updatedAt, closedAt?}`.

| Route | Notes |
|---|---|
| `POST /api/tasks` `{title, body?, labels?, priority?, dependsOn?}` | write scope |
| `GET /api/tasks?status=&label=&assignee=&q=` | list, newest first |
| `GET /api/tasks/next?labels=` | the best open, unclaimed, unblocked task (priority, then age), or `{task:null}` |
| `GET /api/tasks/:number` | one task |
| `POST /api/tasks/:number/claim` `{leaseSec?}` | default lease 900 s; 409 if claimed by someone else and the lease is live; the same claimant renews |
| `POST /api/tasks/:number/{release,heartbeat,close,reopen,comment,assign,update}` | `comment` `{body}`, `assign` `{to}`, `update` `{title?,body?,labels?,priority?,dependsOn?}` |
| `POST /api/sessions` `{…, taskNumber}` | links the session to the task; landing the session marks the task `done` and comments the revision |

## Notifications

`GET /api/notifications?unread=1` → `[{id, ts, type, message, ref:{kind:"task"|"session", id}, read}]`
(`mention`, `task_assigned`, `task_commented`, `review_requested`, `change_landed`, `change_conflicted`).
`POST /api/notifications/read` `{ids:[…]}` or `{all:true}`. `@name` in a task, comment or session goal mentions that identity.

## Tags and releases

`GET /api/tags` → `[{name, rev, message, tagger, ts}]`; `POST /api/tags` `{name, rev?, message?}` (write scope; immutable).
`GET /api/releases` → `[{tag, title, notes, author, ts, draft, prerelease}]`; `POST /api/releases` `{tag, title, notes, draft?, prerelease?}`;
`GET /api/releases/:tag`. Tags are advertised over the Git remote as `refs/tags/<name>`.

## Repositories

`GET /api/repos` → `[{name, description, createdAt, rev, forkedFrom?}]`; `POST /api/repos` `{name, description?, fork?:{from, rev?}}` (admin).
Served by the Worker, not by a repository's Durable Object.

## Review claims

`POST /api/sessions/:id/claim-review` `{leaseSec?}` → 409 naming the current claimant if taken. While a claim is live only the claimant
can approve or reject; `GET /api/review/queue` items carry `claimedBy`.
