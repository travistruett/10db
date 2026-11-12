# 10db Sessions: roadmap and execution

> **For agentic workers:** this is the index. Each milestone that has a plan file runs from that file. Milestones
> without one are outlined here and get a plan written once their predecessors have merged, so the plan cites
> code that exists. Coordinate the build with the `coordinating-builds` skill.

**Spec:** `docs/superpowers/specs/2026-11-11-10db-sessions-design.md` (v4), with
`docs/superpowers/specs/2026-11-11-10db-sessions-ui.md`. Both are revised on top of the trust line
(`docs/superpowers/specs/2026-11-12-10db-trust-line-design.md`), whose milestones T2 to T6 run in this roadmap's
order.

**Goal:** one conversation store and delivery library, one engine for interactive conversations, one adapter seam
with capabilities, one conversation UI kit, and the Sessions screen on top of them.

**Decision file paths.** Each plan names a decision file it creates as `docs/architecture/decisions/./<name>`. The
`./` lets the repo's citation test (`tests/repo/src/architecture-docs.test.ts`) pass before the file exists. The path
is valid as it is, so drop the `./` only when citing the file from another document.

## Milestones

The order, from trust line §12 and the builder's handoff:

M1 → T2 → M2a → M2b → T3 → M2c → M3 and M4a (in parallel) → M4b → T4 → T5 → M4c → M5a → M5b → T6 → M6 → M7, M8.

| # | PR | Plan | Needs | Branch |
| --- | --- | --- | --- | --- |
| M1 | Foundations: Mantine 9.8, Codex generated types, `gcp` fix | `2026-11-12-10db-sessions-m1-foundations.md` | — | `feat/sessions-m1` |
| T2 | Setup comes along: instructions, skills and plugins, opened sandbox reads, web where a native judge runs | `2026-11-12-10db-trust-t2-setup-comes-along.md` | M1, live checks L3 and L4 | `feat/trust-t2` |
| M2a | One Claude core, one fake | `2026-11-12-10db-sessions-m2a-claude-core.md` | T2 | `feat/sessions-m2a` |
| M2b | `AgentAdapter.open`, capabilities with `judge` | `2026-11-12-10db-sessions-m2b-adapter-seam.md` | M2a | `feat/sessions-m2b` |
| T3 | The policy and auto mode everywhere: `TrustPolicy`, `capabilities.judge` with the model, auto mode for lanes and passes, the guard slimmed | `2026-11-12-10db-trust-t3-policy-and-auto-mode.md` | M2b | `feat/trust-t3` |
| M2c | Streaming events, `ToolCallView`, hunks | `2026-11-12-10db-sessions-m2c-streaming.md` | T3 | `feat/sessions-m2c` |
| M3 | Static conversation kit; Plan renders markdown | `2026-11-12-10db-sessions-m3-kit.md` | M2c | `feat/sessions-m3` |
| M4a | Conversation stores and the migration | `2026-11-12-10db-sessions-m4a-stores.md` | M2c | `feat/sessions-m4a` |
| M4b | Explore engine; Plan on it, streaming, in auto mode | `2026-11-12-10db-sessions-m4b-engine.md` | M4a, M3 | `feat/sessions-m4b` |
| T4 | Unattended never waits: skips, `skipped_actions`, the Inbox item, network hosts to the judge | `2026-11-12-10db-trust-t4-unattended-never-waits.md` | M4b | `feat/trust-t4` |
| T5 | 10db's judge and Codex: `crossesLimit`, Auto-review or the hook judge, gateway accounts, and Plan and passes on a `tendb` judge | `2026-11-12-10db-trust-t5-tendb-judge-and-codex.md` | T4, live check L1 | `feat/trust-t5` |
| M4c | Task threads through the library; Workbench thread on the kit | outlined below | T5 | `feat/sessions-m4c` |
| M5a | Sessions on Claude, attended and judged | `2026-11-12-10db-sessions-m5a-sessions.md` | M4c | `feat/sessions-m5a` |
| M5b | Codex conversations on the attended profile, and Plan without subagents | outlined below | M5a | `feat/sessions-m5b` |
| T6 | Your MCP servers in Settings, approved once, run as Claude Code runs them, calls judged | `2026-11-12-10db-trust-t6-your-mcp-servers.md` | M5b | `feat/trust-t6` |
| M6 | The folder hold; a chat writes in Your folder through daemon git; Do it: a separate copy, or a pass of one | outlined below | T6 | `feat/sessions-m6` |
| M7 | Open in Terminal, Hand Back | outlined below | M6 | `feat/sessions-m7` |
| M8 | Spotlight | outlined below | M5b | `feat/sessions-m8` |
| — | ACP spec, then OpenCode | a spec first (§5.6) | M5a soaked | — |
| M9 | Lane steps as conversations | a spec first (§6.9) | M6, two weeks | — |

The T plans are written by the trust line's own track. T2's plan is being written; the others follow, each once its
predecessors have merged.

**Why this order** (trust line §12):

- T2 lands on today's code. It touches the adapters' launch options and the sandbox profile, not the engine, so it
  goes before M2a merges the two Claude loops.
- T3's `judge` field is part of M2b's `AgentCapabilities`, so T3 follows M2b. T3 applies auto mode to lanes and
  passes; Plan gets it in M4b, when Plan moves onto the engine, so Plan's session code is not rewritten twice.
- T4 follows T3, and T5 follows T4 and live check L1. M4c, M5a and M5b then build on a judge for every account.
- M5b follows M5a directly, for provider parity: a chat runs on every account kind. Sessions has no flag to hide
  it behind, so M5a and M5b ship in the same release: no release is cut between their merges.
- T6 can land any time after T2. It goes after M5b, so Settings › Trust lists the servers a chat will run on both
  agents.
- M7 follows M6, whose folder hold a takeover takes.

**What can run in parallel:**

- M3 and M4a can run in parallel after M2c.
- M7 and M8 can run in parallel after M6. M8 needs only M5b, so it can start earlier.

**How the build runs:**

- Each implementer works in its own worktree under `10db-worktrees/`.
- Run at most two implementers at once on this Mac. The engine milestones (M4a, M4b, M4c) run one at a time.

## How each milestone runs

1. An implementer per plan. Concurrent-state work (M2a, M4a, M4b, M4c, M6, and T3 to T5) is taken in small
   red-first steps, one commit per behaviour.
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

- The explore profile on Codex is the trust line's attended profile (spec §5.5, trust line §4, §5):
  - a chat's thread on Plan's read-only `sandboxPolicy` (named as in `codex-generated/`) until M6 lets it write;
    Plan's stays read-only, as its role
  - the judge T5 built: Auto-review (`approval_policy: on-request`, `approvals_reviewer: auto_review`, the
    session's policy passed at `thread/start`) since live check L1 passed, else `approvalPolicy: 'never'` with the hook sending each
    call to 10db's judge
  - the project pinned `untrusted`
  - the guard socket with the coordination rules and the `rules` floor; a call 10db's judge asks about reaches the
    broker as a card
  - T2's setup: `skills/extraRoots/set` and the instructions in `developerInstructions` (L4); `tools.web_search`
    on, since T5 gives Codex a judge
  - a judged denial stored as a `denied` call with `deniedBy: 'judge'`, its `limit` and `soft`; the row offers
    Allow This only on a `soft` denial
  - 10db's `/mcp` with `tool_timeout_sec` raised to the chat's tool wait (spec §6.6), so an `asks` card can wait
- `startShape` refusal sites removed (research T1 §3 lists seven, plus `shape/chatgpt-refusal.test.ts`, which is
  replaced by a test that Plan runs on Codex and says what it lacks).
- M5a's call 23 goes: a chat on a ChatGPT plan runs.
- Plan on Codex runs without `agents`. The header notice comes from `capabilities.subagents`.
- A follow-up task on the Board: "Plan's researchers and reviewers on Codex".
- **Tests:**
  - the Codex attended profile options table, one row per judge (Auto-review, the hook judge, the `rules` floor)
  - a guard row: a write attempt in Plan's thread is refused
  - the live Codex chat test (opt-in): the judge stops a call at a limit, and the builder's go-ahead (L1)
- **Decision:** M5b's §14 record, which amends the ChatGPT decision.

### M6: The folder hold, a chat that writes in Your folder, and Do it

Risk: high. Concurrent state (the hold), git, and a sandbox-adjacent tool surface. Small red-first steps, one commit
per behaviour.

- **The folder hold** (spec §7.3), a daemon module `apps/daemon/src/folder-hold/`:
  - Who has Your folder, per project, by kind and id: `pass`, `chat_turn` and `takeover`, one at a time, and
    `lane`, counted (a `WorkspaceMode.Shared` task, or any task on a `local` project). The scheduler runs several
    Your-folder lanes at once today, up to `maxLanes`. A lane holds from its task's first start in the folder until
    it lands or ends, between steps too. The kinds exclude each other.
  - Read by the scheduler's W9 wait (`scheduler/scheduler.ts`), `proposePlacement` (`placement/propose.ts`), pass
    open, the Do it refusals, a chat turn's start and Open in Terminal. `passHoldsFolder` becomes a read of it.
  - Every wait reason and refusal names the holder ("Your folder is in use by the chat ‘Retry login’ in your
    terminal").
  - In memory, rebuilt at daemon start from open passes, running Your-folder lanes and `taken_over` chats.
  - The chat's rows of spec §7.3's hold table, one row each on the explore engine with a real store.
- **A chat writes in Your folder** (spec S2, §7.3; trust line §7, §8):
  - The chat's sandbox writes the checkout, with `.git` closed as for lanes; its tools gain edits. On Claude and on
    Codex (`sandboxPolicy` workspace-write).
  - A turn takes the hold when it starts, if the folder is free, keeps it for a chained turn, and gives it back at
    every end. Its background jobs stop when the turn ends.
  - While another holder has the folder, the guard's coordination rule refuses edits and any command the read-only
    line doesn't pass, with "Your folder is in use by {holder}." The session bar says so.
  - **Git through the daemon:** the builder tools `make_branch`, `switch_branch`, `pull`, `commit_changes`,
    `push_branch`, `open_pull_request` and `merge_pull_request` run the daemon's git and `gh` in Your folder, the
    way lanes land. Credentials stay with the daemon, and git trust is unchanged.
    - `make_branch`, `switch_branch`, `pull` and `commit_changes` refuse unless the chat's turn holds the folder.
    - The daemon's git runs with hooks off (`git/daemon-config.ts`), so the project's pre-commit and pre-push hooks
      don't run; the tools' descriptions say so.
    - `push_branch` is judged and has no force option; `merge_pull_request` is limit 4.
    - The guard refuses any git write in the chat's shell with one message listing the tools.
    - Codex reaches the same tools through 10db's `/mcp`.
  - No claims, hazards, 10db commit or gate for a chat. Installs run in place.
  - `CHAT_SYSTEM_PROMPT` (M5a) changes: the chat edits files in Your folder, and commits, branches and opens pull
    requests with the git tools.
- `POST /chats/:id/do-it {place}`:
  - **Worktree** (the separate copy): it seals the chat (state `sealed`), creates an ordinary task with worktree
    placement and starts it. The task takes the chat's tab.
  - **Here** (optional): it opens a pass of one, with a synthetic "Whole project" page over
    `WHOLE_REPOSITORY_GLOBS`. The folder refusals are the hold's. A running chat turn is stopped first, and the pass
    opens only once the stop has settled and released the hold. The chat is not sealed; the pass opens in its own
    tab.
  - The brief is the chat's agent's (`write_brief`), else the digest plus the last message.
  - The chat's `task_id` and `pass_id` are set.
- **Judge:** a whole-project page keeps the hazard rules (a table row).
- **UI:**
  - the session bar's folder line, and "Your folder is in use by …"
  - the Do it sheet (UI spec), with the uncommitted files and which rule applies to them
  - the divider in the tab, for a separate copy
  - the task's thread below it
  - the changes panel
  - Sign Off, Keep Going and Abandon, reused from the Workbench, for a pass of one
- **Real git tests:**
  - a chat's turn: an edit, `make_branch` and `commit_changes`, and the hold given back at the turn's end
  - a git write in the chat's shell is refused with the message listing the tools; `git status` runs
  - `commit_changes`, `make_branch`, `switch_branch` and `pull` refuse while the turn doesn't hold the folder
  - a chat's turn between two steps of a Your-folder task writes nothing
  - a chat's turn while a pass holds the folder: no edit lands
  - a chat's turn while a Your-folder lane runs: no edit lands, and the lane's kept work holds none of the chat's
  - a task scheduled during a chat's turn waits, naming the chat; a pass opened during it is refused, naming it
  - Here on a feature branch
  - Here on base, with a PR project and with a `local` project
  - refused mid-merge
  - after the close: HEAD, the working tree and the commit
  - a separate copy: the chat's uncommitted files stay in Your folder
- **Real store:** the hold rebuilt after a restart keeps a pass, a running Your-folder lane and a takeover, and
  drops a chat turn.
- **Adversarial review:** a reviewer tries to write `.git`, reach a credential, or push, merge or force-push without
  the judge, through the git tools, the chat's shell and Codex's `/mcp`. Findings block.
- **e2e:** a chat edits a file in Your folder and commits it, then Do it Here, then a turn, then Sign Off, then the
  close.
- **Decision:** M6's §14 record, with the hold and the git tools.

### M7: Open in Terminal and Hand Back

- `takeoverCommand` per adapter. A pure table over the harnesses (Claude, Codex) and profiles (explore, lane)
  checks:
  - the pinned path
  - `--resume`
  - `--setting-sources`
  - `--strict-mcp-config`
  - the `--mcp-config` file, with the builder's own servers the session had
  - a `--plugin-dir` for each plugin dir the session had, and its appended instructions (trust line §6)
  - the env
  - `untrusted`, and Codex's skill roots (`skills/extraRoots/set`)
- **The script:**
  - mode 700
  - its first line is `rm -- "$0"`
  - it reads keys from the Keychain
  - the daemon runs `open -a <terminal>` itself
- **Behaviour:**
  - The banner names any agent-changed project setting file. A project hook loads only with its approved hash.
  - A chat takes Your folder's hold (M6's module, kind `takeover`) for the whole takeover; Open in Terminal is
    refused while another holder has it, naming the holder. A restart takes it again from the `taken_over` row.
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
- OAuth MCP servers and claude.ai connectors in Your MCP servers (trust line §6, after T6).
- Run the project's commit checks for chat commits (M6's git tools run with hooks off).
- Whether a writing call through the builder's own MCP servers waits for the folder hold (spec §7.3's gap, after
  T6).
- Keyboard reordering of tabs (UI spec review, finding 22).

## Live checks

The live checks are in trust line §14 (L1 to L4) and Sessions spec §16. Their results go in the research notes:
`docs/architecture/research/2026-11-12-trust-line-research.md` (L1 to L4) and
`docs/architecture/research/2026-11-11-sessions-research.md` (the Sessions checks).

- L3 and L4 gate T2, and L1 gates T5 and the Codex rows of M5b.
- If Sessions check 1 or 2 fails, M7 changes. If check 5 (the streamdown spike) fails, M3 falls back to
  react-markdown plus `remend` (spec S10, and research T4 §1).
