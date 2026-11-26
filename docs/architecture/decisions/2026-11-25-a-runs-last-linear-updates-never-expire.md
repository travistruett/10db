# A run's last Linear updates never expire, and the builder can retry the rest from the card

- **Date:** 2026-11-25
- **Amends:** `decisions/2026-11-25-linear-updates-hold-on-the-projects-own-account.md`,
  `decisions/2026-11-22-the-linear-reporter-is-10dbs-own-errand-with-its-own-guard.md`

## Decision

- **Lasting rows.** A `verdict` or `ended` update is never failed for good by its tries. It backs off as any
  row does, up to the 6-hour cap, and is retried at the cap until it posts or the builder dismisses it. Every
  other kind still fails at `MAX_TRIES` (5).
- **Retry.** The project's "Linear Updates Need You" card offers Retry before Dismiss. Retry makes every
  failed, undismissed row of the project pending again, with no try spent and no error, due now. It makes every
  row waiting on a retry (pending, tries > 0) due now too. It then wakes the reporter. Withheld, dismissed,
  recorded and held rows are left as they are. The card closes on the answer and comes back at once if any row
  still needs the builder, such as a withheld one.
- **Dismiss.** Dismiss marks the failed and withheld rows seen, as before. It also stops the rows waiting on a
  retry: they become failed and dismissed. This is how a lasting row ends short of posting. A held row (tries 0)
  is left to its sign-in.
- **Sign-in holds.** Two more cases hold a row instead of spending a try:
  - 10db's own write is turned away for its sign-in: an MCP `UnauthorizedError`, or HTTP 401 or 403 from
    Linear's server (`LinearWriteError.signedOut`).
  - An agent run ends its last message with the line `Linear: not signed in` (`SIGNED_OUT_LINE`). The brief
    tells the agent to write that line when Linear answers that it is not signed in or asks it to sign in.
- **Withheld means one row.** A `save_comment` the guard withholds for a secret withholds only the post that
  comment was built for. The run's other rows go on.
- **No waiting behind a backoff.** A new row is due `REPORT_DELAY_MS` (30 s) after its event, whatever the
  task's other rows are waiting on.

Every part runs in the store, the reporter's guard, its brief and its settle, none of which depends on the
provider. Claude and Codex accounts behave alike.

## Why

Fable's audit of the Ampsio pilot (2026-11-25) read 86 `linear_posts` rows. Five failed at 5 tries and were
dismissed, because the card offered nothing else:

- Four said "Linear is not signed in to this session": AMP-137's `verdict` and `ended`, and AMP-143's
  `run_started` and `waiting`. AMP-137's last comment on Linear still reads "run started, attempt 3".
- One, AMP-6's `waiting`, said "No write of this run was refused for that pattern".

The settle also marked every open row of a run withheld when the guard withheld any one write. AMP-134 also got four comments in one second, 47 minutes late, because each new row waited behind an older
row's backoff.

Partners read Linear as the record of the work, so the last word of a run is the update that must not be lost.
Dismiss stays the builder's way to end it.

A wrong `Linear: not signed in` from an agent costs one hold: no try is spent, the row waits 30 minutes, and the
account counts as signed out for 30 minutes. The card names the account, so the builder sees it. A
`postToolUse` hook that reads Linear's own answer would catch this without the agent's word, but only Claude
has one. That would break provider parity, so it was turned down.
