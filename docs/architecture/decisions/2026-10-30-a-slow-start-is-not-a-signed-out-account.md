# A session start that gets no account is retried once before the account is called signed out

- **Date:** 2026-10-30
- **Amends:** `decisions/2026-10-30-lane-and-gate-priority.md`

## Decision

- **The wait.** A session start waits 30 s for Claude Code to report its account (`BILLING_PREFLIGHT_MS` in
  `sessions/claude-adapter.ts`), up from 15 s. The identity probe (`probeAccount`), which does not run at
  lane priority, keeps its 15 s.
- **The retry.** When a start gets no account (no answer in time, or `accountInfo()` rejected), the adapter
  closes that Claude Code and starts the session again, once (`START_ATTEMPTS = 2`, `startWithRetry`). The
  first start emits no `ended` event, so the runner sees one session; a message sent meanwhile goes to the
  second start, and a stop in between ends the session as stopped without a second start. Only the second
  start's silence is refused: a subscription account reads as signed out and is paused, any other kind
  fails the step as before. A truly signed-out account is therefore noticed after about a minute (2 x 30 s).
- **The card.** The refusal says how many starts got no account and what they printed on stderr: `Claude Code
reported no account within 30 s on each of 2 starts for account "Claude plan", which looks signed out.
Claude Code printed nothing` (or `printed: "…"`, one line, the last 300 characters of each distinct print,
  without colour codes). Nothing it printed reaches the log beyond its length.

## Why

Lanes run at background priority (`taskpolicy -b`), so on a busy Mac (load average near 14) a start can take
longer than 15 s while the account is signed in. On 2026-10-30 two review sessions of one workstream failed
that way, and each paused the whole account as signed out, stopping every lane until the builder answered
Resume. One slow start is not evidence about the account.

Turned down: only raising the wait (a longer wait still pauses everything on the first slow start, and the
wait that is long enough for a loaded Mac is long for a real sign-out); retrying in the runner (it would
need a new session outcome and a per-workstream count across states, for a failure that happens before
the prompt and leaves nothing to resume); a retry of `accountInfo()` on the same process (a start that is
stuck stays stuck, and the second wait would be the same process's longer wait, not a new start).
