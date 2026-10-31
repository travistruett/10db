# A sandboxed lane's Monitor of its own task output runs without a card

- **Date:** 2026-10-30

## Decision

In a sandboxed lane the broker (`apps/daemon/src/inbox/permission-broker.ts`) allows a `Monitor` call
without a card when all of these hold:

- its input has no key but `command`, `description` and `timeout_ms`. Monitor's `ws` would open a
  WebSocket from Claude Code's own process, outside the sandbox's network proxy and its per-host cards,
  and nothing shows Claude Code refuses `ws` beside `command` before it asks the broker; a key a later
  Claude Code adds asks too;
- its `command` passes the checks a Bash command does (no hazard, nothing unread, not escalated);
- its `command` is inside a small grammar (`inbox/monitor-command.ts`): `until`/`while`/`if` loops and
  `done`/`fi`, and the programs `[`, `test`, `grep`, `cat`, `head`, `tail`, `wc`, `sleep`, `echo`, `true`,
  `false` and `:`, with plain words, no expansion, substitution, glob, background job, subshell or
  here-document, and no redirection but an unquoted `2>&1`, `>/dev/null` and `2>/dev/null`. Quotes are
  read as the shell reads them (a `'` inside double quotes is literal), and a `$`, backtick or `\` outside
  single quotes, or a `<` or `>` inside quotes, makes the command unread;
- every file that command names is an absolute path to a file directly in the session's own task output
  directory, `<own temp dir>/claude-<daemon uid>/<slug of the checkout>/<provider session id>/tasks/<file>`,
  by its real path (`isOwnTaskOutputPath` in `sandbox/file-access.ts`). The uid and slug are derived
  exactly: the slug is the checkout's path with every character but an ASCII letter or digit made `-`, as
  Claude Code names it, and a slug over 200 characters, which Claude Code shortens and hashes, is not
  derived, so it asks. A link or `..` that leaves the directory, a missing session id, another session's
  or lane's directory and a lookalike under another uid or slug all fail. A `grep`, `cat`, `head`, `tail`
  or `wc` names a file unless a pipe feeds it.

Any other `Monitor` call raises the same card as before.

## Why

On 2026-10-30 the orchestrator answered about ten "Allow Monitor?" cards, all `until [ -s <file> ]` or
`until grep -q … <file>` loops over a file in the lane's own task output directory, then a grep of it.
Each reads only the lane's own temp dir. The grammar is closed rather than a deny list, so a program 10db
cannot name, a write or a read elsewhere is asked about. The lane can't write its own `tasks` directory
(the sandbox profile denies it), so the files are Claude Code's own output of the lane's background
commands. That holds only for the exact directory: the lane can make and write a lookalike such as
`<own>/claude-0/x/<session id>/tasks` in its own temp dir, and swap a file there for a link between the
check and the read, so only the derived uid and slug are accepted.
