# Watchpoints S3a: line patterns

**Size: Feature.** One implementer builds it end to end, then one code review that blocks only on bugs. The spec is
`docs/superpowers/specs/2026-11-25-watchpoints-design.md` (§ A watchpoint, `lines`; § The library). S1 and S2 are on
main. S3 is split: this is S3a. S3b (the judge question in Shadow, the Design principles and Auth starters) gets its
own plan after this merges.

## Brief

**What changes for you.**
- A watchpoint can have **line patterns**: regexes over the added and removed lines. With patterns, a file its paths
  cover counts only when one of its changed lines matches. Without them, nothing changes.
- The library gains **Indexes** (migration paths, plus index DDL lines) and **Model choice** (any file, plus model-id
  lines). Both are show. They are offered under "Add from library", and never added to your list for you.
- The drawer gets a **Lines** box, with one pattern per line. Patterns are case-insensitive.

**What it buys.** You can watch a change that no path names, like a model id swapped in ordinary code, or an index
added inside a migration.

**What could go wrong, and how we'd know.**
- *A slow or runaway pattern.* Each line is cut at 2,000 characters before it is tested, and the scan reads at most
  512 KB of a change. A pattern that doesn't compile is refused when it is saved.
- *A missed line in a huge change.* A file past the scan budget, or cut by the per-file cap with no matching line in
  the text read, can't be shown clear. For an **ask** or **hold** watchpoint it counts as a hit, kept clipped, so a
  huge change can't slip an index or a model id past a watchpoint you asked to judge. A **show** watchpoint doesn't
  count it: Model choice on `**` would flag every file of a big change, and a miss costs a line in For You, not a block.
- *Model choice is noisy.* It matches model ids in tests and fixtures too. The last-30-days column shows this, and you
  can narrow its paths.

**Calls you might disagree with.**
- Patterns are always case-insensitive (SQL DDL is written either way). There is no per-pattern flag.
- A new install still starts with the six S1 starters. Indexes and Model choice wait in the library.

**Needed from you:** nothing.

## Provider parity

The same on every provider. The daemon does the matching; no model is asked.

## Parts, in build order

1. **Contracts** (`packages/contracts/src/watchpoints.ts`):
   - `WatchpointLinePattern`: a string of 1 to 200 characters that compiles as `new RegExp(source, 'i')` (a `refine`
     with a message naming the pattern). Add `lines: z.array(WatchpointLinePattern).max(16).default([])` to
     `Watchpoint`, so stored lists parse unchanged.
   - `sameWatchpoint` compares `lines`. The revision literals and every starter get `lines: []`.
   - The new starters go in `STARTER_WATCHPOINTS`, at show:
     - **Indexes**: the migration globs; lines `\bcreate\s+(unique\s+)?index\b`, `\bdrop\s+index\b`,
       `\b(unique)?index\s*\(`.
     - **Model choice**: `**`; lines for model ids: `\bclaude-[a-z0-9][\w.-]*`, `\banthropic\.claude`,
       `\bgpt-\d[\w.-]*`, `\bo[134]-(mini|pro)\b`, `\bgemini-\d[\w.-]*`, `typesafe/jev`.
     - Guidance names what to check: the index locks or rebuilds a big table; the model is the one intended, on
       every provider, with its cost.
   - `INITIAL_WATCHPOINTS` is the six S1 starters by key, and `readYourWatchpoints` returns it when nothing is
     stored (`packages/db/src/store/watchpoint-settings.ts`).
   - `changedLines(patch)` is pure. It returns the `+` and `-` lines of a unified diff, without the `+++`/`---`
     headers or the marker, each cut at 2,000 characters.
2. **Daemon matching** (`apps/daemon/src/watchpoints/`):
   - `matchWatchpoints` stays pure. A watchpoint with `lines` covers a file only when its globs cover it **and** one
     of `changedLines(file.patch)` matches a pattern. A clipped file is judged on the text that was read; an ask or hold watchpoint also counts a clipped file with no matching line (fail closed).
   - `lineCandidates(files, watchpoints)`: the glob-covered paths of watchpoints that have lines.
   - `watchpointHitsAfter`: after the counts read, if there are line candidates, read their text once, at
     `WATCHPOINT_LINE_SCAN_BYTES` (512 KB), and split it with `splitPatch` at the per-file cap. Then match with that
     text. Reuse those sections for the matched files' hunks, so no file is read twice. Glob-only watchpoints behave
     exactly as now.
   - `brief.ts`: a line watchpoint's build-brief line says "changed lines matching: <patterns>". The notes
     instruction asks for a reason only on files whose matching lines changed.
3. **Desktop** (`views/settings/watchpoint-drawer.tsx`):
   - Add a **Lines** textarea after Paths, one pattern per line, with the help text "Optional. Only files whose added
     or removed lines match one of these count. Case-insensitive."
   - A pattern that doesn't compile shows a field error before saving.
   - The table row shows "+ N line patterns" under the paths when there are any.
   - Use Mantine and theme tokens only, and check dark and light.
4. **Docs**: update the `AGENTS.md` notes beside the watchpoints module and settings. Change the spec's § Scope row
   S3 into S3a and S3b. Remove the brief's line about Model choice not being offered yet.

## Tests (only these)

- **Extend the rule table in `apps/daemon/src/watchpoints/match.test.ts`:**
  - a line watchpoint hits on a matching `+` or `-` line;
  - it doesn't hit on a context line or a `+++` header, nor on a glob-covered file with no matching line;
  - matching is case-insensitive;
  - Indexes hits `CREATE UNIQUE INDEX` in a migration, and Model choice hits `claude-sonnet-5-5` in `src/x.ts`;
  - an old stored watchpoint with no `lines` parses with `[]`.
  - Prove it red first. This adds rows, not a new file.
- No new e2e and no other tests. The lead's browser QA covers the wiring.

## Done

- Typecheck, lint and the related tests pass. Run the watchpoints, runner and ship test files as well.
- `make precheck` exits 0.
- Then the lead runs browser QA, a Fable review, and a PR with auto-merge.
