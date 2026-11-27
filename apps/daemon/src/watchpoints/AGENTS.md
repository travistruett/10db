# apps/daemon/src/watchpoints

- `watchpoints/` matches a finished run's change against the builder's watchpoints
  (`docs/superpowers/specs/2026-11-25-watchpoints-design.md`). The shapes, `effectiveWatchpoints` and the starters are
  in `@10db/contracts` (`watchpoints.ts`, `watchpoint-hit.ts`); the lists are app settings read through
  `readYourWatchpoints` and `readProjectWatchpoints` (`packages/db`). Loudness `show` and `ask` act; `hold` is not offered yet. Migrations and Contracts start at ask: `readYourWatchpoints` applies `revisedWatchpoints`, which moves a stored copy still equal to the starter as first shipped (and no edited one) to the starter's loudness.
- `match.ts` is the pure rule table: `matchWatchpoints(files, watchpoints)` with `areaMatches`, so a dot folder matches.
  A file under two watchpoints is in both hits; the hit keeps a snapshot, never the globs.
- A watchpoint's `lines` are case-insensitive regexes over the added and removed lines of the files its globs cover
  (`changed-lines.ts`: no `---`/`+++` headers, no marker, no trailing `\r`, each line cut at 2,000 characters; a cut line marks the file not read in full). With `lines`, a covered
  file counts only when one of them matches, judged on the text that was read. A watchpoint without `lines` matches as before.
  `watchpointCovers` (`covers.ts`) is the one covers rule, shared by `matchWatchpoints` and `evalDefinitionSource`; `lineChecks` names the (watchpoint, file) pairs to test; `watchpointHitsAfter` reads the files' text
  once, up to `WATCHPOINT_LINE_SCAN_BYTES` (512 KB), splits it at the per-file cap, matches on it and reuses those sections as
  the matched files' hunks. A file the scan didn't reach, or cut with no matching line in the text read, is clipped: an ask or hold watchpoint counts it (fail closed, so a huge change can't slip past a watchpoint the builder asked to judge), a show watchpoint doesn't (Model choice on `**` would flag every file of a big change). A file of an ask or hold watchpoint that the scan didn't reach or cut is read again at its own cap and judged on that read. The patterns run in `line-worker.ts` (bundled as `line-worker.mjs` beside the daemon, like `extract-worker`), killed at 5 s (`line-reading.ts`); the pure matcher consumes its verdicts, and with none (timeout, death) no line is cleared and the runner logs the watchpoint keys. Which files are hits is decided before the hunks are read and a later read never drops one: a file with no verdict (unread), cut, clipped or with no hunk (a binary or `-diff` file with changes) stays a hit of an ask or hold watchpoint, marked `clipped`. A file first read in the hunk loop gets its verdict from a second worker call. The sources run again on the hunks only to classify an eval definition on its patch.
- A watchpoint's `question` (S3b, in shadow) is a yes/no 10db's judge asks; it never makes a hit. A question watchpoint
  hits only through its globs plus lines, so one with no lines makes no rule hit (`watchpointCovers`). Its question
  candidates are the files its globs cover that no line matched (`questionCandidates`, pure, in `covers.ts` beside
  `lineChecks`). `watchpointHitsAfter` hands them to its `ask` once the rules are done, and keeps the answers as
  `WatchpointDetail.shadow` (`{ key, label, asked, more, yes }`, optional, so an old row reads as none). `question.ts`
  (`askWatchpointQuestions`) is the one place that asks: nothing when `judge.ready(watchpoint_question)` is false (off
  by default) or there are no candidates, else one `judge.assess` per watchpoint with one `NoulQuestion`, marked
  `secondary` (no outage card, no `lastFallback`), a 20 s timeout, and the call logged as `JudgeOutcome.Shadow`. The
  watchpoint, the file names and their hunks go inside one fence; `questionDiff` keeps them within
  `WATCHPOINT_QUESTION_DIFF_CAP` characters (each file's first hunks past it, at most 150 files), and `asked` names only
  the files shown, `more` counting the rest. It never throws: no answer leaves `yes` null. The runner reuses the
  newest reading's answers for the same head (a Review or QA step with no new commits), keeps a reading that holds
  only shadow answers (no hits, its summary says how many questions were asked), and retires it like any other. A
  question watchpoint with no lines is left out of the build brief. Nothing on the task, the card, the PR body, the
  forced review or the stats reads `shadow`: they read `hits` only.
  `scripts/watchpoint-question-replay.ts` asks the questions over a project's Done runs for hand labelling.
- `coverage.ts` counts what each watchpoint covers in a project's checkout, with no model (`GET /projects/:projectId/watchpoints/coverage`; `GET /settings/watchpoints/coverage` sums the active projects' counts for the builder's list). `coverageOf` is the pure rule: the tracked files (`Git.survey`) its globs match and, with `lines`, those whose whole text matched a pattern and was read in full (no verdict means it wasn't read: too large or binary; a cut line doesn't count). The text comes from `Git.surveyTexts`, is turned into an all-added patch and goes through the same `readLineVerdicts` worker and 5 s deadline as the diff scan; a worker that dies or times out leaves the watchpoint `unreadable`. Reads are bounded (`MAX_LINE_FILES` per watchpoint, `MAX_TOTAL_FILES` and `MAX_TOTAL_BYTES` in all, each file read once): a watchpoint the bounds leave partly unread is `unreadable`, never counted low. Globs count at once; line counts run in the background and a request in the meantime answers `counting`. A count is kept in memory per project (the last three HEADs) and the watchpoint's globs and lines, concurrent asks share one run, and `coverage-triggers.ts` warms them, debounced, on `ProjectCreated` and `CommitRecorded` (as `hazards/triggers.ts` does) and emits `watchpoint.coverage_landed` (entity `watchpoint_coverage`) when a count lands, which the desktop refetches on. `coverageSubjects` is the applying list plus each starter it doesn't hold.
- `knowledge.ts` (`watchpointPrinciples`) resolves a watchpoint's `knowledge` topic keys: the current non-belief principles whose `topicKey` is the key or starts with `key.`, the most specific scope for the task's areas (`mostSpecific`), newest first, at most five. The runner resolves them once per step and `brief.ts` takes them for the build and review briefs.
- `hits-after.ts` (`watchpointHitsAfter`) reads the whole change's file counts first (a zero-byte read), matches on
  those (and, for line watchpoints, on the scan above), then reads only the matched files' text (`diffOfRanges` with `paths.only`) and splits it per file
  (`split-patch.ts`, which reads git's headers; diffs here are read without renames). It matches on the
  file list, never on the capped patch, so a watchpoint file past any cap is still a hit; one whose text was cut is kept
  with `clipped: true`. It throws when git can't be read: the runner turns that into a row with `skipped`.
  `WATCHPOINT_HIT_SOURCES` is the list of ways to find hits (the glob matcher); the runner adds
  `evalDefinitionSource` (`eval-definition-source.ts`) per run: a changed file that is a recorded suite's
  `definitionPaths` is a hit on the watchpoints covering it, or on the `evals` starter, carrying `evalDefinition`
  (the classification from `evals/definition-change.ts`). A file both sources find keeps the eval account.
  `recordWatchpointReading` emits `eval.definition_changed` per such file whose classification is new to the run's
  newest earlier reading; with no watchpoint covering the file there is no hit and no event.
- The runner calls it after a passing gate (`watchpointReadingAfter` in `runner.ts`), beside `acceptanceAfter`, and in
  `finishWithoutGate`. The base is read again after the gate (its base update moves it). The change is the run's own commits (`runCommits`), so in a copy other tasks share, their commits are not read. A Review or QA step in such a copy (`sharesBatchWorktree`) is briefed with the same commits as the change under review (`changeUnderReviewBrief`), the rest of the branch out of scope. The row is written in the
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
- `card.ts`: an ask hit raises the Look card (`raiseWatchpointCard`: one live card per workstream, a second reading updates it; its detail is only the watchpoints' keys and labels, so it reads the hunks live from `GET /workstreams/:id/watchpoint-hits`; a watchpoint an answered Look card of the workstream named is not asked again in the same run, while one 10db withdrew is), and a show hit posts one `watchpoint:<workstreamId>` notice ("<task> touched <labels>"), both inside the write that records the reading (`announceWatchpointReading`), so an acceptance send-back writes neither. `watchpointReadingAfter` runs before `reviewForcedAfter` in `verify` and `finishWithoutGate`; when nothing else forces a review, `watchpointReviewReason` ("a watchpoint asks for you: <labels>") is the forced reason, and `withSafetyNet` adds a Review on a Light task. The card is never a run's question: `settle`, `deliver` (straight to Resolved) and recovery skip it. `applyWatchpointAnswer` runs in the answering write (`onWatchpointAnswer`): Looks right does nothing; Send back needs a note (`InboxAnswerRefused`) and files a Ready follow-up (`insertWatchpointFollowUp`). `GET /projects/:projectId/watchpoints/stats` is `watchpointStats` (`packages/db`): per watchpoint the last 30 days' tasks (newest reading per workstream), cards and waved cards (answered Looks right with no note); noisy is `isNoisyWatchpoint`, the card-type bounds.
