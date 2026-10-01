# Benchmark: Weave vs push-and-retry vs a merge queue

Reproduce: `node bench/run.ts` (about 5 minutes; `--quick` for a smaller sweep). Raw numbers: `bench/results.json`.

## What is measured

N agents each land one change in a shared repository (10 files x 20 functions). 40% of changes append a new
function to a file; the rest edit a line inside a function; locations follow a Zipf distribution, so
"hot-spot" runs concentrate edits the way real repos do (index files, shared config, one busy module).
Agents take 5 to 60 s to produce a change, a build takes 60 s, and an agent needs 15 s to redo its change
after a conflict. Time is simulated; the logic is not:

- **push, rebase, retry**: fetch, change, CI, push; a rejected push means fetch, rebase, and a *new* CI
  run (what agents do today with plain git). Merges are done by real `git merge-file`.
- **merge queue (C=5)**: batches of C changes are built together on top of the queue ahead of them;
  a change that conflicts when it is added is ejected, reworked, and re-queued. Real `git merge-file`.
- **Weave (R=5)**: the real `Repo` class (train mode: speculative builds on top of queued changes,
  conflicting changes parked until the one ahead resolves, real merge engine, real semantic gate) with R
  simulated runners.

Same workload, same rework policy, same build capacity in each row.

### uniform edits (no hot spots), 5 builds in parallel

| agents | push, rebase, retry | merge queue (C=5) | Weave (5 runners, train mode) | conflicts (queue / Weave) |
|---|---|---|---|---|
| 20 | 1,270 s / 210 CI | 368 s / 20 CI | 270 s / 20 CI | 4 / 3 |
| 50 | 3,073 s / 1,274 CI | 801 s / 50 CI | 706 s / 50 CI | 14 / 11 |
| 100 | 6,141 s / 5,046 CI | 1,566 s / 100 CI | 1,329 s / 100 CI | 98 / 71 |
| 200 | — | 2,795 s / 200 CI | 2,600 s / 200 CI | 419 / 308 |

### hot-spot edits (Zipf 1.0), 5 builds in parallel

| agents | push, rebase, retry | merge queue (C=5) | Weave (5 runners, train mode) | conflicts (queue / Weave) |
|---|---|---|---|---|
| 20 | 1,330 s / 210 CI | 593 s / 20 CI | 508 s / 20 CI | 22 / 16 |
| 50 | 3,109 s / 1,266 CI | 1,191 s / 50 CI | 1,089 s / 50 CI | 60 / 48 |
| 100 | 6,239 s / 5,034 CI | 2,166 s / 100 CI | 2,018 s / 100 CI | 210 / 173 |
| 200 | — | 3,980 s / 200 CI | 3,575 s / 200 CI | 816 / 583 |

### Build concurrency sweep (200 agents, hot spots)

| builds in parallel | merge queue | Weave |
|---|---|---|
| 1 | 12,200 s | 12,185 s |
| 5 | 3,980 s | 3,575 s |
| 20 | 2,840 s | 2,243 s |

Every run lost zero updates (each agent's change was verified present at the end).

## How to read this honestly

- **The push-and-retry column is the real result.** At 100 agents it burns about 50x the CI of the other two,
  because every rejected push re-runs the whole test suite. That is the retry storm agents hit with plain git.
- **Weave and the merge queue are in the same range.** Weave comes out 5 to 20% faster here, but my queue
  model lands changes in synchronous waves while a real queue pipelines builds, so this likely flatters
  Weave. Read it as parity, not a win. Both spend exactly one build per change when there are no failures.
- Weave's real differences are elsewhere: no branch or PR per agent, conflicts returned as data, protected-
  path and risk-tiered review, provenance, and a semantic gate. None of that shows up in a throughput table.
- This is a model of GitHub-style workflows, not a measurement of GitHub itself.
- The synthetic workload has no failing tests and no stale reads. The live swarm (docs/SWARM-RUN.md) found
  a failure mode this simulation cannot: resolutions written against an older trunk silently erasing
  teammates' landed work.

## Is the semantic-interaction detector any good?

Synthetic pairs with known ground truth (200 cases each):

| case | expected | flagged |
|---|---|---|
| signature change vs new caller | flag | 200/200 (100%) |
| body change vs existing caller edited | flag | 200/200 (100%) |
| same function, different lines | flag | 200/200 (100%) |
| transitive dependency (known miss) | flag | 0/200 (0%) |
| independent changes (false positives) | ignore | 0/200 (0%) |
| independent edits to two functions (false positives) | ignore | 0/200 (0%) |

It catches direct dependencies and same-function edits with no false positives on independent changes.
It misses transitive dependencies (a change two calls away); that is a known limit of a regex-based
symbol analysis and the reason a real parser is on the roadmap.

## Does the merge engine behave like git?

3,000 random pairs of concurrent edits (half realistic workload edits, half adversarial random
line edits over a tiny alphabet that forces repeated lines), compared with real `git merge-file`:
**99.0% agreement** (both clean 2,147, both conflict 824).
Weave merged 22 cases git rejected, rejected 7 that git merged, and produced different
clean text in 1 (two sides inserting identical lines near each other; Weave treats them as one change).

Getting here mattered: an early naive diff made Weave auto-merge cases where git correctly conflicts,
which would have made every benchmark number look better for the wrong reason. The engine now uses
Myers' diff, canonical hunk placement, and git's rule that changes separated by no unchanged line conflict.
