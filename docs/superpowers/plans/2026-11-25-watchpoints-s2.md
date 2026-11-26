# Watchpoints S2: ask

**Size: Feature.** One implementer builds it end to end, then one code review that blocks only on bugs. The spec is
`docs/superpowers/specs/2026-11-25-watchpoints-design.md` (§ Scope row S2, § The Look card, § State table). S1
(PR #881) is on main.

## Brief

**What changes for you.**
- Ask is now selectable in Settings › Watchpoints. Migrations and Contracts start as ask.
- When a task's diff hits an ask watchpoint, the Inbox gets one **Look at these changes** card for that task, however
  many ask watchpoints it hits. The card shows the same folds as For You. **Looks right** closes it. **Send back with
  a note** files a Ready follow-up task holding your note.
- The task never waits: the card is written as the run moves on.
- An ask hit on a Light task adds a review, so the reviewer's check is there when you look.
- A show hit posts one uncounted line in Activity.
- Settings shows each watchpoint's last 30 days: the tasks it hit, the cards it raised, and a yellow **noisy** flag
  when at least 5 cards were mostly waved through (at least 80% answered Looks right with no note).

**What could go wrong, and how we'd know.**
- *Too many cards.* Only Migrations and Contracts start at ask, and the noisy flag shows the ones you wave through.
- *The card lands before the reviewer's check.* The card reads the task's newest reading live, as For You does, so
  the check appears on it when the review ends.
- *A starter you edited is changed.* Only a builder copy still identical to the S1 starter becomes ask. An edited one
  stays as you left it.

**Calls you might disagree with.**
- A card covering two watchpoints counts toward both watchpoints' noise.
- Show hits go to Activity (uncounted), not to the Inbox.

**Needed from you:** nothing.

## Provider parity

The same on every provider. The daemon matches, writes the card and files the follow-up task, and the reviewer's
notes use the same MCP tool as in S1.

## Parts, in build order

1. **Contracts:**
   - `InboxKind.Watchpoint = 'watchpoint'`.
   - `WatchpointChoice = { LooksRight: 'looks_right', SendBack: 'send_back' } as const`.
   - `WatchpointCardDetail = { watchpoints: [{ key, label }] }`. The card holds no hunks; it reads them from
     `GET /workstreams/:id/watchpoint-hits`.
   - `STARTER_WATCHPOINTS`: Migrations and Contracts get `loudness: ask`.
   - `STARTER_WATCHPOINT_REVISIONS`: the S1 versions of those two, at show. The pure
     `revisedWatchpoints(stored)` sets a stored builder entry to its starter's new loudness only when the entry
     equals the revision's old version field for field. Otherwise it leaves the entry as it is.
   - `WatchpointStatsDto = { key, tasks, cards, waved, noisy }`.
   - `isNoisyWatchpoint({ cards, waved })` reuses `NOISY_MIN_RAISED` and `NOISY_SHARE`.
2. **db:**
   - `readYourWatchpoints` applies `revisedWatchpoints` when it reads.
   - `insertWatchpointFollowUp(ctx, taskId, { watchpoints, note })` files a Ready task. Its title is "Revisit
     <labels> in <title>", it takes the source task's areas, and its description holds the note and the source
     task's id, as `insertAcceptanceFollowUp` does.
   - `watchpointStats(db, projectId, now)` covers the last 30 days:
     - `tasks` counts workstreams whose newest watchpoint row hit the key;
     - `cards` counts Watchpoint cards whose detail names the key;
     - `waved` counts those answered `looks_right` with an empty note.
3. **Daemon, runner** (`runner.ts`, `verify` and `finishWithoutGate`):
   - Compute `watchpointReadingAfter` **before** `reviewForcedAfter`.
   - When the reading has an ask hit and no other reason forces a review, pass the reason
     `a watchpoint asks for you: <labels>` into the forced-review path (`withSafetyNet` handles "a review already
     follows").
   - In the same write that records the reading:
     - if it has ask hits, raise or update the one Watchpoint card for the workstream (`raiseWatchpointCard`, modelled
       on `raiseAcceptanceCard`, in `apps/daemon/src/watchpoints/card.ts`);
     - if it has show hits, post one notice (`postNotice`, key `watchpoint:<workstreamId>`, line
       "<task> touched <labels>").
   - An acceptance send-back still returns first, so neither the card nor the notice is written then.
4. **Daemon, the card is never a run's question.** Add `InboxKind.Watchpoint` wherever Acceptance is excluded:
   - `settle`'s find (`runner.ts` ~2171);
   - `deliver`'s early return to Resolved (`inbox/service.ts` ~647);
   - `recover.ts` ~199.
   Then apply the answer inside the answering write (`onWatchpointAnswer` beside `onAcceptanceAnswer`, wired in
   `daemon/start.ts`). Looks right does nothing. Send back needs a note (`InboxAnswerRefused` otherwise) and calls
   `insertWatchpointFollowUp`.
5. **Routes:** `GET /projects/:projectId/watchpoints/stats` returns `WatchpointStatsDto[]`. Name it in
   `render-access.ts` and `dev-ui-access.ts` as S1 did.
6. **Desktop:**
   - Enable Ask in `watchpoint-loudness.tsx`; Hold stays "Coming later".
   - `views/inbox/watchpoint-card.tsx` follows `AcceptanceCard`'s shape:
     - its header is "LOOK AT THESE CHANGES" plus the task, rigor and PR;
     - its body is For You's folds (reuse `task-for-you.tsx`'s fold list; extract it if needed), all open;
     - it has a note box, **Send back with a note** and **Looks right**, and an "Open the task" link.
   - Add the kind to every per-kind table: `inbox-card.tsx`, `permission-labels.ts`, `kind-icons.ts`,
     `factory/needs-you-panel.tsx`, `desktop/tauri.ts` and `open-inbox.tsx`.
   - Settings gets a "Last 30 days" column: "N tasks · M cards", in yellow with "noisy" when `noisy` is true.
   - Mantine and theme tokens only, as in S1. Check dark and light.
7. **Docs:** update the `AGENTS.md` notes beside the watchpoints module, the inbox view, and settings. Add one line to
   the e2e flow table.

## Tests (only these)

- **Extend the rule table in `apps/daemon/src/watchpoints/match.test.ts`:**
  - `revisedWatchpoints`: an unchanged S1 starter becomes ask, and an edited one doesn't;
  - `isNoisyWatchpoint`: 4 of 4 waved is not noisy, 5 of 6 is, and 3 of 5 is not.
  - Prove it red first. This adds rows, not a new file.
- **Extend `apps/desktop/e2e/loop.spec.ts` flow 2.** The seeded Greetings watchpoint becomes `ask`. After Done:
  - the Inbox shows "Look at these changes: <task>" with the hunk and the Agent note;
  - Looks right closes it.
  - Keep the existing For You assertions.
- No other new tests.

## Done

- Typecheck, lint and the related tests pass. Run the ship, inbox and runner test files as well, because S1's CI
  failure came from a test that wasn't "related".
- The extended e2e passes, and `make precheck` exits 0.
- Then the builder's lead runs browser QA, a Fable review, and a PR with auto-merge.
