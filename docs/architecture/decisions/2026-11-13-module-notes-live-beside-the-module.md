# A module's notes live in an AGENTS.md beside the module, not in its app's file

- **Date:** 2026-11-13

## Decision

`apps/daemon/AGENTS.md` and `apps/desktop/AGENTS.md` keep what crosses modules: the app's own rules, the
dependency order, an index of the modules, and the notes that name no one module. Each module's notes moved,
word for word, into an `AGENTS.md` beside its code: `apps/daemon/src/<module>/AGENTS.md` (39 modules) and
`apps/desktop/src/views/<view>/AGENTS.md` or `apps/desktop/src/<module>/AGENTS.md` (10). A contributor reads
the root file and the `AGENTS.md` of every directory they touch, and writes a note in the nearest one.

`tests/repo/src/agent-docs.test.ts` checks that every chain of `AGENTS.md` files, from the root down to any one
of them, fits in Codex's `project_doc_max_bytes` (`.codex/config.toml`).

## Why

The daemon's file had grown to 196 KB of single-paragraph bullets, one or more per module, and the desktop's to
70 KB. Codex joins the `AGENTS.md` files from the root down to its working directory and cuts the text at
`project_doc_max_bytes` (128 KiB here): with the root file, the daemon's chain was about 207 KB, so a Codex
session in the daemon never saw the end of it, its Tests section included. Claude Code agents read the whole
file cold to change one module, and every pull request that described its change there conflicted with every
other one on a main merge; one implementer hung editing it. After the split the daemon's file is 17 KB, the
desktop's 11 KB, and the largest module file (`delivery/`) 31 KB, read only by work in `delivery/`.

Turned down:

- Module READMEs. The rule to read "the `AGENTS.md` of every directory you touch" already makes an agent read a
  module's `AGENTS.md`, and Codex loads it from that directory, so no rule or loader changes.
- Rewriting the notes shorter in the same change. The move is word for word (a test of word counts showed none
  lost) so a session with an edit in flight can find its paragraph and move it; tightening the text is later
  work, module by module.
