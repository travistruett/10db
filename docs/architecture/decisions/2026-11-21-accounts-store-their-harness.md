# An account stores the harness that runs it, and the Gateway kind is removed

- **Date:** 2026-11-21

## Decision

- The agent harness that runs an account's sessions (`claude` or `codex`, the adapter ids already stored on
  sessions) is stored on the account as `settings.harness`; absent means the first harness its kind allows
  (`HARNESSES_OF_KIND`, `harnessOf`). It is the only Claude-Code-or-Codex question: nothing derives it from the
  kind, and credential rules (what an account bills, how it signs in, what it is identified by) stay on the kind.
  A kind with no harness cannot be a project's account or backup (`requireHarness`).
- The Gateway account kind is removed: `AccountKind.Gateway`, its settings, launch and takeover branches,
  identity rule, free-text tier fields and every other exception. A database that still holds a Gateway account
  refuses to start the daemon with a message naming it (`refuseGatewayAccounts` in `packages/db`); nothing is
  converted or deleted.

## Why

- A second harness later is a row in a table instead of a hunt for every place the kind stood for "runs
  Codex", which is how an OpenRouter account could launch as the wrong agent.
- The builder's database held no Gateway account when it was read, and 10db is alpha with no users, so removing
  the kind costs nothing now and every exception for it was code with no reader. A startup refusal naming the
  account tells anyone who still has one what to remove, where a later parse failure would not.

Spec: `docs/superpowers/specs/2026-11-21-10db-accounts-harnesses-and-sign-ins-design.md`, "Accounts and
harnesses" and "Data".
