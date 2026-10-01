# Live multi-agent trial

Five real Claude agents (four developers, one reviewer) worked one small JavaScript repo at the same
time through a running Weave (auth required, required `node --test` check run by a real runner).
Each developer had its own identity and token and used only the HTTP API. Tasks deliberately
collided: priority field, due dates, hardening, and search plus a README change (a protected path).

## Outcome

| Agent | Task | Result |
|---|---|---|
| alice | `priority` field | landed r2 |
| bruno | `dueDate` + `overdue()` | landed r3 |
| dara | validation + deep copies | landed r4 after resolving **two** real conflicts caused by trunk moving under it |
| chen | `search()` + README | first session **rejected by the reviewer agent** (see below); chen then resubmitted the code and tests on their own and landed r5. The README session reached `in_review` |

Trunk ended at r5 with all four features; its 11 tests pass (checked independently of the agents'
reports), and the provenance chain verifies. The README change was still awaiting review when the
trial ended: the server was stopped during cleanup while chen was still polling, which cost that
agent several minutes of access. That outage was caused by the test harness, not by Weave. The
state was then reloaded from SQLite after a restart and matched what the agents had reported.

## What the trial found, and what was changed

1. **Stale-read clobbering (data loss).** Bruno read trunk, then opened a session pinned to a newer
   revision, so his edits silently omitted alice's change. Weave would have fast-forwarded and reverted
   her work with no conflict. Fixes: `open` accepts `baseRev`; writes accept `basedOn` and are rejected
   (409) when the file changed since the revision the agent read; trunk reads return `rev`; tool and
   API docs say to read through the session.
2. **Green checks on a change that deleted tests.** Chen's change dropped 6 of 11 tests, so its unit
   check passed meaninglessly. Risk scoring now detects removed test cases (+30, forces review).
   The reviewer agent caught it by reading the diff; the fix makes the platform flag it by itself.
3. **Stale evidence shown to the reviewer.** The review pack listed old passing runs alongside current
   ones. Evidence entries now carry `current` (produced for exactly these edits and not stale).
4. **`resolve` required a submit round-trip.** Preview showed a conflict, but `resolve` answered "no
   conflict" until the session was submitted again. `resolve` now looks at the current merge itself.
5. **Rejection reasons were only in the audit log.** Chen could not see why a session ended
   `rejected`. Reviewer rejections and failed verifications are now stored on the session as
   `feedback` (who, type, note) and returned with it.

Not changed: conflicts still only become part of a session's status at submit time, and a session
that trunk keeps moving under can need several resolve-and-resubmit rounds (dara hit it twice).

## Honest caveats

- Agents were Claude subagents given the API cheat-sheet in their prompt; they were not tested cold.
- Four developers and a tiny repo is a smoke test, not a scale test.
- Conflict resolution quality depended on the agent; Weave only guarantees the conflict is surfaced.
