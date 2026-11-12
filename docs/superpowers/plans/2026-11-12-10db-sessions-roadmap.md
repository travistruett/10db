# 10db Sessions: roadmap and execution

> **For agentic workers:** this is the index. Each milestone that has a plan file runs from that file. Milestones
> without one are outlined here and get a plan written once their predecessors have merged, so the plan cites
> code that exists. Coordinate the build with the `coordinating-builds` skill.

**Spec:** `docs/superpowers/specs/2026-11-11-10db-sessions-design.md` (v3), with
`docs/superpowers/specs/2026-11-11-10db-sessions-ui.md`.

**Goal:** one conversation store and delivery library, one engine for interactive conversations, one adapter seam
with capabilities, one conversation UI kit, and the Sessions screen on top of them.

**Decision file paths.** Each plan names a decision file it creates as `docs/architecture/decisions/./<name>`. The
`./` lets the repo's citation test (`tests/repo/src/architecture-docs.test.ts`) pass before the file exists. The path
is valid as it is, so drop the `./` only when citing the file from another document.

## Milestones

| # | PR | Plan | Needs | Branch |
| --- | --- | --- | --- | --- |
| M1 | Foundations: Mantine 9.8, Codex generated types, `gcp` fix | `2026-11-12-10db-sessions-m1-foundations.md` | — | `feat/sessions-m1` |
| M2a | One Claude core, one fake | `2026-11-12-10db-sessions-m2a-claude-core.md` | M1 | `feat/sessions-m2a` |
| M2b | `AgentAdapter.open`, capabilities | `2026-11-12-10db-sessions-m2b-adapter-seam.md` | M2a | `feat/sessions-m2b` |
| M2c | Streaming events, `ToolCallView`, hunks | `2026-11-12-10db-sessions-m2c-streaming.md` | M2b | `feat/sessions-m2c` |
| M3 | Static conversation kit; Plan renders markdown | `2026-11-12-10db-sessions-m3-kit.md` | M2c | `feat/sessions-m3` |
| M4a | Conversation stores and the migration | `2026-11-12-10db-sessions-m4a-stores.md` | M2c | `feat/sessions-m4a` |
| M4b | Explore engine; Plan on it, streaming | `2026-11-12-10db-sessions-m4b-engine.md` | M4a, M3 | `feat/sessions-m4b` |
| M4c | Task threads through the library; Workbench thread on the kit | outlined below | M4b | `feat/sessions-m4c` |
| M5a | Sessions Explore on Claude | `2026-11-12-10db-sessions-m5a-sessions.md` | M4b | `feat/sessions-m5a` |
| M5b | Codex conversations: Explore, and Plan without subagents | outlined below | M5a | `feat/sessions-m5b` |
| M6 | Do it: pass of one, worktree task | outlined below | M4c, M5a | `feat/sessions-m6` |
| M7 | Open in Terminal, Hand Back | outlined below | M5a | `feat/sessions-m7` |
| M8 | Spotlight | outlined below | M5a | `feat/sessions-m8` |
| — | ACP spec, then OpenCode | a spec first (§5.6) | M5a soaked | — |
| M9 | Lane steps as conversations | a spec first (§6.9) | M6, two weeks | — |

**What can run in parallel:**

- M3 and M4a can run in parallel after M2c.
- M5b, M6, M7 and M8 can run in parallel after their dependencies.

**How the build runs:**

- Each implementer works in its own worktree under `10db-worktrees/`.
- Run at most two implementers at once on this Mac. The engine milestones (M4a, M4b, M4c) run one at a time.

## How each milestone runs

1. An implementer per plan. Concurrent-state work (M2a, M4a, M4b, M4c, M6) is taken in small red-first steps, one
   commit per behaviour.
2. **Run it before review:**
   - A UI change gets a click-through and an e2e against the real daemon.
   - A daemon change gets the changed packages' tests, typecheck and lint.
3. **Review:**
   - A `code-reviewer` (opus) reviews the branch.
   - Round 1 lists every finding.
   - Round 2 checks only those findings and what the fixes broke.
   - At most two fix rounds. Non-blocking findings become tasks or QA items.
4. **Gate:** `make gate` once, on the final branch, then the PR.

## Outlines for milestones without a plan yet

### M4c: task threads through the library

- M4a already moved storage, delivery rules 1-4, the intake and pictures into `conversation/`. M4c finishes:
  - rule 5 (read-back and "Send now") for task conversations
  - partial capture for task turns
  - full output on disk for task tool calls
- `thread/` is removed, and its routes move to `/conversations/:id/*`.
- The runner keeps the live session (spec §6.1).
- The Workbench thread UI (`views/workbench/thread*.tsx`, `composer.tsx`, `working-line.tsx`) is replaced by the kit:
  - `ConversationList`
  - `Composer`, with the pass's phase table
  - `WorkingLine`
  - `ToolCallCard`

  Live deltas reach a pass page.
- **Tests that stay unchanged:**
  - `runner/pass-lane.test.ts`
  - `test/crash-recovery.test.ts`
  - `test/workbench-api.test.ts`
  - `e2e/workbench.spec.ts`
- **New tests:**
  - delivery through the library on the real SQLite rung
  - the runner claim test from M2c, kept green
- **Decision:** none new. The M4a and M4b records cover it.

### M5b: Codex conversations

- The explore profile on Codex:
  - a read-only `sandboxPolicy` (named as in `codex-generated/`)
  - `approvalPolicy: 'never'`
  - the project pinned `untrusted`
  - the guard socket judging with the explore rules
  - `ask` routed to the broker
- `startShape` refusal sites removed (research T1 §3 lists seven, plus `shape/chatgpt-refusal.test.ts`, which is
  replaced by a test that Plan runs on Codex and says what it lacks).
- Plan on Codex runs without `agents`. The header notice comes from `capabilities.subagents`.
- A follow-up task on the Board: "Plan's researchers and reviewers on Codex".
- **Tests:**
  - the Codex explore profile options table
  - a guard row for a write attempt
  - the live Codex read-only explore test (opt-in)
- **Decision:** M5b's §14 record, which amends the ChatGPT decision.

### M6: Do it

- `POST /chats/:id/do-it {place}`:
  - It seals the Explore conversation (state `sealed`).
  - **Here:** it opens a pass of one, with a synthetic "Whole project" page over `WHOLE_REPOSITORY_GLOBS`. The
    folder refusals are the pass's.
  - **Worktree:** it creates an ordinary task with worktree placement and starts it.
  - The brief is the digest plus the last message.
  - The chat's `task_id` and `pass_id` are set.
- **Judge:** a whole-project page keeps the hazard rules (a table row).
- **UI:**
  - the Do it sheet (UI spec)
  - the divider in the tab
  - the task's thread below it
  - the changes panel
  - Sign Off, Keep Going and Abandon, reused from the Workbench
- **Real git tests:**
  - Here on a feature branch
  - Here on base, with a PR project and with a `local` project
  - refused mid-merge
  - after the close: HEAD, the working tree and the commit
- **e2e:** Sessions Explore, then Do it Here, then a turn, then Sign Off, then the close.
- **Decision:** M6's §14 record.

### M7: Open in Terminal and Hand Back

- `takeoverCommand` per adapter. A pure table over the harnesses (Claude, Codex) and profiles (explore, lane)
  checks:
  - the pinned path
  - `--resume`
  - `--setting-sources`
  - `--strict-mcp-config`
  - the `--mcp-config` file
  - the env
  - `untrusted`
- **The script:**
  - mode 700
  - its first line is `rm -- "$0"`
  - it reads keys from the Keychain
  - the daemon runs `open -a <terminal>` itself
- **Behaviour:**
  - The banner names any agent-changed project setting file.
  - The `taken_over` and Hand Back rows of the state table apply.
  - Terminal or iTerm is set in Settings.
- **Decision:** M7's §14 record. Its security table goes through adversarial review.

### M8: Spotlight

- `@mantine/spotlight`.
- ⌘K opens it. It holds:
  - the open sessions and recent sessions
  - the projects
  - New Session, Archive and Do it for the current session
- Its global shortcuts are gated by `useActiveElement`.

## Follow-up tasks to file

- Third-party notices. 10db ships MIT and Apache dependencies but has no notices file covering them. M3 adds only
  streamdown's line to NOTICE.
- Plan's researchers and reviewers on Codex (M5b's parity gap).
- Keyboard reordering of tabs (UI spec review, finding 22).

## Morning checks before M1 starts

These are from spec §16. Each is free or costs one turn.

1. `claude --resume <id>` on a 10db Plan session, with `CLAUDE_CONFIG_DIR` set to the account's,
   `--setting-sources ''` and `--strict-mcp-config`.
2. `codex resume <id>` on an app-server thread, under the account's `CODEX_HOME`.
3. A read-only Codex thread refuses a write and asks through the hook.
4. A streamdown spike: a 20k-token message streaming at 50 ms frames, in the virtualized transcript, in the Tauri
   webview.
5. The OpenCode handshake, for the ACP spec later.

If check 1 or 2 fails, M7 changes. If check 4 fails, M3 falls back to react-markdown plus `remend` (spec S10, and
research T4 §1).
