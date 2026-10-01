# What people love about GitHub, and what they wish it had

Method and limits: six web searches and one page fetch, reading search summaries rather than the
underlying threads. Statistics below are secondary-source claims and are unverified. The loved
features (items 2-8) mostly reflect general knowledge plus generic "why developers love GitHub"
articles, not survey data. Not covered: Gerrit, Sourcehut, Phabricator, Graphite, Radicle, Reddit.

## Loved

1. Network effect and discoverability ("where your users already are").
2. The PR as the unit of discussion, review and history.
3. Fork + PR as a low-friction path into open source.
4. Issues, Projects, linking and mentions in one place.
5. Actions and its marketplace: CI next to the code.
6. Free open-source hosting; profile as portfolio.
7. Branch protection, CODEOWNERS and required checks.
8. API and app ecosystem (Dependabot, Copilot, third-party apps).

## Wished for / pain points, and how Weave responds

| Pain point | Evidence (type) | Weave |
|---|---|---|
| Outages and reliability | HN threads, blog tallies (unverified counts), a high-profile project leaving | Not a feature problem. Durable Objects on Cloudflare's network are the bet. |
| Stacked PRs | GitHub community discussion announcing native stacks | No branches means no stacks to maintain. Each session lands atomically on trunk. |
| Slow, flaky merge queue | Several GitHub community discussions, a DEV post on a queue bug | One strongly consistent trunk per repo replaces the queue. CI cost remains. |
| Review overload from AI-generated PRs | Press coverage; GitHub added PR limits | Protected-path review sends human attention to risky paths only. Risky *interactions* are gated by verifiers. |
| Large PRs rubber-stamped | Blog posts | Sessions are small and short-lived; not enforced. |
| Textual conflicts block work | Jujutsu writing on first-class conflicts | Conflicts are structured data an agent resolves without blocking others. |
| Stale branches, rebase drudgery | Stacked-PR blogs | No branches. |
| CI flakiness and cost | Thin sourcing | `verify`: attestation bound to the trunk it tested, invalidated by later commits to the same paths. |
| Lock-in | Weak source | `GET /api/export` (git fast-import) and `POST /api/import`. |

## What this changed in Weave

- **Semantic gate** (`src/semantic.ts`): a textually clean merge is held in `needs_verify` when both
  sides changed the same declared symbol, or one side changed a symbol that uses something the other
  changed. Dogfooding showed why: an agent added a `limit` parameter while another cached the same
  function, and the line merge accepted it silently.
- **Import** (`scripts/import.ts`) to complement export.
- **Dry-run preview** (`GET /api/sessions/:id/preview`) so verifiers test the exact merged result.

## Known limits

The symbol detector is regex-based and heuristic (TS/JS/Go/Python declarations, no parser); it errs
toward flagging. It cannot see runtime behavior, which is what verifiers are for. Weave does not run
CI itself yet; verification is an attestation by an agent or external runner.
