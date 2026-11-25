# apps/daemon/src/watchpoints

- `watchpoints/` matches a finished run's change against the builder's watchpoints
  (`docs/superpowers/specs/2026-11-25-watchpoints-design.md`). The shapes, `effectiveWatchpoints` and the starters are
  in `@10db/contracts` (`watchpoints.ts`, `watchpoint-hit.ts`); the lists are app settings read through
  `readYourWatchpoints` and `readProjectWatchpoints` (`packages/db`). Slice 1 has loudness `show` only.
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
- The pull request's "For you" section is built from the PR's runs' newest readings (`delivery/pr-watchpoints.ts`,
  `delivery/pr-text.ts`, `ship.ts`); `GET /workstreams/:id/watchpoint-hits` is `delivery/watchpoint-hits.ts`.
