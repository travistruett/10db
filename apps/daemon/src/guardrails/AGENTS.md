# apps/daemon/src/guardrails

- Two pure rule tables, no I/O: `paths.ts` (`GUARDRAIL_PATHS`) and `ownership.ts` (`ownershipTest`).
- `GUARDRAIL_PATHS` is ordered and the first matching row is a file's one kind, so a specific file (the git guard,
  `.claude/settings.json`) is listed before the `.claude/**` row. Reordering or dropping a row changes what a pull
  request holds and what a stray card says; `guardrails.test.ts` pins the order.
- Claude Code's own bookkeeping (`isInsideClaudeCodeBookkeeping`) matches no row.
- A guardrail path hit is a fact: `ownershipTest` keeps `BuilderOwns.Guardrails` for it whatever a judge reading
  says. A judge reading can add an owner, never take one away.
- `watcher/strays.ts` `isGuardrailPath` delegates here and adds the paths this list leaves to the stray card alone
  (secrets, git internals, `AGENTS.md` and `CLAUDE.md`, lefthook's config in a subfolder).
