# Task 2: the later asker yields after 2 minutes

Read the index's Brief and Global Constraints first. Size: Core (claims). After this task a first deadlock ends
by itself; a repeat yields again without a queue until task 3.

**Files:**

- `apps/daemon/src/mcp/claim-wait.ts`: the clock and the yield in `claimOrWait`; `Yielded` and the refusal's new
  fields; `yieldRefusal`'s rule wording.
- `apps/daemon/src/mcp/tools.ts`: pass `now` into `Asking`; nothing else.
- `apps/daemon/src/mcp/claim-deadlock.ts`: the builder's answer passes `to: null, queued: false`.
- `apps/daemon/src/daemon/start.ts` (or where `forgetEndedYields` is subscribed): subscribe `forgetEndedPairs`;
  wire `UndoMoves.forgetClaimDeadlock` to `dropPair`, throwing `ConflictError` when it answers false.
- `apps/daemon/src/mcp/mcp.test.ts`: extend the deadlock test.
- `apps/daemon/src/mcp/AGENTS.md`.

**Calls**, exactly: `deadlockMove`, `recordBreak`, `readPair`, `dropPair`, `forgetEndedPairs` (task 1);
`ClaimWaits.claimsAwaitedFrom(holder, start)`, `ClaimWaits.yielded(workstreamId, given)`, `releaseClaim`,
`activeClaims`, `isRuleAsking`, `postNotice`.

**The wait.** Today the wait that finds `waits.waitsOn(holder, me, ended)` raises the card at once. That wait is
the later asker: the other task was already waiting when this one asked.

- Where the card is raised today, call `deadlockMove` with `breaks` from `readPair`, `gives` from
  `claimsAwaitedFrom(me, holder)` and `ageMs` from a `deadlockSince` kept on the wait (set from `a.now()` when the
  cycle is first found, cleared when it is gone).
- `card`: today's code path, unchanged.
- `wait`: no card; the wait's notice reads "Waits for <claim>; task "<title>" waits for a claim this one holds".
  The poll looks again: today the cycle is checked only when the holder changed or a card is up, so that
  condition gains "or `deadlockSince` is set", or the wait would never reach 2 minutes.
- `yield` (and, until task 3, the two queue moves): one `state.write` releases from me each active claim in
  `claimsAwaitedFrom(me, holder)`, calls `recordBreak` with `contested` = those claims plus the claim I asked for,
  and posts the notice. Then `waits.yielded(me, { claims, inboxId: null, to: holder, queued: false })`, and the
  loop's `pendingYield` check ends this wait and my others with the refusal. The other task's wait takes the claim
  on its next poll and `handOver(me)` records my uncommitted edits as mine, as it does today.
- `yieldRefusal` for a rule yield: "This task and task "<title>" each waited for a claim the other holds, so 10db
  had this one give up <claims>; that task has it now." The rest of today's wording stands (edit nothing there,
  the uncommitted edits stay yours, ask again with a new opId).

**The notice.** `postNotice` with `tier: CardTier.Notice`, the yielder's task, key
`claim-deadlock:<a>:<b>`, and `decision: { by: Rule, rule: ClaimDeadlock, confidence: null, undo: { state:
'undoable', action: { kind: 'forget_claim_deadlock', a, b } } }`.

- Line: `"<yielder>" gave up <claims> to "<other>" to end a claim deadlock`.
- Body: both titles, the claims, that the other task got committed work only, and "Undo forgets this yield: the
  two tasks count as never having deadlocked."

**State-table rows:** "A wait finds the cycle", `yield`, "Undo on a row", "A cycle of three or more", "Either task
of a pair reaches a terminal state".

**Test.** Extend the existing two-task deadlock test in `mcp.test.ts` (real SQLite, a real git repository in a
temp directory, an injected clock): before 2 minutes no card and no release; after it, with no card, the later
asker's call answers the yield refusal, the other's is granted, the yielder's uncommitted file is not in the
other's handed paths as its own to commit, one notice with an undoable decision is posted, and Undo through
`createActivityActions` drops the pair and refuses a second time. With the rule set to ask, today's card is
raised. Show it red first with `DEADLOCK_YIELD_AFTER_MS` ignored.

`Value: protects=a claim deadlock ending by the later asker's yield, told through its wait, with its uncommitted
edits left its own; fails_when=a card is raised, a claim is released from a task that is not told, or the earlier
asker yields; why_new=claims; no_claim=the queue or the defect task`.

**Spec:** "9. Stages" row 5 and the "Claim deadlock" row of §3 in the what-reaches-the-builder spec; stage F2 of
the inbox-cards spec; `decisions/2026-11-27-a-task-that-gives-up-a-claim-in-a-shared-checkout-keeps-its-edits.md`.
