# Weave benchmark results

Virtual-time simulation: CI = 60s, rework after a conflict = 15s, agents take 5-60s to produce a change. Baselines use real `git merge-file`; Weave runs its actual `Repo` (train mode, real merge and semantic gate). Build concurrency C is the merge-queue batch size and the number of Weave runners.

### 20 agents, hot-spot skew 0, build concurrency 1

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| push-race | 1270 | 210 | 190 | 3 | 700 | 1270 | 0 |
| queue(C=1) | 1208 | 20 | 3 | 3 | 668 | 1208 | 0 |
| weave(train,R=1) | 1208 | 20 | 3 | 3 | 668 | 1208 | 0 |

### 20 agents, hot-spot skew 0, build concurrency 5

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| push-race | 1270 | 210 | 190 | 3 | 700 | 1270 | 0 |
| queue(C=5) | 368 | 20 | 4 | 4 | 188 | 368 | 0 |
| weave(train,R=5) | 270 | 20 | 3 | 3 | 188 | 270 | 0 |

### 20 agents, hot-spot skew 0, build concurrency 20

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| push-race | 1270 | 210 | 190 | 3 | 700 | 1270 | 0 |
| queue(C=20) | 263 | 20 | 6 | 6 | 128 | 263 | 0 |
| weave(train,R=20) | 174 | 20 | 3 | 3 | 100 | 174 | 0 |

### 50 agents, hot-spot skew 0, build concurrency 1

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| push-race | 3073 | 1274 | 1224 | 11 | 1595 | 2949 | 0 |
| queue(C=1) | 3006 | 50 | 11 | 11 | 1566 | 2886 | 0 |
| weave(train,R=1) | 3021 | 50 | 11 | 11 | 1566 | 2886 | 0 |

### 50 agents, hot-spot skew 0, build concurrency 5

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| push-race | 3073 | 1274 | 1224 | 11 | 1595 | 2949 | 0 |
| queue(C=5) | 801 | 50 | 14 | 14 | 366 | 726 | 0 |
| weave(train,R=5) | 706 | 50 | 11 | 11 | 366 | 624 | 0 |

### 50 agents, hot-spot skew 0, build concurrency 20

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| push-race | 3073 | 1274 | 1224 | 11 | 1595 | 2949 | 0 |
| queue(C=20) | 501 | 50 | 18 | 18 | 186 | 366 | 0 |
| weave(train,R=20) | 346 | 50 | 11 | 11 | 137 | 264 | 0 |

### 100 agents, hot-spot skew 0, build concurrency 1

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| push-race | 6141 | 5046 | 4946 | 72 | 3097 | 5878 | 0 |
| queue(C=1) | 6006 | 100 | 71 | 71 | 3066 | 5766 | 0 |
| weave(train,R=1) | 6006 | 100 | 71 | 71 | 3066 | 5766 | 0 |

### 100 agents, hot-spot skew 0, build concurrency 5

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| push-race | 6141 | 5046 | 4946 | 72 | 3097 | 5878 | 0 |
| queue(C=5) | 1566 | 100 | 98 | 98 | 666 | 1386 | 0 |
| weave(train,R=5) | 1329 | 100 | 71 | 71 | 666 | 1237 | 0 |

### 100 agents, hot-spot skew 0, build concurrency 20

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| push-race | 6141 | 5046 | 4946 | 72 | 3097 | 5878 | 0 |
| queue(C=20) | 876 | 100 | 110 | 110 | 246 | 681 | 0 |
| weave(train,R=20) | 632 | 100 | 71 | 71 | 195 | 484 | 0 |

### 200 agents, hot-spot skew 0, build concurrency 1

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| queue(C=1) | 12035 | 200 | 306 | 306 | 6065 | 11465 | 0 |
| weave(train,R=1) | 12035 | 200 | 310 | 310 | 6065 | 11465 | 0 |

### 200 agents, hot-spot skew 0, build concurrency 5

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| queue(C=5) | 2795 | 200 | 419 | 419 | 1265 | 2465 | 0 |
| weave(train,R=5) | 2600 | 200 | 308 | 308 | 1265 | 2345 | 0 |

### 200 agents, hot-spot skew 0, build concurrency 20

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| queue(C=20) | 1535 | 200 | 517 | 517 | 365 | 1205 | 0 |
| weave(train,R=20) | 1175 | 200 | 306 | 306 | 365 | 878 | 0 |

### 20 agents, hot-spot skew 1, build concurrency 1

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| push-race | 1330 | 210 | 190 | 16 | 705 | 1330 | 0 |
| queue(C=1) | 1268 | 20 | 16 | 16 | 668 | 1268 | 0 |
| weave(train,R=1) | 1253 | 20 | 16 | 16 | 668 | 1253 | 0 |

### 20 agents, hot-spot skew 1, build concurrency 5

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| push-race | 1330 | 210 | 190 | 16 | 705 | 1330 | 0 |
| queue(C=5) | 593 | 20 | 22 | 22 | 188 | 593 | 0 |
| weave(train,R=5) | 508 | 20 | 16 | 16 | 188 | 508 | 0 |

### 20 agents, hot-spot skew 1, build concurrency 20

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| push-race | 1330 | 210 | 190 | 16 | 705 | 1330 | 0 |
| queue(C=20) | 563 | 20 | 26 | 26 | 128 | 563 | 0 |
| weave(train,R=20) | 459 | 20 | 16 | 16 | 107 | 459 | 0 |

### 50 agents, hot-spot skew 1, build concurrency 1

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| push-race | 3109 | 1266 | 1216 | 48 | 1599 | 2954 | 0 |
| queue(C=1) | 3111 | 50 | 48 | 48 | 1566 | 2961 | 0 |
| weave(train,R=1) | 3111 | 50 | 48 | 48 | 1566 | 2961 | 0 |

### 50 agents, hot-spot skew 1, build concurrency 5

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| push-race | 3109 | 1266 | 1216 | 48 | 1599 | 2954 | 0 |
| queue(C=5) | 1191 | 50 | 60 | 60 | 366 | 1041 | 0 |
| weave(train,R=5) | 1089 | 50 | 48 | 48 | 366 | 939 | 0 |

### 50 agents, hot-spot skew 1, build concurrency 20

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| push-race | 3109 | 1266 | 1216 | 48 | 1599 | 2954 | 0 |
| queue(C=20) | 831 | 50 | 60 | 60 | 186 | 681 | 0 |
| weave(train,R=20) | 755 | 50 | 48 | 48 | 137 | 605 | 0 |

### 100 agents, hot-spot skew 1, build concurrency 1

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| push-race | 6239 | 5034 | 4934 | 173 | 3100 | 5927 | 0 |
| queue(C=1) | 6171 | 100 | 172 | 172 | 3066 | 5871 | 0 |
| weave(train,R=1) | 6171 | 100 | 173 | 173 | 3066 | 5871 | 0 |

### 100 agents, hot-spot skew 1, build concurrency 5

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| push-race | 6239 | 5034 | 4934 | 173 | 3100 | 5927 | 0 |
| queue(C=5) | 2166 | 100 | 210 | 210 | 666 | 1866 | 0 |
| weave(train,R=5) | 2018 | 100 | 173 | 173 | 666 | 1718 | 0 |

### 100 agents, hot-spot skew 1, build concurrency 20

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| push-race | 6239 | 5034 | 4934 | 173 | 3100 | 5927 | 0 |
| queue(C=20) | 1581 | 100 | 243 | 243 | 246 | 1281 | 0 |
| weave(train,R=20) | 1373 | 100 | 172 | 172 | 197 | 1073 | 0 |

### 200 agents, hot-spot skew 1, build concurrency 1

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| queue(C=1) | 12200 | 200 | 580 | 580 | 6065 | 11525 | 0 |
| weave(train,R=1) | 12185 | 200 | 583 | 583 | 6065 | 11510 | 0 |

### 200 agents, hot-spot skew 1, build concurrency 5

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| queue(C=5) | 3980 | 200 | 816 | 816 | 1265 | 3305 | 0 |
| weave(train,R=5) | 3575 | 200 | 583 | 583 | 1265 | 2900 | 0 |

### 200 agents, hot-spot skew 1, build concurrency 20

| policy | makespan (s) | CI runs | retries | conflicts | p50 land (s) | p95 land (s) | lost updates |
|---|---|---|---|---|---|---|---|
| queue(C=20) | 2840 | 200 | 968 | 968 | 365 | 2165 | 0 |
| weave(train,R=20) | 2243 | 200 | 580 | 580 | 365 | 1568 | 0 |

## Semantic-interaction detector (synthetic ground truth)

| case | should flag | flagged | rate |
|---|---|---|---|
| signature change vs new caller | yes | 200/200 | 100% |
| body change vs existing caller edited | yes | 200/200 | 100% |
| same function, different lines | yes | 200/200 | 100% |
| transitive dependency (known miss) | yes | 0/200 | 0% |
| independent changes (false positives) | no | 0/200 | 0% |
| independent edits to two functions (false positives) | no | 0/200 | 0% |

## Merge engine vs real git (3000 random concurrent-edit pairs)

Agreement 99.0%: both clean 2147, both conflict 824, Weave merged what git rejected 22, Weave rejected what git merged 7, clean but different text 1.
