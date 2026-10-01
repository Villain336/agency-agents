# Roadmap: from "Git for agents" to an agentic GitHub

Weave already has the hard, differentiating core. This is what separates it from a forge people live in.
Status as of this commit; "next" items are what is being built, not promises.

## Have (tested)

Sessions instead of branches, atomic landing with merge strategies, risk-tiered review with comments and
suggestions, required checks via pull-based runners (speculative train mode), semantic and revert gates,
signed hash-chained provenance, scoped identities and budgets, real Git remote and GitHub mirror,
MCP server, SDKs, webhooks, sharding, SQLite + R2 storage.

## Phase 1: feel like a forge (in progress)

| Feature | Status |
|---|---|
| Browse API: tree, file view, history, commit diff, blame, code search, README, stats | building |
| Web UI: repository browser, commits, diffs, blame, search, change (PR) pages with review, activity | building |
| Tasks (issues) with **agent claim leases**, `next` for agents, link to sessions, auto-close on landing | building |
| Notifications and `@mentions` | building |
| Tags and releases (advertised over Git) | building |
| Config as code (`weave.json` in the repo, human-approved) | building |
| Multiple repositories, forks | building |
| Review claims (stop reviewers racing) | building |

## Phase 2: automation and trust

Workflows (a declarative `weave/workflows/*` that defines checks, triggers, matrices, artifacts and secrets),
a Cloudflare Containers / Sandbox runner so checks need no self-hosted machine, preview environments,
secret scanning and dependency advisories, branch-protection style rules as policy, org and team
permissions, SSO, audit export.

## Phase 3: ecosystem

Packages/registry, Pages-style hosting, a marketplace for apps and agents, code search at scale (an index
instead of a scan), tree-sitter semantic gate, asymmetric signatures anyone can verify, mobile app,
GitHub import/two-way sync.

## Deliberately not goals

Cloning GitHub feature for feature. The aim is the parts that matter when most contributors are agents:
claims, risk-based review, provenance, speculative verification, and a Git remote so humans and existing tools keep working.
