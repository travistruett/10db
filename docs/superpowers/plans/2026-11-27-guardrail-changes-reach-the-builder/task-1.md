# Task 1: the guardrail path list and the ownership test, as rule tables

Read the index's Brief and Global Constraints first. Size: Core (a pure rule table that permissions rest on).
Nothing new calls these yet, except the watcher's existing check.

**Files:**

- New `apps/daemon/src/guardrails/paths.ts`, `ownership.ts`, `index.ts` (the entry point), `AGENTS.md`.
- New `apps/daemon/src/guardrails/guardrails.test.ts`.
- `apps/daemon/src/watcher/strays.ts`: `isGuardrailPath` delegates.

**Implements** (index, Interfaces): `GuardrailKind`, `GuardrailRow`, `GUARDRAIL_PATHS`, `guardrailOf`,
`guardrailHits`, `OwnershipQuestion`, `OwnershipReading`, `ownershipTest`.

**The rows, in order.** A file has one kind: the first row that matches. Paths are relative to the repository
root, with `/` separators. A directory row matches the directory itself and everything under it.

| #   | Path                                                                                | Kind             | Label              | Why this kind                                                        |
| --- | ----------------------------------------------------------------------------------- | ---------------- | ------------------ | -------------------------------------------------------------------- |
| 1   | `.claude/hooks/**`                                                                  | GitGuard         | git guard          | `git-guard.mjs` and what it loads                                    |
| 2   | `.codex/rules/**`                                                                   | CodexRules       | Codex rules        | Codex's side of the same guard                                       |
| 3   | `.claude/settings.json`                                                             | StandingApproval | standing approvals | Its committed `permissions.allow` list is what runs unasked          |
| 4   | `.claude/settings.local.json`                                                       | JudgePolicy      | judge policy       | The machine's permission-mode and auto-mode overrides: who judges a call |
| 5   | `.codex/config.toml`                                                                | SandboxProfile   | sandbox profile    | `sandbox_mode`, `approval_policy`, `[sandbox_workspace_write]`       |
| 6   | `.10db/mcp-hosts.json`                                                              | TrustGrant       | trust grants       | The hosts a repo MCP server may reach                                |
| 7   | `.mcp.json`                                                                         | McpServers       | MCP servers        | Spec §1 row 3 names it                                               |
| 8   | `.git/hooks/**`, `lefthook.yml`, `lefthook-local.yml`, the rest of `.claude/**` and `.codex/**` | Hooks | hooks              | What a commit, a push or a session start runs                        |
| 9   | `.github/workflows/**`, `.github/rulesets/**`                                       | CiWorkflows      | CI workflows       | What must pass before a merge, and who may merge                     |

Notes on the rows:

- Row 3: `.claude/settings.json` also wires the hooks (`hooks.PreToolUse` runs the git guard). It keeps one kind;
  the card shows the diff either way.
- Row 5: `.codex/config.toml` also declares `[mcp_servers.*]`. One kind, as above.
- Check rows 3 to 5 against the files' real keys when building (Claude Code's settings schema; Codex's config
  reference). If a file's main job differs from its row, call `report_deviation` and say which.
- Row 8 excludes Claude Code's own bookkeeping: a path for which `isInsideClaudeCodeBookkeeping(rel)` is true
  matches no row, as `isSensitivePath` has it today. Lefthook's other accepted names (`.lefthook.yml`, the `.yaml`
  spellings) match row 8 too, **at the repository root only**: lefthook reads one config from the root, so a nested
  `sub/lefthook.yml` does not hold a pull request. The stray check still treats it as a guardrail (next section),
  so it stays a card and does not become a notice.
- Judge policy, trust grants and standing approvals proper live in 10db's database (index, call 2). Rows 3, 4 and
  6 are the checkout files that grant the same things.

**`watcher/strays.ts`.** `isGuardrailPath(rel)` becomes `guardrailOf(rel) !== null`, or one of the paths call 1
keeps: `isSensitivePath(rel)` (which covers `.env*`, `.git/config`, `.git/info`), or an `AGENTS.md`, `CLAUDE.md` or
lefthook basename (`GUARDRAIL_BASENAME` stays, so `lefthook.yml` and its spellings are a guardrail in any folder,
as today). Its answers do not change for any path it is asked about today except the root `lefthook-local.yml`,
which becomes a guardrail through row 8 (a nested `lefthook-local.yml` stays a notice). `isSensitivePath` is not
changed.

**`ownershipTest`.** Pure, with no I/O:

- `guardrailHits > 0` puts `BuilderOwns.Guardrails` in `owns`, whatever `judged` holds.
- A reading with `yes` and `confidence >= floor` adds its owner: `OneWayDoor`, `ProductAndTaste`, `Promise`.
- A reading of no, at any confidence, removes nothing.
- A null reading, or one below the floor, goes in `doubt` and adds nothing to `owns`. Stage 11 decides what doubt
  does when the test acts (spec §2, "Doubt goes up"); here nothing reads it.

Tests 1, 6 and 7 of spec §1 (money, your hands, out of moves) are not inputs yet: their callers exist elsewhere
and join when the test acts.

**State-table rows:** none of the index's tables; this task is the two tables above.

**Test (one new file, pure).** `guardrails.test.ts`:

- one path per row answers its kind and label, and row order holds (`.claude/hooks/x` is GitGuard, not Hooks;
  `.claude/settings.json` is StandingApproval, not Hooks);
- `src/app.ts`, `AGENTS.md`, `.env` and a Claude Code bookkeeping path answer null;
- `ownershipTest` with one guardrail hit and all three readings no at confidence 1 still owns `Guardrails`; a yes
  below the floor is doubt, not ownership.

Show it red before `paths.ts` exists.

`Value: protects=the guardrail path list and the rule that a path hit is the builder's whatever the judge reads;
fails_when=a row is dropped or reordered so a guardrail file answers null or another kind, or a judge no removes a
deterministic yes; why_new=permissions (a pure rule table); no_claim=that any caller holds a pull request or
raises a card`.

**Spec:** "1. What only the builder owns", row 3; "2. Who decides", "The ownership test" and "Doubt goes up".
