# Linear updates wait for a sign-in on the project's own account instead of failing or borrowing another

- **Date:** 2026-11-25
- **Amends:** `decisions/2026-11-22-the-linear-reporter-is-10dbs-own-errand-with-its-own-guard.md`

## Decision

The Linear reporter keeps running on the project's account. When that account's agent can't reach Linear, the
updates are held, not failed:

- An account can't reach Linear when its sign-in row says it definitely has no Linear, or when a reporter
  session finished its turn without one Linear call the reporter's rule allowed. That second case also covers
  a session that reported a failure before calling Linear.
- A held update is a pending `linear_posts` row with `tries` 0 and a `lastError`. Holding it spends no try,
  so it never fails for good while it waits.
- A held update is due again after `HOLD_RETRY_MS` (30 minutes). Until then the account counts as signed out,
  in memory, so the project's other tasks wait without starting a session.
- Three things wake a project and make its held updates due straight away: the project moving to another
  account, an MCP sign-in on its account turning signed in, and Linear being switched on for it (Connect
  Linear does this).
- The project's one "Linear Updates Need You" card counts held updates first. Its first line names the account
  that needs a Linear sign-in and how to sign in, which depends on the harness (`linear/sign-in-needed.ts`).

## Why

In the Ampsio pilot (2026-11-25) a project moved from its Codex account to a Claude plan for one task.
Claude Code left out the Linear server that wasn't signed in, so the reporter's session had no Linear. Each
run ended without recording, used up one of its five tries, and the card said only "the session ended without
recording". The updates went out only after the project moved back.

Alternatives turned down:

- **Borrowing another account that is signed in to Linear.** A project's account is the builder's billing
  line, so 10db doesn't quietly run on a different one.
- **Reading which servers need a sign-in from each session adapter.** Claude Code and Codex report it
  differently, and today they only put it in the prompt. Counting the reporter's own allowed Linear calls
  works the same on every provider.
- **A held column.** It needs a migration, and only one open pull request may add migrations at a time. A held
  row can be told apart from the existing columns, because every other way to fail a row also counts a try.
