# apps/daemon/src/watchpoints

- `watchpoints/` matches a finished run's change against the builder's watchpoints
  (`docs/superpowers/specs/2026-11-25-watchpoints-design.md`). The shapes, `effectiveWatchpoints` and the starters are
  in `@10db/contracts` (`watchpoints.ts`, `watchpoint-hit.ts`); the lists are app settings read through
  `readYourWatchpoints` and `readProjectWatchpoints` (`packages/db`). Loudness `show` and `ask` act; `hold` is not offered yet. Migrations and Contracts start at ask: `readYourWatchpoints` applies `revisedWatchpoints`, which moves a stored copy still equal to the starter as first shipped (and no edited one) to the starter's loudness.
- `match.ts` is the pure rule table: `matchWatchpoints(files, watchpoints)` with `areaMatches`, so a dot folder matches.
  A file under two watchpoints is in both hits; the hit keeps a snapshot, never the globs.
- `hits-after.ts` (`watchpointHitsAfter`) reads the whole change's file counts first (a zero-byte read), matches on
  those, then reads only the matched files' text (`diffOfRanges` with `paths.only`) and splits it per file
  (`split-patch.ts`, which reads git's headers; diffs here are read without renames). It matches on the
  file list, never on the capped patch, so a watchpoint file past any cap is still a hit; one whose text was cut is kept
  with `clipped: true`. It throws when git can't be read: the runner turns that into a row with `skipped`.
  `WATCHPOINT_HIT_SOURCES` is the list of ways to find hits (the glob matcher now; the Evals session's
  classified events later).
- The runner calls it after a passing gate (`watchpointReadingAfter` in `runner.ts`), beside `acceptanceAfter`, and in
  `finishWithoutGate`. The base is read again after the gate (its base update moves it). The row is written in the
  write that moves the run on, never on an acceptance send-back; a reading that hits nothing is written only to
  retire an earlier one that did, so the newest row is always the current reading.
- `notes.ts` joins the notes: the agent's from the run's `commit` tool ops (newest per path), the reviewer's from the
  Review and QA steps' results (newest per path). Notes are one line (`WatchpointNote`) and are shown to a reviewer as
  quoted data, never as the brief's words (`brief.ts`).
- `brief.ts` builds the build brief's section (the watchpoints that overlap the task's areas, all when it has none, and the
  instruction to give `watchpointNotes` per covered file) and the Review and QA first round's section.
- The pull request's "For you" section (`delivery/pr-text.ts` `forYouSection`, `prBody`'s `watchpoints` input) is built
  in `ship.ts` from the batch members' newest readings (`delivery/pr-watchpoints.ts`), after "What and why", between
  `<!-- 10db:for-you -->` and `<!-- /10db:for-you -->`. A later ship into the same open pull request replaces only
  the text between the markers (`addWatchpointsTo`, `bodyWithForYou`) through `prEditBody`; a body whose markers were
  removed is left alone. `GET /workstreams/:id/watchpoint-hits` is `delivery/watchpoint-hits.ts` (`canOpenDiff` is
  whether `workstreamChanges` could still read the checkout). `diffOfRanges` takes `paths.only` to read only some
  files' text.
- `card.ts`: an ask hit raises the Look card (`raiseWatchpointCard`: one live card per workstream, a second reading updates it; its detail is only the watchpoints' keys and labels, so it reads the hunks live from `GET /workstreams/:id/watchpoint-hits`), and a show hit posts one `watchpoint:<workstreamId>` notice ("<task> touched <labels>"), both inside the write that records the reading (`announceWatchpointReading`), so an acceptance send-back writes neither. `watchpointReadingAfter` runs before `reviewForcedAfter` in `verify` and `finishWithoutGate`; when nothing else forces a review, `watchpointReviewReason` ("a watchpoint asks for you: <labels>") is the forced reason, and `withSafetyNet` adds a Review on a Light task. The card is never a run's question: `settle`, `deliver` (straight to Resolved) and recovery skip it. `applyWatchpointAnswer` runs in the answering write (`onWatchpointAnswer`): Looks right does nothing; Send back needs a note (`InboxAnswerRefused`) and files a Ready follow-up (`insertWatchpointFollowUp`). `GET /projects/:projectId/watchpoints/stats` is `watchpointStats` (`packages/db`): per watchpoint the last 30 days' tasks (newest reading per workstream), cards and waved cards (answered Looks right with no note); noisy is `isNoisyWatchpoint`, the card-type bounds.
