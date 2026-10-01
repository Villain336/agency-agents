# Weave benchmark results

Virtual-time simulation: CI = 60s, rework after a conflict = 15s, agents take 5-60s to produce a change. Baselines use real `git merge-file`; Weave runs its actual `Repo` (train mode, real merge and semantic gate). Build concurrency C is the merge-queue batch size and the number of Weave runners.

### 20 agents, hot-spot skew 0, build concurrency 5

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| push-race | 1270 | 210 | 190 | 3 | 700 | 1270 | 0 |
| queue(C=5) | 368 | 20 | 4 | 4 | 188 | 368 | 0 |
| weave(train,R=5) | 270 | 20 | 3 | 3 | 188 | 270 | 0 |

### 50 agents, hot-spot skew 0, build concurrency 5

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| push-race | 3073 | 1274 | 1224 | 11 | 1595 | 2949 | 0 |
| queue(C=5) | 801 | 50 | 14 | 14 | 366 | 726 | 0 |
| weave(train,R=5) | 706 | 50 | 11 | 11 | 366 | 624 | 0 |

### 20 agents, hot-spot skew 1, build concurrency 5

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| push-race | 1330 | 210 | 190 | 16 | 705 | 1330 | 0 |
| queue(C=5) | 593 | 20 | 22 | 22 | 188 | 593 | 0 |
| weave(train,R=5) | 508 | 20 | 16 | 16 | 188 | 508 | 0 |

### 50 agents, hot-spot skew 1, build concurrency 5

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| push-race | 3109 | 1266 | 1216 | 48 | 1599 | 2954 | 0 |
| queue(C=5) | 1191 | 50 | 60 | 60 | 366 | 1041 | 0 |
| weave(train,R=5) | 1089 | 50 | 48 | 48 | 366 | 939 | 0 |

## Semantic-interaction detector (synthetic ground truth)

| case | should flag | flagged | rate |
|---|---|---|---|
| signature change vs new caller | yes | 200/200 | 100% |
| body change vs existing caller edited | yes | 200/200 | 100% |
| same function, different lines | yes | 17/200 | 9% |
| transitive dependency (known miss) | yes | 0/200 | 0% |
| independent changes (false positives) | no | 0/200 | 0% |
| independent edits to two functions (false positives) | no | 0/200 | 0% |

## Merge engine vs real git (400 random concurrent-edit pairs)

Agreement 99.3%: both clean 283, both conflict 115, Weave merged what git rejected 2, Weave rejected what git merged 0, clean but different text 1.
