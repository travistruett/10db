# A sandboxed lane's Monitor of its own task output runs without a card

- **Date:** 2026-10-30

## Decision

In a sandboxed lane the broker (`apps/daemon/src/inbox/permission-broker.ts`) allows a `Monitor` call
without a card when all of these hold:

- its `command` passes the checks a Bash command does (no hazard, nothing unread, not escalated);
- its `command` is inside a small grammar (`inbox/monitor-command.ts`): `until`/`while`/`if` loops and
  `done`/`fi`, and the programs `[`, `test`, `grep`, `cat`, `head`, `tail`, `wc`, `sleep`, `echo`, `true`
  and `false`, with plain words, no expansion, substitution, glob, background job, subshell or
  here-document, and no redirection but `2>&1`, `>/dev/null` and `2>/dev/null`;
- every file that command names is an absolute path to a file directly in the session's own task output
  directory, `<own temp dir>/claude-<uid>/<slug>/<provider session id>/tasks/<file>`, by its real path
  (`isOwnTaskOutputPath` in `sandbox/file-access.ts`: a link or `..` that leaves it, a missing session id
  and another session's or lane's directory all fail), and a `grep`, `cat`, `head`, `tail` or `wc` names a
  file unless a pipe feeds it.

Any other `Monitor` call raises the same card as before.

## Why

On 2026-10-30 the orchestrator answered about ten "Allow Monitor?" cards, all `until [ -s <file> ]` or
`until grep -q … <file>` loops over a file in the lane's own task output directory, then a grep of it.
Each reads only the lane's own temp dir. The grammar is closed rather than a deny list, so a program 10db
cannot name, a write or a read elsewhere is asked about. The lane can't write its own `tasks` directory
(the sandbox profile denies it), so the files are Claude Code's own output of the lane's background
commands.
