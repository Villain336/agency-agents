# Swarm runs: 16 real agents, one repository, three runs

Sixteen Claude agents each add one function (plus two tests) to the same small JavaScript library through
Weave, at the same time, with required `node --test` checks run by four real runners and two reviewer
agents. The design is deliberately hostile: every agent must edit the single `module.exports = { ... }`
line and append to the same test file. README.md is a protected path (needs a reviewer).

Each run used a fresh repository and the same task prompts. Final trunks were re-checked from the server's
state by `video/capture.ts` (tests run on the real extracted files), not taken from agent reports.

| | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Functions on final trunk (of 16) | 12 | 12 | 16 |
| Landed, then silently erased | 2 (eli, kim) | 0 | 0 |
| Never landed | 2 (ben, dev) | 4 (ada, eli, ned, pia) | 0 |
| Conflicts reported | 37 | 64 | 2 |
| Resolve rounds by agents | 71 | 112 | 2 |
| Test runs (failed) | 28 (3) | 20 (0) | 26 (0) |
| Reviews (approve / reject) | 2 / 2 | 2 / 1 | 3 / 1 |
| Time to land: median / last | 94 s / 149 s | 98 s / 138 s | 60 s / 81 s |
| Final trunk tests passing | 24 / 24 | 26 / 26 | 34 / 34 |

Raw data: `video/data/run1`, `run2`, `run3` (full audit logs, final trunks, per-agent metrics).

## What each run found

**Run 1 (engine as of the first live trial).** 12 of 16 functions ended up on trunk, and two of the 12
*landings* (eli's `flatten`, kim's `range`) were later silently erased: another agent resolved a conflict
against an older trunk, Weave based that resolution on the current trunk, and the stale file overwrote the
two changes. Every check passed because the tests were erased with the code. Two README-bundled sessions
were rejected by a reviewer agent for deleting teammates' tests. Fixed: revert detection, revalidation of
sessions waiting in review, review-pack warnings.

**Run 2 (after those fixes).** No landed work was lost, and revert detection stopped a stale change once,
but conflicts went *up* to 64 and four agents gave up at the four-attempt cap. Cause: I had based content
resolutions on the revision where the conflict was detected, so any change to the shared line between
detection and the agent's re-read produced a false conflict. Fixed: base on the revision the agent says it
read (default current trunk), with revert detection as the safety net.

**Run 3 (list merging and union enabled for `*.js`).** All 16 functions landed, 2 conflicts in total, all
tests pass, and the whole run finished in 81 s. Twelve agents landed on their first submit. Weave merged
the exports line item by item and kept both sides' appended blocks, recording each auto-resolution in the
risk score and the commit's provenance.

## Read this before quoting the numbers

- **One sample per run.** Agents are not deterministic and each run is a single trial.
- **Run 3 changed three things at once:** the merge strategies, a repository config that enables union on
  `*.js`, and CLI/reviewer-tooling fixes (reviewers could finally see the pack's warnings; `wv cat` no longer
  prints a stray line). The conflict drop is mostly the merge strategies, but I did not run an ablation.
- **The result depends on the hot spots having a handled shape** (a list on one line, appended blocks).
  A function that every agent rewrites differently would still conflict. This workload was built to
  stress an exports line; a repo without one would show less benefit.
- **Union merging can combine two sides that each added the same function.** That happened in run 3
  (ada's code-plus-README session landed after her code had already landed) and a reviewer agent caught it
  ("added a duplicate definition"); Weave now stops that case itself (see below).
- Agents were Claude subagents given the CLI cheat-sheet in their prompt, not cold users.
- The four-attempt cap in the prompt shaped run 2: agents persisted for up to six rounds in run 1.

## Other things the swarm exposed (all fixed and tested)

- The first `wv cat` change printed a `# trunk rN` line to stderr; agents that redirected both streams wrote it
  into files (a README header was lost). The CLI now prints only file content.
- `wv pack` did not print the pack's `warnings`, so run 2's reviewers never saw them.
- Reviewer packs showed stale check evidence and omitted conflicts; both are now called out first.
- A merge that would declare a top-level name twice is stopped before it lands (legal in JavaScript, so
  neither tests nor the compiler would notice); `allowRevert` confirms an intentional case such as overloads.
- A submit whose content equals trunk (an agent's script bug) lands as a no-op; Weave cannot know what a
  change was *meant* to contain, so this stays an agent-side hazard.

## Still open

- Two reviewers polling one queue race each other and the loser sees a 409; claiming a change on open
  would fix it.
- Agents script "re-read trunk, re-apply, resubmit" themselves; a server-side retry would remove that work.
- README-bundled sessions sit in review and block their code; splitting protected paths from code
  automatically would help.
