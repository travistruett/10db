# 10db: factory loop design (first slice)

- **Status:** Draft for review. Every section was approved in conversation on 2026-10-13. This document is the
  written spec; it is not yet approved.
- **Scope:** The first useful slice of 10db, plus the repo baseline it is built on.
- **Summary:** 10db is a local macOS control plane. You pick a project, ask for N units of unblocked work,
  approve the proposed batch, and walk away. A TypeScript daemon runs Claude Code sessions on your own
  subscription. It hands each session off cleanly to a fresh one before its context fills. Questions and
  permission prompts become cards in one inbox, and only the blocked work pauses. SQLite owns every record.
  A Tauri app (React and Mantine) is the window onto it.

---

## 1. Problem, intent and success

### 1.1 The problem today

The builder runs about eight Claude Code sessions in iTerm tabs across two projects, plus a `caffeinate` tab.
A home-grown Markdown harness (an 887-line task skill, a `today` script and observe-only hooks) picks
parallel-safe tasks and prints assignment prompts. Everything after that is manual. The steps below were traced
in two real tasks on the pilot project; the trace is in the private research notes, §9.
1. Paste each assignment prompt into a new session.
2. Answer design questions one at a time.
3. Approve review gates by reading a review file.
4. Fix environment faults: a budget cap, a stopped worker, a database missing migrations.
5. Relay lost background-agent output, e.g. a security review that arrived as one line.
6. Absorb collisions in the shared checkout, e.g. one session's `AGENTS.md` edit shipped inside another
   session's commit.
7. Edit roadmap dependencies and release reservations by hand.

Model routing, concurrency and handoffs are honor-system conventions. Linear has been paused since
2026-10-10, and nothing syncs from Sentry.

### 1.2 Intent

The builder said:
- He wants a Mac control plane that removes the manual coordination, not the coding.
- It should replace the legacy Markdown harness he copies between private repos. Its mechanics go away;
  a small set of craft skills remains.
- It runs on his own Claude subscription, and core features need no API key.
- It is open source (Apache-2.0), for himself and technically capable friends. A light commercial tier is
  possible much later.
- It is a TypeScript and Mantine UI, dark by default with an optional light mode, in Tauri from day one
  because he wants to learn it.
- He wants to stop repeating himself: decisions, principles and how-we-work should be captured once and
  applied everywhere.
- He wants right-sized intelligence: the cheapest model and effort on the frontier that is good enough for
  each step, visualized eventually.
- He wants teams of personas and humans, with questions routed to the right human.
- The scaffold must be an extremely strong baseline that cheaper models can build on.

Assumed and confirmed during design:
- A private pilot project is the first real project, and 10db is the second.
- The shared checkout stays the default.
- Records move into SQLite.
- Routing to a teammate starts as an in-app lane.

### 1.3 Success: the milestone 1 acceptance scenario

On a disposable test repo, then on the pilot project, all of this must happen without any manual copy/paste:
1. Run three tasks.
2. At least one task crosses a context handoff (forced with a low threshold).
3. One real question reaches the inbox, is answered, and the work resumes.
4. The daemon is killed with `kill -9` mid-step, restarts, and recovers.
5. Every task ends `DONE` with gate evidence.
6. No tool operation is duplicated.
7. Closing and reopening the window loses nothing.

Measures, tracked from day one: manual continuation actions per workstream (target 0), human interventions
per verified completion, recovery success rate, and first-pass verification rate per model profile.

### 1.4 Not in this slice

- Codex adapter. It comes next, behind the same interface.
- Worktree mode.
- Facts UI and injection. The schema is in this slice.
- PDF intake. It is the fast-follow, reusing sources and proposals.
- Email or Slack delivery to other humans.
- The frontier chart. Its data is recorded from day one.
- Dependency-graph view.
- Stakeholder views.
- Off-machine backup. It follows the MVP as export and import (§13).
- `SMAppService` login-item registration.
- Embeddings.
- Linear and Sentry integrations.
- A hosted service.

---

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| 1 | The first slice is the factory loop: board → batch → managed sessions → automatic handoff → inbox → verified done. | It removes most of the traced manual steps. |
| 2 | Clean handoff at a context threshold is the default. Compaction is only an emergency fallback, and is logged. | A fresh, curated context is cheaper per turn and leaves a structured record. Blocking compaction outright fails requests during context-limit recovery. |
| 3 | Managed headless sessions are the default. "Open in terminal" is an explicit, serialized takeover. | Structured events power the inbox, like the Codex app. A session is never driven two ways at once. |
| 4 | Claude first. The session interface is designed for several providers, and Codex is the next adapter. | Claude subscription use is documented as allowed. Codex's third-party terms are unknown and its app-server is experimental. |
| 5 | The runtime is the official TypeScript Claude Agent SDK, pointed at the user's installed `claude` binary. Raw `claude -p` stream-json is the fallback adapter. | Typed events, a permission callback, hooks as functions, resume by id, context usage. The least protocol code to own. |
| 6 | 10db's SQLite owns tasks, decisions, deviations, handoffs, proposals, sessions and events. Agents write only through MCP tools. Markdown is exported, never authoritative. | One writer per concept. gbrain's Markdown-plus-DB design was its largest source of drift bugs. |
| 7 | The harness is injected at launch: plugin dir, settings and per-session MCP config. Repos keep only `AGENTS.md`. | One version to maintain, nothing to copy between repos, and the same behavior on every machine. |
| 8 | Tauri 2 shell, a TypeScript daemon, one pnpm monorepo. | The builder's choice. TypeScript everywhere except a thin Rust shell. |
| 9 | No LangGraph or Pydantic AI. A hand-rolled state machine sits behind an interface. | Claude Code is the agent; 10db needs only a status workflow. A framework adds a second language and a second source of truth. |
| 10 | SQLite (WAL) via Drizzle, with FTS5 and no embeddings. | It is mature and can be inspected live with `sqlite3`. gbrain's PGlite record shows unclean-shutdown corruption, deadlocks and lock bugs. gbrain's own evals show vector search adds little over keyword search. |
| 11 | Picker: rules choose candidates, then a skippable PM-agent review, then the builder approves. | Rules are fast and predictable. Some judgment helps. |
| 12 | The pilot project first, then 10db manages its own build. | Real backlog and real pain first, then dogfooding. |
| 13 | One shared checkout per repo, enforced (§8). Worktrees come later, per task. | Worktrees duplicate Docker, databases and ports, and complicate QA. The real collisions were git and staging collisions, which serialized git fixes. Claims schedule work; they don't sandbox it. _Update: worktree mode is built as a per-project choice, `docs/superpowers/specs/2026-10-27-10db-worktree-mode-design.md`; shared mode is this decision._ |
| 14 | Kanban board plus brainstorm. Brainstorm suggestions are pending proposals, never applied silently. | Planning in the same place. Proposals are the mechanism PDF intake reuses. |
| 15 | Personas, flows and per-project teams are configurable. Humans are team members, with routing rules. | Different projects need different spend and specialists, and questions route to the right human. |
| 16 | No named tiers. Each step is right-sized to the cheapest model and effort at or above its need, under the project's budget ceiling, escalating on failure. | This matches the model-and-effort mental model, and the frontier can be visualized later. |
| 17 | The knowledge layer has decisions, principles and facts with you, project or area scope. Agents only propose principles. Supersession is by a fixed key. Every write needs provenance. | Learned from an earlier private knowledge repo and gbrain. It stops repetition across projects. |
| 18 | Keep the Mac awake while lanes run. | It retires the `caffeinate` tab. |
| 19 | Apache-2.0. | Permissive, with an explicit patent grant and contribution terms. |
| 20 | Type-aware ESLint (typescript-eslint strict-type-checked), Prettier, the strictest TypeScript, enforced boundaries, knip, exact pins, and zod at every boundary. | The builder wants really robust, modern, idiomatic code, and type-aware rules catch daemon bugs. |

---

## 3. Architecture

```
┌──────────── Tauri app (apps/desktop) ─────────────┐
│ React + Mantine UI: Board · Factory · Inbox ·     │
│   Knowledge · Settings                            │
│ Thin Rust shell: window, menu bar, PTY (takeover) │
└────────────── HTTP + WebSocket (loopback, token) ─┘
                         │
┌──────────── 10db daemon (apps/daemon, TS, sidecar)┐
│ API (Hono): commands in, events out (persisted 1st)│
│ Workflow: workstream state machine + scheduler    │
│ Picker: rules → optional PM-agent review          │
│ Router: need → cheapest model profile ≥ need      │
│ Session adapters: Claude (Agent SDK); Codex later │
│ Workspace guard: claims, hazards, git lock, watcher│
│ MCP server: per-session scoped tokens             │
│ Harness injector + env builder                    │
│ Knowledge: context packer, search (FTS5)          │
└──────── SQLite (WAL) ~/Library/Application Support/10db/ ┘
```

- **The daemon is the only database writer.** The UI uses the API and agents use MCP tools. Every event is
  persisted before it is pushed. Events carry a monotonic sequence number, and a reconnecting UI replays from
  the last sequence it saw.
- **Process model in this slice:**
  - The daemon is a bundled Tauri sidecar: the pinned Node binary run as Tauri's `externalBin`, with
    `daemon.mjs`, migrations, the harness plugin and the SQLite addon as resources (decision 37), not a
    single-executable application. The shell spawns it with stdin piped, and it shuts down when that closes (decision 55).
  - The app lives in the menu bar. Closing the window keeps work running; Quit stops it.
  - A single-instance lock and a UI/daemon protocol-version handshake prevent mismatched processes.
  - `SMAppService` login-item registration comes later.
  - In development, run `pnpm dev`.
- **Environment:**
  - At every daemon start, 10db captures the login-shell environment (`$SHELL -l -i -c`) and keeps it in
    memory only (decision 38), and checks for `claude`, `git` and `docker`.
  - The env builder constructs each session's environment from the captured base plus the project's
    **billing mode**: subscription (default), API key or Bedrock.
  - It removes variables that would silently change billing. It never disables a supported auth method;
    it only prevents accidental switches.
  - 10db never reads, stores or intermediates claude.ai credentials.
- **Agent SDK settings:**
  - `pathToClaudeCodeExecutable` points at the installed `claude` binary.
  - Setting sources are explicit: the project's own settings plus 10db's harness. User-level hooks and plugins
    are excluded unless the project allowlists them.
- **The PTY lives in the Tauri shell.** Takeover is foreground-only in this slice.
- **Packages:**
  - `packages/contracts`: zod schemas → API, event and MCP types, generated and drift-checked.
  - `packages/db`: Drizzle schema and migrations, plus a thin repository interface. FTS is isolated in one
    module so a hosted Postgres stays possible.
  - `packages/harness`: injected skills, default personas and hooks.
- **Keep-awake:** while any lane is active, the daemon holds `caffeinate -i -w <daemon pid>`. The setting is
  off, while running (default) or always. Lid-closed sleep on battery is macOS behavior.

---

## 4. Data model

Every row has a prefixed, sortable string ID (e.g. `tsk_…`, `ws_…`), typed as a branded ID in TypeScript,
plus `created_at` and `updated_at`.

**Planning**

| Table | Holds |
|---|---|
| `projects` | name, repo path, max lanes, provider and billing mode, budget ceiling, area vocabulary, hazard patterns, gate command |
| `tasks` | title, description, acceptance criteria, status, board order, claimed areas, `workspace_mode` (`shared`; `worktree` later) |
| `task_deps` | task → depends-on task |
| `sources` | origin of an idea or record: brainstorm session, imported file and line, later PDF page and quote |
| `proposals` | pending typed change (new task, change task, record decision, propose principle, noted with no action), status, source, accept/reject rationale |

**Teams and routing**

| Table | Holds |
|---|---|
| `personas` | name, avatar, role, instructions, skills, tool permissions, optional model pin. Seeded from `packages/harness`. |
| `flows` | ordered steps by role (plan, plan review, implement, review, QA), with skip rules. Saved templates are optional. |
| `team_bindings` | per project: role → persona, plus human members |
| `people` | humans (you; later teammates): channels (in-app now; email or Slack later) |
| `routing_rules` | per project: question category (+ optional area) → person |
| `model_profiles` | provider + model + effort: intelligence score, cost-per-task estimate, speed, and observed stats (tokens per task, first-pass verification rate, escalation rate) |

**Execution**

| Table | Holds |
|---|---|
| `workstreams` | durable unit of work for a task: state, flow and per-step persona and profile, lease owner and expiry, retry budget |
| `sessions` | one provider attempt: provider, provider session ID, profile, mode (managed or terminal), start and end, exit reason, token usage |
| `handoffs` | the six-part handoff (§5.3) plus git-derived facts (HEAD, changed files, commits) |
| `claims` | live area or hazard claims: holder, exclusive flag, lease, released at |
| `inbox_items` | kind, workstream, session, structured options, recommendation, assignee, lifecycle state, answer, delivery record |
| `tool_ops` | operation IDs for MCP calls; a retry returns the first result |
| `evidence` | verification records: command, exit code, log path, commit SHAs |

**Knowledge**

| Table | Holds |
|---|---|
| `decisions` | question, choice, rationale, decided by, scope, supersedes, source (required) |
| `principles` | statement, kind (`policy` = must, `heuristic` = prefer, `belief` = context), topic key, scope, status (proposed → confirmed → retired), supersedes, source quote and speaker, confirmed by and at |
| `facts` | subject, predicate, value, scope, `valid_from`, `valid_until`, `superseded_by`, withdrawn tombstone, source. Schema only in this slice. |
| `deviations` | departure from plan or principle: cause, severity, signed reason, resolution |

**System:** `events` (append-only: sequence, type, entity, JSON payload) and `app_settings`.

**Invariants:**
- Every state change updates its row and appends its event in one transaction.
- Scheduling claims are atomic, with a lease and a fencing token, so two scheduler passes can't launch the
  same work.
- Knowledge status is derived on read: a record is current unless a confirmed successor supersedes it.
  Supersession uses fixed keys (principle topic key; fact subject + predicate), never similarity.

**Legacy harness import:**
- ROADMAP task blocks become `tasks`.
  - `after:` → `task_deps`
  - `touches:` → claimed areas
  - `waits:` → an open inbox item
- `plans/<slug>/` files become decisions, deviations and handoffs, each with a `sources` row pointing at the
  original file and line.
- Ledgers and the "how Travis works" sections of `AGENTS.md` become *proposed* principles and decisions, for
  bulk confirmation.
- Originals are copied untouched into the app data folder.

---

## 5. Workstream lifecycle

### 5.1 States

```
QUEUED → STARTING → RUNNING ⇄ HANDING_OFF → VERIFYING → DONE
side: WAITING_HUMAN · PAUSED_LIMIT · RECOVERING · TAKEN_OVER · FAILED · CANCELLED
QUEUED ⇄ HELD (a queued run that has not run, set aside by the builder; built)
```

- `RUNNING` spans many sessions and steps.
- `HELD` keeps the run's batch and worktree and takes no lane
  (`decisions/2026-10-29-hold-a-queued-task.md`). It shows in Blocked.
- The board shows a derived task status: Backlog, Ready, In progress, Blocked or Done.
- A task is Ready when its dependencies are `DONE` and it has no open blocking inbox item.

### 5.2 Batch, team and right-sizing

1. **Picker rules.** A candidate is Ready, holds no area that overlaps an active claim, and has no hazard
   conflict. Candidates are ordered in-progress first, then by longest remaining dependency chain.
2. **The PM-agent review (skippable)** checks for hidden overlaps. For each task it decides which flow steps are
   needed and estimates the **need** for each step from risk (trust boundaries, migrations, auth), ambiguity,
   size, novelty and history.
3. **The router** applies rule floors (e.g. a security-sensitive review needs at least Opus at high effort),
   then picks the cheapest `model_profile` at or above the need and within the project's budget ceiling. A
   persona's model pin overrides the router.
4. **The approval sheet** shows each task's steps (persona, model@effort and why), claims and verification
   plan. The builder edits and approves.
5. **Escalation:** when verification fails or a reviewer rejects, the retry moves one profile up the frontier.
6. **Consult step:** from any task or brainstorm, the builder can add a one-off consult with any persona.
7. **Concurrency:** the scheduler enforces global and per-project lane caps, plus a **per-provider concurrency
   cap**, because sessions share one subscription's usage limits.

### 5.3 Handoff

1. After each turn, the daemon reads context usage from the SDK.
2. At **40%** (configurable; about 400k tokens on a 1M window), the daemon tells the agent to finish its current logical step, then call
   `write_handoff`.
3. 10db validates the handoff against its schema and adds git-derived facts itself.
4. The session ends. A fresh session starts under the same workstream, seeded with the task, acceptance
   criteria, the context pack (§9), the handoff and the claims.
5. At **50%** without a handoff, the agent gets a firmer nudge. At the actual limit, Claude's compaction is
   allowed, logged as a deviation, and the context pack is re-injected afterwards.

Handoff contents:

| Part | Contents |
|---|---|
| Objective | task, acceptance criteria, non-goals |
| Progress | done, not done, next concrete action |
| Code state | changed files, commits, uncommitted diff summary (verified by 10db from git) |
| Reasoning | decisions, trade-offs, rejected approaches |
| Validation | checks run and their results, environment problems |
| Continuity | blockers, pending questions, background jobs, context the next session needs |

### 5.4 Waiting, limits, takeover, recovery

- **Human wait:**
  - A short wait keeps the session paused.
  - After a configurable time (default 10 minutes), the session ends cleanly and frees its lane.
  - When the answer arrives, the workstream re-queues and resumes with the answer.
- **Usage limit:** every lane on that provider moves to `PAUSED_LIMIT` until the reported reset time, then
  resumes. The builder gets one notice.
- **Takeover:**
  1. Pause the managed session at a safe point.
  2. Release the lease. The terminal (`claude --resume <id>` in the PTY) now owns the session.
  3. When the terminal exits, the builder clicks "hand back".
  4. 10db reconciles git state.
  5. Managed mode resumes.
- **Recovery** (state `RECOVERING`):
  1. Fence off orphaned processes.
  2. Reconcile git status and HEAD.
  3. Find the last acknowledged tool operation.
  4. Resume by session ID if the next step is safe to repeat. Otherwise, ask the agent to inspect state first,
     or escalate.
  5. If resume fails, start a fresh session from the last handoff.
  6. After 3 failed attempts, the workstream is `FAILED` and an inbox flag is raised.
  7. Never edit provider transcripts.
- **Done means verified:**
  - 10db runs the project's gate command itself and records the result as `evidence`.
  - Flows with review also need the reviewer's approval.
  - Then the workstream is `DONE` and its dependents become Ready.
  - On failure, the work goes back to the implementer with the output, escalating per §5.2.

---

## 6. MCP tools (agent-facing)

These tools are served by the daemon over HTTP. Each session's generated MCP config carries a scoped token, so
calls are attributed to the session that made them; agent-supplied IDs are never trusted. A stdio shim is the
fallback if headers prove unsupported. All inputs and outputs are zod-validated JSON, every mutating call takes
an operation ID, and empty results are explicit. The surface is small, and changes are additive only.

| Tool | Purpose |
|---|---|
| `get_context` | the context pack for this session |
| `find_knowledge` | search decisions, principles and (later) facts in scope |
| `ask_human` | a structured question: category, options, recommendation, urgency, consequences, affected scope |
| `record_decision` | a decision made within the agent's authority (routine engineering) |
| `propose` | a proposal (task, change, principle) |
| `report_deviation` | departure from plan or principle, with a signed reason |
| `request_claim` | ask for an additional area or hazard claim |
| `commit` | commit explicit paths under the repo lock; returns the SHA |
| `record_evidence` | attach verification output |
| `write_handoff` | the six-part handoff |

---

## 7. Inbox and permissions

**Card kinds:**

| Kind | Source |
|---|---|
| Question | Claude's built-in question tool (via the SDK callback) or `ask_human` |
| Permission | a tool call no rule covers |
| Proposal | brainstorm, import, a principle proposal (later PDF intake) |
| Review | a workstream reached done |
| Flag | an out-of-claim write, failure after retries, an invalid handoff, a usage-limit pause |

**Permissions are decided by rules, never by an LLM:**
- Injected allow rules cover reading and editing inside the repo, plus the project's test, lint and gate
  commands.
- Hard denials, enforced by the guard and never shown as cards: force push, pushes to protected branches,
  `rm -rf` outside the repo, deploy commands, `git checkout`, `reset`, `stash` and `add -A`.
- Everything else becomes a card with four choices: allow once, allow for this workstream, always for this
  project (which writes an allow rule and a decision), or deny.
- Permissions are never bypassed.

**Lifecycle and delivery:**
- An inbox item moves `OPEN → ANSWERED → DELIVERING → RESOLVED`, or ends `CANCELLED` or `EXPIRED`.
- An answer in a decision category becomes a `decisions` row.
- Identical open questions fold into one card. The answer fans out, and all affected workstreams resume.
- Before a question reaches the builder, existing decisions and principles are checked. If one answers it, the
  agent gets that answer, and the card is marked "answered from D-n".

**Routing:**
- Routing rules assign each card an owner.
- Cards for the builder raise macOS notifications. Cards for a teammate wait in that teammate's lane.
- Urgency sets the sort order.

**Untrusted text:** text quoted from PDFs, issues or tool output is rendered as data, with its source. It never
becomes an instruction.

---

## 8. Workspace guard (shared checkout)

1. **Claims:** reserved at launch from the project's area vocabulary. Active claims never overlap. They are
   released when the workstream reaches DONE, CANCELLED or FAILED (including a recovery that fails it), and are never
   released by lease expiry. Hazard claims (`migrations`, `deps`,
   `harness`, and project patterns) are exclusive per repo, and hazard work never runs in parallel.
2. **Guard (`PreToolUse`):**
   - Edit or Write outside the session's claims is denied, with an instruction to call `request_claim`.
     10db grants the claim if it's free, or raises a card.
   - Shell commands that use a banned git verb or a hard-denied command are denied.
   - Hazard commands without the matching claim are denied.
3. **Git through 10db:**
   - Agents commit only via `commit`, which takes a per-repo lock, requires explicit paths, refuses paths
     outside the session's claims, and records the SHA.
   - Direct `git commit` is denied.
   - Read-only git is allowed.
4. **Watcher:**
   - FSEvents attribute each changed file to the sessions active at the time.
   - A file outside every claim, or inside another session's claim, raises a flag. Nothing is blocked.
   - At the end of each step, 10db diffs git status against the session's claims.
5. **Worktrees:** `workspace_mode` exists now. Worktree support later adds one guard mode and a
   workspace-setup path, with no schema change.

---

## 9. Knowledge and the context pack

- **Shelves and scope:** decisions, principles and facts (§4), each scoped to you, a project or an area.
  Agents may only *propose* principles, and proposals always reach the builder's inbox. Facts are written only
  by the builder or by confirmed proposals; there is no automatic extraction.
- **Context pack:** a deterministic function that fills a token budget.
  - Order: confirmed policies in scope first, then heuristics, then the decisions relevant to the task (FTS5
    plus area match), then current facts (from the next slice).
  - It records `budget_used` and `dropped_count`, announces any truncation, and states explicitly when it is
    empty.
  - It is kept small: gbrain's always-loaded core memory failed a held-out eval.
  - It is injected at session start (bootstrap prompt for managed sessions, `SessionStart` hook for terminal
    sessions) and again after any emergency compaction.
- **Capture:**
  - Inbox answers become decisions.
  - The PM proposes principles from "always/never" statements in answers and brainstorms, with a choice of
    scope.
  - Repeat questions are answered from existing records (§7).
  - Two recent signed overrides of a principle raise a "review this principle?" card.
- **Provenance:** every knowledge write requires a source. Deleting a record leaves a withdrawn tombstone.
- **Later:** an optional one-way adapter that promotes records to an external knowledge repo.
  `sqlite-vec` only if intake shows a measured retrieval gap.

---

## 10. UI

- **Shell:**
  - Mantine app shell, dark by default with a light toggle.
  - Project switcher (including "All projects") and the views Board, Factory, Inbox (with a badge),
    Knowledge and Settings.
  - ⌘K palette to jump to any task, card or project.
- **Board:**
  - Kanban columns Backlog, Ready, In progress, Blocked and Done.
  - Drag and drop moves tasks and sets priority.
  - Cards show areas, dependency markers and live workstream state.
  - *Brainstorm* opens a PM side panel that streams proposal cards.
  - *Start N* opens the batch approval sheet (§5.2).
- **Factory:**
  - One row per active workstream: state, step and persona, session count, a context gauge and last
    activity.
  - The detail view has an activity feed with tool noise collapsed, a handoff timeline, changes and evidence,
    and *Open in terminal*.
- **Inbox:** one queue across projects, filtered by mine, by teammate or by project, and answerable from the
  keyboard.
- **Knowledge:** decisions, principles and pending proposals, filtered by scope. Bulk confirm for imports.
- **Settings:**
  - Per project: team bindings, routing rules, budget ceiling, areas and hazards, gate command and billing
    mode.
  - App-wide: providers and keep-awake.
- **Menu bar:** running lanes, inbox count, pause all and a keep-awake indicator.
- **Libraries:**
  - Mantine 9: core, hooks, notifications and spotlight, with Tabler icons.
  - TanStack Query and TanStack Router.
  - dnd-kit for drag and drop; xterm.js for the terminal; zod; dayjs.
  - The React Compiler.
- **Later:** the frontier chart (an Artificial-Analysis-style scatter of `model_profiles` with the Pareto line,
  proposed steps and the budget ceiling, eventually built from observed stats), a dependency graph and
  stakeholder views.

---

## 11. Repo baseline and harness

### 11.1 Layout

```
apps/desktop        Tauri 2 shell (Rust) + React/Mantine UI (Vite)
apps/daemon         TypeScript daemon
packages/contracts  zod schemas → generated API/event/MCP types
packages/db         Drizzle schema, migrations, repositories
packages/harness    injected skills, default personas, hooks
docs/architecture/  README, numbered locked sections, decisions.md (append-only),
                    proposals/, reviews/, research/, open-questions.md
docs/open-items.md, DESIGN.md (UI design system)
```

### 11.2 Conventions (carried over from the pilot project, tightened)

- **Agent instructions:**
  - The `AGENTS.md` hierarchy (root rules, then one file per app and package). Never `CLAUDE.md`; a test fails
    if one appears.
  - `.codex/config.toml` sets `project_doc_max_bytes = 131072`.
  - `.claude/rules/code-style.md` and `testing.md`:
    - comments say what and why, timelessly;
    - constants as `as const` objects with derived types;
    - no versions in names;
    - no cross-module private imports;
    - no `utils` grab-bags;
    - tests use real objects, mock only at boundaries, and are proven red first.
- **TypeScript:**
  - `strict`, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
    `noPropertyAccessFromIndexSignature` and `verbatimModuleSyntax`, with a modern target.
  - Branded IDs.
  - zod at every boundary.
- **Lint and format:**
  - ESLint flat config with `typescript-eslint` `strictTypeChecked` and `stylisticTypeChecked`,
    `react-hooks`, the React Compiler lint and jsx-a11y strict.
  - A boundaries rule enforces the module import rules.
  - `knip` catches unused files, exports and dependencies.
  - Prettier formats.
- **Rust:** `rustfmt`, plus `clippy` with pedantic lints and warnings as errors.
- **Versions:**
  - Exact pins (pnpm `save-exact`), latest stable when added. A held-back pin carries a comment saying why.
  - Lockfiles committed, frozen installs.
  - Current Node LTS, pinned.
- **Environment:** one typed env module with secrets redacted from errors. `.env.example` has a comment for
  every variable.
- **Contracts:** generated, never hand-written, with a CI drift check. The Hono typed client gives the UI
  end-to-end types.
- **Make targets:**
  - `make gate` runs format, lint, typecheck, test, build and drift, and prints one summary line.
  - `make check` is the fast focused target.
  - `make setup` is idempotent and asks before installing Rust.
- **CI:**
  - GitHub Actions pinned to commit SHAs, `permissions: contents: read`, and no `paths` filter on required
    checks.
  - A macOS runner for the Tauri build.
  - An advisory dependency audit.
- **Git guard for this repo:**
  - fail-open, with a kill switch;
  - every commit names its paths;
  - no backticks in double-quoted `-m`;
  - no `git add -A` or `git add .`;
  - irreversible verbs ask first.

  Normal branches and PRs.
- **Subagents:**
  - implementer and researcher on Sonnet, code reviewer on Opus, plan reviewer on Fable;
  - each report opens with the model ID it ran on, and the author is never the reviewer;
  - `.codex/agents/*.toml` are thin pointers to the same definitions.
- **Editor:** `.editorconfig`, plus committed `.vscode/settings.json` and `extensions.json`.
- **License:** Apache-2.0.
- **Bootstrap, then dogfood:** until 10db can run its own build, the repo uses a small checked-in `.claude/`
  setup. Afterwards, 10db's build runs on the injected harness like any other project.

### 11.3 Injected harness

Each managed session gets:
- a plugin dir with:
  - craft skills: planning, test-first with red proof, review checklist, brainstorming, short handoff guidance;
  - default persona definitions, used for seeding;
  - hooks: guard (`PreToolUse`), context injection (`SessionStart`), compaction policy (`PreCompact`) and
    post-compaction re-injection;
- a generated MCP config with its scoped token;
- explicit setting sources (§3).

The project overlay is the repo's `AGENTS.md` plus its 10db project settings, which can be exported and
imported as a file.

---

## 12. Testing and error handling

**Testing:**

| Level | Scope | Method |
|---|---|---|
| Unit | state machine (all allowed and forbidden transitions), picker, router, claims, guard decisions, context-pack budgeting | table-driven Vitest |
| Integration | daemon end to end | real SQLite temp file + a **fake Claude adapter** replaying SDK-shaped scripts (questions, permissions, rising context usage, usage-limit errors, crashes), typed with the SDK's own message types |
| Recovery | crash safety | kill the daemon mid-step; assert the `RECOVERING` path and no duplicate `tool_ops` |
| Knowledge | silent misses | every write is read back via search in tests, plus a runtime health check |
| UI | components and flows | Testing Library + MSW; Playwright + axe against the Vite app on a fake daemon |
| Live acceptance | the real loop on a real subscription | the §1.3 scenario, run manually, not in CI |

Committed fixtures are synthetic, in the legacy harness *format*. The real pilot-project import runs as a local,
uncommitted acceptance script, because the pilot project is private.

**Error handling:**
- Typed errors at every boundary. A parse failure becomes a flagged event, never a daemon crash.
- An unhandled error logs and exits loudly. The supervisor restarts the daemon, and work goes through
  `RECOVERING`.
- pino structured logs: rotating files, secrets redacted, a log per workstream, and a diagnostics bundle export.
- Migrations are forward-only, each in a transaction at startup, after an automatic SQLite backup.
- A nightly local SQLite backup.
- All 10db state lives under one data directory (database, logs, settings), and secrets stay in the
  Keychain, never in the database. This keeps a later export a single safe file.
- Per-view React error boundaries, and a "reconnecting…" banner.

---

## 13. Milestones

1. **M0 Scaffold.** The repo baseline (§11), empty apps and packages wired together, `make gate` green, CI
   green.
2. **M1 Engine walking skeleton.**
   - Daemon, database, workflow, Claude adapter, MCP tools, guard, handoff, inbox (questions and
     permissions), recovery, keep-awake.
   - A bare UI: Factory list, Inbox, a simple task list.
   - Passes §1.3 on a disposable repo.
3. **M2 Planning UI.** Board with drag and drop, batch approval sheet, picker plus PM review, router and
   `model_profiles`, personas, flows and teams, routing rules, takeover.
4. **M3 Knowledge and the pilot project.** Context pack, decisions and principles UI, capture flows, the
   legacy harness import, §1.3 on the pilot project.
5. **M4 Dogfood.** 10db manages its own build as the second project.
6. **Fast-follow:** PDF intake as proposals with page references. Backup as export and import: one
   archive (a consistent SQLite snapshot plus settings, no secrets) that can be dropped in Drive by hand and
   restored on the same or a new machine. Next: the Codex adapter, the facts UI, the frontier chart.

---

## 14. Spikes and open questions

Spikes, run before or alongside M1. Each spike's result goes into `docs/architecture/research/`.
1. The Agent SDK runs the installed `claude` via `pathToClaudeCodeExecutable`, with user settings excluded.
2. Context usage is readable after each turn.
3. `PreCompact` can block compaction; auto-compaction can be disabled.
4. Per-session MCP config can carry HTTP headers; if not, use the stdio shim.
5. Claude's built-in question tool and permission prompts reach `canUseTool` with structured options.
6. A long wait can end the session cleanly and resume it with the answer.
7. The shape of the usage-limit error, and whether it includes a reset time.
8. A Node single-executable sidecar inside Tauri 2: signing and PATH.
9. `caffeinate -w` tied to the daemon's process.
10. What `claude --bg` exposes programmatically (events, permission routing), for a later revisit.
11. Rust toolchain install and the first Tauri 2 window, as a learning step.

Open questions:
- Codex third-party terms for ChatGPT sign-in (UNKNOWN).
- Whether running Claude Code inside a distributed product needs any formal agreement beyond the Commercial
  Terms, before any commercial tier.
- Whether Artificial Analysis data may be imported into `model_profiles`.
- Pro-plan behavior: no API credits; subscription limits only.

---

## 15. Evidence

- **Verified this session:**
  - Help Center, "Use the Claude Agent SDK with your Claude plan" (Oct 7, 2026 update): Agent SDK, `claude -p`
    and third-party apps on subscription limits; Max and Team API credits.
  - Claude Code legal and compliance: users may sign in to the unmodified Claude Code binary with their own
    subscription, including where a platform hosts it. No collecting or intermediating credentials, no
    disabling built-in auth, no "Claude Code" in the product name.
  - The Agent SDK docs still say third-party developers may not offer claude.ai login without approval.
  - Both CLIs' daemon surfaces (approvals, compaction events, token usage).
  - Orchestrator.inc mandates a worktree per worker.
  - gbrain's PGlite reliability record and its retrieval evals.
- **Research notes:**
  - External and gbrain notes move to `docs/architecture/research/` during M0.
  - The legacy harness audit and the knowledge-repo study describe private repos and stay outside this public repository.
- **Assumptions:** these are starting heuristics, all configurable and tuned with observed data:
  - the 40% and 50% thresholds (of a 1M window: the builder finds a fresh session at about 400–500k tokens
    keeps quality higher than running toward the limit);
  - the 10-minute wait;
  - a default per-provider concurrency cap of 4 (Max 20x);
  - a default of 3 recovery attempts.
