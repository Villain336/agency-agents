# Weave demo: narration script

Target: about 5 minutes (the challenge asks for 5 to 10). At a calm 140 words per minute the voiceover below
runs about 4:50. `video/record.ts` produces the picture with on-screen captions; record this script over it
(or read it live while screen-recording the same scenes). Numbers come from `docs/BENCHMARK.md` and
`docs/SWARM-RUN.md`; if you re-run either, re-check them before you say them.

Scene lengths in `record.ts` are set so each paragraph fits its scene.

---

## 1. Title (0:00, 8 s)

"This is Weave: many agents, one trunk, zero branches. It is a collaboration layer for AI agents, and it
runs entirely on Cloudflare Workers, Durable Objects and R2."

## 2. The problem (0:08, 25 s)

"Git was designed for a few people working for days. Agents work in parallel, for minutes, by the dozen.
With plain git, every rejected push means a rebase and another full test run. At a hundred agents that is
about five thousand test runs to land a hundred changes. A merge queue fixes the retry storm, but it still
wants a branch and a pull request per agent. We wanted to see what a system built for agents looks like."

## 3. A real swarm (0:33, 90 s)

"Here is what actually happened when sixteen real Claude agents each added one function to the same small
library, at the same moment. No branches, no pull requests. Each agent opens a session, which is just a
cheap overlay on the trunk, and says which files it intends to touch.

The task is deliberately nasty. Every agent has to edit the same exports line and append to the same test
file. In git, that is a conflict for nearly everyone.

Weave merges that kind of change itself. A list on one line, like the exports, is merged item by item.
Blocks that two agents both appended at the same point can be kept together. Each of those automatic merges
is recorded in the risk score and in the commit's provenance, so nothing happens silently.

Before anything lands, the required tests run on the exact merged code, on four runners. Changes to a
protected path, like the README, wait for a reviewer agent. Watch the lanes: most changes simply land.
All sixteen landed, and the final trunk passes thirty-four of thirty-four tests."

## 4. The honest journey (2:03, 40 s)

"This is the third run of that experiment, and the first two taught us more than the third.

Run one exposed silent data loss. An agent resolved a conflict against an older trunk and quietly erased two
teammates' work, and every test still passed, because the tests were erased too. Weave now detects when a
clean merge would remove substantial work someone else landed, and stops it.

Run two fixed that, but my fix made conflicts worse, sixty-four instead of thirty-seven. I had based
resolutions on the wrong revision. Run three corrected that and added the list and union merging.
Two conflicts. One sample each, and run three changed several things at once, so treat it as a strong
signal, not a proof."

## 5. Benchmark (2:43, 40 s)

"We also measured it. Same workload, same build capacity, from twenty to two hundred agents. Weave and a
merge queue land in the same range, and both are about fifty times cheaper in test runs than push and
retry. I want to be straight about this: my queue model lands changes in waves, while a real queue
pipelines builds, so read this as parity, not a win. The baselines use real git merges. And the merge engine
itself agrees with real git on ninety-nine percent of three thousand random concurrent edits."

## 6. Trust: provenance and review (3:23, 45 s)

"Every landed change carries a signed provenance record: which agent and which model, the risk score and why,
the test evidence, who approved. The records form a hash chain, and so does the audit log, so tampering is
detectable. Risk decides who looks: low-risk changes land on evidence, medium ones need a reviewer agent,
and high-risk ones need a human. In these runs the reviewer agents caught things the green checks could not:
tests deleted along with the code they covered, and a duplicate function that would have silently
shadowed another."

## 7. It is real Git (4:08, 30 s)

"And it is a real Git remote. This is a plain git clone against Weave, with the history, the trailers,
and a clean fsck. Pushes land through the same merge engine. It also speaks MCP, so any agent can use it as a
tool, and there are TypeScript and Python SDKs."

## 8. Limits and close (4:38, 25 s)

"The limits are on the screen: the semantic checker is a heuristic and misses indirect dependencies. A line
that every agent rewrites differently still conflicts. And the mirror to GitHub has only been tested against
a local server. Weave: many agents, one trunk, zero branches. It is open source."

---

### Recording tips

- Record the narration at a steady pace; pause at the scene changes.
- If you want live terminal footage as well, the repo's `npm run e2e` and `node scripts/demo.ts` are
  good short segments.
- To regenerate the picture after changing data: `node video/capture.ts <url> <repo> <admin-token> run3`,
  copy `video/data/run3/*` over `video/data/`, then `node video/record.ts`.
