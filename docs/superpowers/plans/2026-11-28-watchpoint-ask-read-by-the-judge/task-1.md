# Task 1: the read's contracts, its rule table, and the read in shadow

Read the index's Brief and Global Constraints first. Size: Core (a merge rule table). Nothing here acts: no card,
notice or pull request changes.

**Files:**

- `packages/contracts/src/judge.ts`: `JudgeDecision.WatchpointRead`, floor 0.8, configured as
  `WatchpointQuestion` is.
- `packages/contracts/src/watchpoint-hit.ts`: `WatchpointReadVerdict`, `WatchpointRead`, `WatchpointDetail.reads`,
  `WatchpointHit.hash`, `WatchpointChoice.Merge`, the `WatchpointCardDetail` fields. All optional or additive, so
  stored rows still parse.
- New `apps/daemon/src/watchpoints/read.ts`, `read.test.ts`, `read-agreement.ts`.
- `apps/daemon/src/watchpoints/hits-after.ts`: the hash.
- `apps/daemon/src/runner/runner.ts` (`watchpointReadingAfter`): calls the read and stores `reads`.
- `apps/daemon/src/watchpoints/AGENTS.md`: as built.

**Implements** (index, Interfaces): everything under `judge.ts`, `watchpoint-hit.ts`, `read.ts` (`readVerdict`,
`holdsMerge`, `readWatchpointHits`), and `watchpointReadAgreement`. `holdsMerge` is exported from the watchpoints
entry point (`watchpoints/index.ts`) for task 2. **Calls:** `questionDiff` and the judge as `watchpoints/question.ts`
does; `read` is `WatchpointChangeReader` (`hits-after.ts`), the type `askWatchpointQuestions` takes.

**The hash.** In `hits-after.ts`, before the 24 KB clip: `hash` is the sha256 of the unclipped diff of the hit's
files over the run's own range. A hit whose diff could not be read in full gets no hash.

**The read.** `readWatchpointHits` follows `askWatchpointQuestions` (its timeout, its diff cap, off the write path).
For each Ask hit it asks two questions in one `judge.assess` call of `JudgeDecision.WatchpointRead`: do these hunks
meet the watchpoint's guidance, and is the change destructive (a drop, a rename, a narrowing, a backfill). The
guidance and the hunks are quoted as data, as `question.ts` quotes them. It returns one `WatchpointRead` per hit
through `readVerdict`; a Hold hit gets `hold` with no judge call, a Show hit gets no entry. In this task every entry
has `acted: false`, the judge row is logged with `JudgeOutcome.Shadow`, and with no judge ready nothing is asked
(`unread`).

**The agreement.** `watchpointReadAgreement` follows `shadowAgreement` in `shape/jev.ts`. Over readings whose
`reads` have `acted: false` and whose workstream's Look card was answered: a `clean` read agrees with Looks Right, a
verdict `holdsMerge` (this task's, in `read.ts`) is true for agrees with Send Back. `cleanButSentBack` counts clean reads the builder sent back;
`firstAskedAt` is the oldest shadow read. `unread` and `hold` entries are not scored.

**Provider parity.** With no account decisions run on, nothing is asked and `reads` holds `unread`; nothing depends
on it.

**State-table rows:** `readVerdict`'s nine rows.

**Test (`read.test.ts`, pure).** One table test over `readVerdict`'s rows, each row also naming what `holdsMerge`
answers for its verdict. Show it red first.

`Value: protects=which judge readings of a hit hold a pull request; fails_when=a doubt, a fallback, a partial read or
a destructive answer reads as clean; why_new=merge rule table; no_claim=the judge's accuracy`.

**Spec:** what-reaches-the-builder "4. What exists already" (the two new judge questions), "5. How self-healing
fails, and its guards" (shadow for a week); watchpoints "S5, hold".
