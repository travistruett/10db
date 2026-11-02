# Every lane question offers "Park the task", and answering it stops the run

- **Date:** 2026-11-02
- **Amends:** `decisions/2026-10-31-notices-not-cards.md` (a cancelled run keeps one notice, the parked one)

## Decision

- **The daemon adds the choice, not the lane.** `InboxService.ask` appends `PARK_TASK_OPTION` ("Park the task",
  `packages/contracts/src/entities.ts`) to every `question` card, after the lane's own options, unless the lane wrote an
  option with that label already. It covers `ask_human` and the `AskUserQuestion` tool alike. The lane's own limit of
  four options is unchanged; the card may show five.
- **Answering it parks.** `InboxService.answer` closes the card as `RESOLVED` with the answer (the same direct close a
  flag card gets) and does not hand it to the waiting session. Then `createParkAnswers`
  (`apps/daemon/src/inbox/park-answer.ts`) does, for every run the card targets that has not ended:
  1. `runner.cancel`: the session stops and the run is `CANCELLED`, as a cancel from the Board does, so no review
     round follows and nothing sends the work back;
  2. moves the task to the project's Icebox column (the first column when it was renamed away, a new Icebox when the
     project has none). A parked task never launches, so it stays out of the lane until the builder moves it back;
  3. sets the run's notice `parked-answer`: the question, the card's body, and the builder's answer and note.
- **The drawer shows it.** A cancelled run's notices are stale and the drawer hides them, except `parked-answer`
  (`taskNotices`). `clearWorkstreamNotices` (a daemon start) keeps it too, since it records an answer, not a wait.
- **Only the one label parks.** A lane's own option, however it is worded ("defer", "make no change"), is delivered to
  the lane as before. Guessing at the lane's words would park tasks whose option meant something narrower.

## Why

On 2026-11-02 the lane for a task needing live GitHub captures asked the builder, and three cards answered "defer /
make no change and end this step" in 15 minutes. Each answer ended the implement step with no change, the review step
sent it back because the criteria were unmet, and the lane asked the same question again. Only the third card happened
to offer "Park the task". Whether the builder could stop the loop depended on how the lane worded its options.

Parking through the existing cancel keeps one way to end a run for the builder. Putting the choice in the inbox service
rather than in the tool handler covers every path that raises a question. A failure to stop or move is logged and the
card keeps its answer: the builder can still cancel or move the task by hand. If a task that others already started
on depends on it, the move is refused (`moveTask`); the run is still stopped and the notice written.
