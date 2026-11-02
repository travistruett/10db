# A lane's Read of its own background command's output runs without a card

- **Date:** 2026-11-01
- **Amends:** `2026-10-31-lanes-run-in-auto-mode-inside-the-sandbox.md`

## Decision

`judgeRead` in `apps/daemon/src/sandbox/file-access.ts` returns `allowed` (so `readAsk` is null) for a file
directly in the session's own Claude Code task output directory:
`<own temp dir>/claude-<daemon uid>/<slug of the checkout>/<provider session id>/tasks/<file>`, by real
path, for each spelling of the temp dir and the checkout. The slug is the checkout's path with every
character but an ASCII letter or digit made `-`; a slug over 200 characters, which Claude Code shortens and
hashes, is not derived, so it asks. The file need not exist yet.

Another session's directory, a lookalike under another uid or slug, a file in a subdirectory, the directory
itself, no provider session id, and a link or `..` that leaves the directory (judged on the real path, both
readings) all still ask. Protected paths are checked first and stay protected.

## Why

On 2026-11-01 the guard-retirement lane raised "Allow Read?" for its own `tasks/bcjfopcut.output`. The file
is read-only data its own background command wrote, inside its own temp dir. The Monitor case had this
check (#182) until the auto-mode change retired the Monitor grammar; the Read tool never had it.
