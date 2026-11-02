# 10db Shape: a structured brainstorm chat that turns talk into goals, tasks and records

**Status:** designed on 2026-11-02 from a design session with the builder (gstack /office-hours, Builder mode), a
cold read by a Claude subagent, an approved wireframe, three rounds of an independent review of the design doc and
a builder check against the code. Calls this spec made without the builder are marked **(spec's call)** and listed
in §16.
**Extends:** `2026-10-29-10db-goals-design.md`: this is its phase 4, "New Goal as a native conversation" (§12),
and it replaces Adopt a Plan… as Factory's call to action (§8, §11).
**Supersedes:** phase 4's "its own terminal-like session… the takeover and PTY work in `docs/open-items.md` is its
base". Shape is an Agent SDK session rendered by 10db's own UI, not a terminal
(`docs/architecture/decisions/2026-11-02-shape-is-an-sdk-session-in-10dbs-own-ui.md`).
**Keeps:** the goal brief and the adopt route, for briefs made elsewhere; the judge (`2026-10-31-10db-openrouter-decisions-design.md`); the lane sandbox and the guard.

Each part is marked **Built** (on `main` today) or **Designed** (new work; §14 gives the slice).

## 1. Intent

The builder brainstorms in a Claude Code terminal. He pastes a rough list, screenshots or a document, talks it
through, and the session splits it into efforts, sizes them, writes and reviews specs; only then are tasks filed
into 10db, by hand. In his words: "Basically Claude Code but much more structured." Input varies: "sometimes a
brainstorm for a specific idea, it's sometimes a document, it's sometimes just what I've been thinking about."

Adopt a Plan… (`apps/desktop/src/views/factory/adopt-plan.tsx`) is a file picker for a finished brief; he finds it
too thin: "Manual form, chat with LLM, or drop in a file for an LLM to analyze and then start a conversation with a
really cool view of 'proposed goals/tickets' with an objective, etc from the file and as we're chatting it gets
refined."

He named four pains with the terminal; each has one answer here:

| Pain                          | Answer                                                             |
| ----------------------------- | ------------------------------------------------------------------ |
| No picture of where it stands | the live Proposed sidebar (§4)                                     |
| It runs ahead of him          | no proposals until he presses Propose (§6)                         |
| Hand-carrying the output      | one-step Convert into goals, tasks and records (§11)               |
| It forgets                    | the conversation stays attached to what it made, and reopens (§12) |

**What sets it apart.** Spec-driven tools (Kiro specs, GitHub Spec Kit, Cursor and Claude Code plan modes, Devin,
Factory's Spec Mode) all plan before coding; their reported failures are ceremony on small work, token burn and
specs drifting from the conversation. They treat a Markdown spec as what lasts and the chat as disposable. Shape
keeps the conversation and typed rows as what lasts, scales ceremony to size and risk, and, because 10db owns the
runner, prices the plan from tasks that really ran and previews how the factory would run it.

**Success means:**

- The 2026-11-02 six-item list (board scrollbars, the Abandon strip, card density, context-aware cards, Factory's
  "failed"/"Ungrouped", this chat) converts into efforts the builder accepts without retyping.
- The builder's next five brainstorms happen in Shape, not a terminal.
- Sizes hold up (§8): after 20 converted tasks have run, 8 in 10 derived sizes fall within one bucket either way
  of their real lane time.

**Goals.** Chat first; no proposals until the builder asks; a live, editable sidebar of typed proposals; one-step
Convert that starts nothing and can be undone; records suggested and kept; sizes and a factory preview from 10db's
own history; ceremony that scales; landings planned with the work, leaning to fewer, bigger pull requests; the
conversation reopens to re-plan.

**Non-goals.** Running anything (Convert starts nothing); sending questions to people (goals phase 3); building the
task annotation kinds beyond the proposed eval (the context-aware tasks work, designed separately); an embedded
terminal.

**Anti-goals.** A session that can write to the repository or read outside it; model output that runs code or
reaches the network when shown; a sidebar that contradicts the chat (two sources for one field); anything applied
without the builder's action (factory-loop decision 14: "Brainstorm suggestions are pending proposals, never
applied silently").

## 2. Principles

1. **The sidebar is the product; the chat steers it.** Every proposal field is a typed row, never parsed from
   prose.
2. **One source per field.** Claude writes proposals; the daemon derives numbers (hours, buckets, the preview);
   Jev only nudges; the builder's edits pin.
3. **The model proposes, the daemon validates** (goals spec §2.6). Every `propose_plan` is checked by the same
   rules adoption uses, and errors go back to Claude in the same turn.
4. **Read-only, enforced, not promised** (§5).
5. **Nothing the model writes runs** (§10).
6. **Decide, show, let me reverse it** (goals spec §2.3): Convert starts nothing, and everything it writes has an
   undo (§11), built here where 10db lacks one.

## 3. Not in this spec

- Routing questions to people and folding answers back: goals phase 3. Shape stores questions (§11) so phase 3 can
  send them.
- The task annotation kinds (schema diff, query counts, agent feedback): their own design. Shape reserves an
  `annotations` field on a proposed task and fills only the eval.
- Image-model mockups (§16).
- Orgtools mirroring (§16).

## 4. The screen

**Designed.** The builder approved an HTML wireframe on 2026-11-02 (three states: listening, proposed, convert);
this sketch is the proposed state:

```
┌ Shape ─────────────────────────────────────┬ Proposed · round 2 · updated just now ─ [Convert…] ┐
│ Board polish + chat         88k tokens     │ GOAL   Brainstorm chat in 10db   L · spec + review ✎│
│                                            │        Objective: brainstorm, size and file work…    │
│ Claude                                     │        task    Convert files 1 goal + 3 loose tasks  │
│ Four efforts. Three are small and          │        accept  The builder accepts the sidebar       │
│ unrelated, so they're loose tasks…         │        M  PlanDraft contract   ~2h · like 5 tasks    │
│ ▏propose_plan · 1 goal, 3 loose · passed   │        L  Shape session        ~5h                   │
│                                            │        L  Shape view           ~4h  [mockup][mermaid]│
│ You                                        │        eval   Sizes match real tasks · 8/10 …        │
│ Move density ahead of the scrollbars.      │        review Spec drafted · scope: 2 findings · …   │
│ ▏propose_plan · 2 changes · passed         │ TASKS  Loose tasks (3)                               │
│                                            │        M  Compact card density      desktop          │
│ [Question for someone else? "when should…"]│        S  Thin board scrollbars     desktop          │
│ ┌──────────────────────────────┐ 📎 [Propose│ PREVIEW lane 1 ████ PlanDraft ████ session ██ view  │
│ │ Talk it through…             │   Again ] │        lane 2 ██ density █ scroll                    │
│ └──────────────────────────────┘           │        ● density and Shape view both claim desktop   │
│                                            │ RECORD decision  The chat replaces Adopt   Keep Drop │
└────────────────────────────────────────────┴──────────────────────────────────────────────────────┘
```

The card side of annotations (an indicator per kind on a task card) is the readable board's
(`2026-11-02-10db-readable-board-design.md`); Shape is where a task's annotations are first proposed.

- **Shape** is a top-level view between Factory and Inbox. Its nav item lists the project's conversations (title,
  state, age) under it. Factory's header primary, Adopt a Plan…, becomes **Shape Work…**, which opens a new
  conversation; a dropped `.md` brief starts one too. The adopt route is unchanged.
- **Left, about 45%: the conversation.** Plain text blocks, not bubbles; the builder's in bright text. Tool use
  collapses to one dimmed line ("Read apps/desktop/src/views/board/ (12 files)", "propose_plan · 2 changes ·
  passed"). The input autosizes, takes dropped files and pasted images (§5.4), and holds the group's one filled
  primary, **Propose** (§6). Jev's chips (§9) sit above the input. The header shows the conversation's title and
  its tokens so far. While a turn runs, **Stop** sits beside Propose.
- **Right: Proposed.** One list with hairline dividers (DESIGN.md: lists, not cards), each kind labelled in a
  narrow left column:
  - **Goal:** title, objective, criteria with their check kinds, tasks (each with its size, hours and basis, §8),
    attachments, the proposed eval, ceremony status (§7).
  - **Loose tasks:** title, size, areas.
  - **Landings:** each proposed pull request and what lands in it ("Real areas · 6 tasks · 1 pull request"), §10.4.
  - **Preview:** the factory preview (§10.2).
  - **To record:** decisions and principles, each with **Keep** and **Drop**.
  - **Questions for others:** stored only, labelled "Sent when people arrive (goals phase 3)".
  - **Earlier:** superseded rows, collapsed, each with **Restore**.

  Every row edits in place (a pencil on hover). **Convert…** sits in the header, disabled until a proposal exists.

- **Before the first Propose** the sidebar shows only **Heard so far** (§6) and one line: "Press Propose when
  you've said enough. Claude will split what you said into goals and loose tasks, size them from tasks like them
  that already ran, and preview how the factory would run them."
- **The Convert modal** is a form modal (DESIGN.md): a checkbox per pending proposal with where it goes ("to
  Backlog", "to Knowledge", "under Real areas"), the line "Nothing starts. Tasks wait on the Board.", and, beside
  the primary **Convert n**, a warning while a review runs or a finding is open.

| Surface       | Loading                       | Empty                                | Error                                                 |
| ------------- | ----------------------------- | ------------------------------------ | ----------------------------------------------------- |
| Conversation  | the input's `loading` state   | the starter line in the input        | a red `Alert` above the input with the daemon's words |
| Proposed      | its rows' skeleton lines      | Heard so far, or the Propose line    | a red `Alert` in the sidebar; the chat stays usable   |
| Convert modal | the primary's `loading` state | not applicable                       | each refusal as a row, beside the primary             |
| Nav list      | `Loader size="sm"`            | "No conversations yet · Shape Work…" | a red `Alert` "Couldn't load conversations"           |

## 5. The session

### 5.1 Runtime

**Designed.** A new daemon module, `apps/daemon/src/shape/`, runs each conversation as a Claude Agent SDK
session, the runtime lanes use (factory-loop decision 5), with the SDK's typed messages rendered by 10db's UI
(decision file above). It holds no lane, claim or area. It runs on the project's billing mode and the model and
effort the `plan` role resolves to (`apps/daemon/src/routing/role-defaults.ts`: the strongest tier, high effort,
or the project's own binding for the role). Its SDK process closes after 10 minutes idle and is resumed on the next
message. **(spec's call: 10 minutes)**

**Accounts, limits and recovery (spec's call).** A Shape session is a `sessions` row like a lane's, so it uses the
project's account selection, counts toward that account's usage and moves to the fallback account with the rest:
`sessions.workstream_id` becomes nullable and `sessions.shape_id` is added, exactly one of the two set (a check
constraint). A rate-limit pause or a cap shows as a notice line in the conversation and queues new turns until the
account resumes; no Inbox card. After a daemon crash, a turn that was running is marked interrupted in the
transcript and is not re-run; the next message resumes the session (§5.3).

### 5.2 Read-only and confined

**Built:** for lanes, the adapter's `settingSources: []`, `strictMcpConfig` and `disallowedTools`
(`apps/daemon/src/sessions/claude-adapter.ts`); lanes run in auto mode inside the lane sandbox
(`decisions/2026-10-31-lanes-run-in-auto-mode-inside-the-sandbox.md`), and the adapter always loads 10db's harness
plugin. The PreToolUse hook answers with `judgePreToolUse` (`apps/daemon/src/guard/pre-tool-use.ts`); for a read
outside the checkout its file-access judge answers `ask`, which raises a permission card through the broker. The
guard trusts only the `10db` MCP server's tools (`mcp__10db__*`). The lane sandbox constrains Bash, Monitor and stdio
MCP servers; it has no read-only mode.

**Designed.** Read-only comes from the tool lists and the hook, not the sandbox:

- `settingSources: []`, `strictMcpConfig`, and **no plugins** (not the harness plugin: its skills and personas are
  for lanes) **(spec's call)**. No project `.mcp.json` server loads.
- `tools` lists exactly `Read`, `Grep`, `Glob`, `Agent` and the Shape tools; `disallowedTools` names `Edit`,
  `Write`, `NotebookEdit`, `Bash`, `Monitor`, `WebFetch` and `WebSearch`. Permission mode `default` (not lanes'
  auto); `canUseTool` denies by default. With no Bash, Monitor or MCP server process, the session runs no command
  for a sandbox to hold.
- Path confinement runs in the **PreToolUse hook** through `judgePreToolUse` with a Shape mode of the file-access
  judge that answers **deny** where lanes' answers `ask`, so nothing reaches the broker or raises a card. It runs
  for the session and its subagents alike, so calls Claude Code settles before `canUseTool` are still judged. A file
  tool is allowed only on real paths under the project's checkout or the conversation's files directory (§5.4). A
  symlink out, a protected path, and a `Grep` or `Glob` of a directory holding one are refused, with a dimmed line
  in the conversation.
- `Agent` may launch only the two reviewer definitions (§7), passed as programmatic agents; the built-in
  general-purpose type is not offered.
- **Tests, red first:** an `Edit`, a `Bash` call, a `Read` of `~/.ssh/id_ed25519`, a `Read` of the 10db data
  directory, a `Read` through a symlink in the checkout that points out, and a `Grep` of a directory holding a
  protected path are each refused; a reviewer's attempt at `propose_plan` is refused.

### 5.3 Transcript, turns and resume

**Designed.**

- **The transcript is 10db's.** Every message, tool line, injected note and Propose press is a row in
  `shape_messages` (id, shape, author `builder | claude | note`, kind, body, time), so a conversation renders and
  reopens however old it is. Each builder message reaches the session prefixed with its id (`[m:01J…]`), which is
  how proposals cite their source (§6).
- **One turn at a time.** A message sent during a turn is queued and shown as queued; **Stop** interrupts the turn
  (the SDK's interrupt) and the queue runs next. Row edits and Propose presses during a turn queue the same way, as
  injected notes.
- **Resume** uses the SDK session id while Claude Code still has it. When it doesn't (its cleanup removes old
  session files), the daemon starts a new SDK session seeded with a digest it builds deterministically: the last 40
  messages verbatim, the current proposals and the conversation's links (§12). The digest is stored as a `note`
  message, so what the new session saw is on record. **(spec's call: a deterministic digest, not a model summary)**

### 5.4 Dropped files

**Designed.** Markdown, plain text, PDF, PNG, JPEG and WebP, at most 20 MB each and 20 per conversation; anything
else is refused on the input with the reason. Files are copied into the conversation's files directory under the
data directory and kept as long as the conversation. Images reach the session as image content blocks; other
files as a line naming the path, which the session reads with `Read`. **(spec's call: the limits)**

### 5.5 Shape MCP tools

**Designed.** Contracts in `@10db/contracts`. The tools are served by the existing `10db` MCP server, so the guard
trusts them as `mcp__10db__*`, under a per-session token on the Shape session's `sessions` row (§5.1). The MCP
handler builds a session's tool set from its row: a lane's tools for a workstream, these for a shape. Subagents
share their session's MCP connection, so what a reviewer may call is set by its agent definition's tool list (§7),
not by the token.

| Tool                                 | Who                | Does                                                                                                                |
| ------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `note_heard(items)`                  | session            | the Heard so far echo: up to 12 strings of at most 80 characters                                                    |
| `similar_tasks(query)`               | session            | finished tasks with lane time (§8), matched by FTS over title and description, with lane time, wall time and tokens |
| `propose_plan(draft)`                | session            | the whole plan (§6); refused until the first Propose                                                                |
| `attach(target, attachment)`         | session            | a Mermaid diagram, a chart or an HTML mockup on a proposed task or goal (§10.3)                                     |
| `write_spec(effortKey, markdown)`    | session            | an effort's spec (§7)                                                                                               |
| `report_finding(effortKey, finding)` | reviewer subagents | a finding row (§7)                                                                                                  |

## 6. Propose and the plan

**Designed.**

- **Before the first Propose** Claude answers from the code, asks questions and echoes with `note_heard`; it makes
  no proposals, and `propose_plan` is refused (the flag is set only by the API).
- **Propose** sends an injected note ("The builder pressed Propose: propose a plan from everything so far") and
  starts a turn whose system prompt requires a `propose_plan` call. The first press unlocks the tool for good.
  After round 1 the button reads **Propose Again**: the prompt asks for a full re-split and re-size of everything
  not pinned. Otherwise Claude may call `propose_plan` on its own after any message.
- **Every `propose_plan` call states the whole plan**, small changes included; Propose Again differs only in what
  the prompt asks for.

**`PlanDraft`** (zod, `@10db/contracts`):

| Field          | Holds                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `goals[]`      | a `GoalBrief` plus `key`, `ceremony`, `eval?`; each task carries `basis` or `size` (§8), `annotations` (reserved), and may add `dependsOnOutside` keys |
| `looseTasks[]` | `key`, title, description, criteria, areas, `basis` or `size`, `ceremony`, `dependsOn` keys, `annotations`                                             |
| `landings[]`   | `key`, title, the proposal keys that land together in one pull request (§10.4)                                                                         |
| `records[]`    | `key`, kind `decision \| principle`, scope `project \| area` (with the area), statement, rationale, `sourceMessageIds`                                 |
| `questions[]`  | `key`, text, for (a role or a person), `sourceMessageIds`                                                                                              |
| `additions[]`  | once something is converted: `key`, `goalId` and the loose-task fields                                                                                 |
| `changes[]`    | once something is converted: a created task's id and new title, description, acceptance criteria, areas or dependencies                                |
| `removals[]`   | once something is converted: a created task's id and why                                                                                               |

**Validation** runs on the merged result (the draft, pinned fields, restored rows and converted rows) and answers
every error at once in the tool result, naming the field ("Task 3, depends on: no proposal has the key
drawer-editr"):

- every goal passes the adopt validator (`GoalBrief`, keys, cycles, areas; the goals spec §11) on its own brief;
- **dependencies may cross efforts (spec's call):** a loose task or addition's `dependsOn`, and a goal task's
  `dependsOnOutside`, may name any task key in the draft (a loose task, another goal's task) or a task this
  conversation already converted. The adopt validator gains an optional set of outside keys, so a goal's own rules
  stay as they are; cycles are checked over the whole draft;
- loose tasks and additions pass the same area checks;
- `basis` and `size` are exclusive (zod refuses both); a basis id must be a finished task with lane time, refused
  by name otherwise; an XL task is refused ("split it");
- `sourceMessageIds` must be the builder's messages in this conversation;
- a change or removal names a task this conversation created (through `shape_links`) that hasn't started (not
  running, done, failed or cancelled); hand-filed tasks and other conversations' tasks are out of reach, so two
  conversations never hold changes to one task **(spec's call)**; a goal's criteria are out of reach too (the owner
  edits them, goals spec §6);
- every task key is in at most one landing, and a landing's tasks all share a placement and a landing target
  (§10.4);
- keys are unique across the draft.

**Rounds.** A draft is reconciled per round:

- a key in the draft is created or has its unpinned fields updated;
- a pending key missing from the draft is `superseded` and moves to Earlier, unless it has a pinned field (kept;
  the tool result says so);
- **Restore** pins a row as a whole, so later rounds keep it until the builder unpins or drops it;
- a row the builder dropped is `rejected` and tombstoned: a draft reusing its key is refused, and Claude may raise
  it again only as a question in chat;
- keys aren't renamed: a new key is a new row, and the old one is superseded;
- converted rows are never changed by `propose_plan`;
- a change is keyed `change:<taskId>` and a removal `remove:<taskId>`, so a task has at most one of each pending.
  Dropping a change tombstones its content (a hash): the same change is refused again, a different one is allowed.
  Dropping a removal bars removing that task until the builder asks for it in chat.

**Rows.** **Built:** `proposals` and `sources`, written today by agents' `propose` tool
(`packages/db/src/store/knowledge.ts`), with `ProposalKind` `new_task | change_task | principle | note`.
**Designed:** `ProposalKind` gains `goal`, `task` (loose, or an addition with `goalId`), `remove_task`, `decision`,
`question` and `landing`; `SourceKind` gains `shape`. A Shape proposal carries its key, round, pin set and typed body (JSON,
parsed with its zod schema on read) in new nullable columns, so existing proposals are unchanged.

**Editing.** A field the builder edits is pinned: `propose_plan` can't change it, and the edit reaches the next
turn as a note ("The builder set Compact density's size to M"). Unpinning is a row action. A chip the builder acts
on (§9) creates a builder-authored row, pinned the same way.

## 7. Ceremony

**Designed.** Claude sets `ceremony` (`direct | spec`) on every goal, loose task and addition. A rule forces `spec`
when any of these holds (§8 gives the derived sizes):

- a loose task or addition is L; a goal is XL (its tasks' hours sum to over 8: a goal is several tasks by nature, so
  its threshold is the total);
- a goal has more than 5 tasks;
- a task's areas share a tracked file with the project's one-way paths (the match runs over `git ls-files` of the
  checkout, so two globs never need intersecting).

The goals spec §7 designs one-way class paths for phase 2; none is stored today. Slice 4 adds the project setting
`oneWayPaths` (a list of globs, edited in Settings › General) with the goals spec's 10db defaults
(`packages/db/src/schema.ts`, `packages/db/drizzle/**`, `packages/contracts/src/**`) for a project that has those
paths and an empty list otherwise; phase 2's Schema and Contracts classes read the same setting. **(spec's call)**

**(spec's call: the thresholds)** The builder can pin a forced effort to `direct`; it then reads "spec skipped by
you". For `spec` the session writes a spec (`write_spec`, kept as the effort's spec attachment) and launches two
reviewer subagents, **scope** and **engineering**, as programmatic agent definitions with exactly `Read`, `Grep`,
`Glob` and `report_finding`, under the same confinement. Findings are `shape_findings` rows (effort, reviewer,
severity, text, state `open | resolved | dismissed`) under the effort, each resolved by chat or dismissed. Convert
warns, but doesn't block, while a review runs or a finding is open.

**The proposed eval** (an `eval` on a goal) has a north-star objective, baseline criteria, the model(s) under test
and constraints (the builder's eval shape; prior art: gstack's `/eval-plan`, with preregistered bars and stop
rules). It is the first annotation kind; Convert keeps it as an
attachment on the goal.

## 8. Size and lane time

**Designed.**

- **Lane time** is the time a task's work held a lane: its sessions and its gate runs, not time queued for a lane
  or a gate slot, and not time waiting on a person. Wall time (45 finished tasks averaged 7.3 h of wall time and 36
  min of sessions, the judge spec §1) is mostly queueing and waiting, which the preview simulates itself.
- **Reconstruction.** **Built:** `sessions.started_at` and `ended_at`. Gate runs record no start or end today (the
  evidence row has no duration, and `step.changed` includes waiting for a gate slot). **Designed:** the gate runner
  records `gate.started` once it holds its slot and `gate.finished` with the exit. Lane time is the sum of a
  workstream's session spans plus its recorded gate spans. Tasks finished before the gate events have lane time
  from sessions only, marked "sessions only", and still count. A task whose sessions can't be read gets none and is
  left out of bases, medians and the measure.
- **Buckets:** S under 1 h, M 1–3 h, L 3–8 h, XL over 8 h of lane time. **(spec's call)**
- **One source per field.** Claude writes a task's `basis` (finished task ids from `similar_tasks`); the daemon
  computes hours (the basis's median lane time) and the bucket. With an empty basis, Claude writes `size`; hours are
  that bucket's median over finished tasks, or the bucket's midpoint until it holds 10. A goal's hours are its
  tasks' sum. The XL refusal, ceremony, the preview and the measure read these derived values.
- **The builder's override.** He changes the basis (size stays derived) or pins a bucket. A pinned bucket wins for
  every consumer, with that bucket's median or midpoint as hours, and reads "size set by you". The success measure
  counts derived sizes only and reports overrides beside it.

## 9. Intelligence

**Built:** the judge (`apps/daemon/src/judge/`), `JudgeDecision`, Settings › Decisions and `judge_calls`.

| Who    | Does                                                                                    | When it can't       |
| ------ | --------------------------------------------------------------------------------------- | ------------------- |
| Claude | talks, reads code, splits, picks bases, writes every proposal field, specs, attachments | (it is the session) |
| Jev    | three nudges, below                                                                     | no chip             |
| Daemon | validation, hours and buckets, the preview, Convert                                     | (deterministic)     |

**Designed.** `JudgeDecision` gains three decisions, each with `enabled`, model (default `typesafe/jev-1.13`) and
floor (default 0.8) in Settings › Decisions:

| Decision          | Asked after each builder message                                    | Chip                               | Shadow answer compared with                           |
| ----------------- | ------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------- |
| `shape_ready`     | "Has the builder said enough to propose?" (until the first Propose) | "Enough to propose · n asks heard" | Propose pressed within his next two messages          |
| `shape_record`    | "Does this message state a decision or principle worth recording?"  | "Record as a decision?"            | a record citing the message kept (Keep, or converted) |
| `shape_elsewhere` | "Is this a question only someone else can answer?"                  | "Question for someone else?"       | a question citing the message converted               |

- State: the message and the 10 before it, fenced as data. Cost: a 5,000-token call is about $0.0002 at Jev's
  $0.042 per million input tokens (the judge spec §1). Claude's messages are never judged.
- **Shadow first.** Each decision ships logging, not showing. A shadow answer is scored when its outcome is known:
  a message no record (or question) cites counts as "no" once the conversation converts or is idle for 7 days; a
  citing row still pending isn't scored until it's kept, converted or dropped. Settings shows each decision's
  agreement; it can be switched to showing once it has 20 scored answers at or above its floor and 75% agree.
  **(spec's call: 20 and 75%)**
- A chip acted on becomes a builder action: a record or question row, builder-authored and pinned. Jev never
  writes.

## 10. Records, preview, attachments and landings

### 10.1 Records

Decisions and principles proposed in the sidebar are 10db's internal Orgtools for the project. **Built:**
`decisions` and `insertDecision`. **Designed (M3, `docs/superpowers/plans/2026-10-22-10db-11-m3-knowledge.md`):**
the `principles` table, supersede, retire and withdraw. If M3's data task hasn't landed when slice 3 starts, slice 3
builds the `principles` table and withdraw to M3's plan, so M3 adopts them unchanged. **(spec's call)**

### 10.2 The factory preview

**Designed.** Each round, the daemon simulates the draft with the picker's inputs: "Most tasks at once", areas,
dependencies and each task's lane time. Work already running or queued in the project holds its lanes first, for
its remaining estimate: its derived hours less its lane time so far, or, for a task never sized (filed by hand or by
adoption), the project's median lane time per finished task less its lane time so far, floored at zero
**(spec's call)**. The preview shows lanes, the critical path
in blue, area clashes in yellow ("Compact density and Shape view both claim `desktop`: they'll run one after the
other"), the total in lane hours, and an end estimate: the lane schedule plus, per task, the project's median
non-lane time per finished task (queueing, review waits, CI), marked "estimate". A preview never writes.

### 10.3 Attachments, safely

Everything the session writes can be shaped by a pasted document, so nothing it writes runs code or reaches the
network:

- **HTML mockups** render in `<iframe sandbox>` with neither `allow-scripts` nor `allow-same-origin`, through
  `srcdoc`, under `default-src 'none'; style-src 'unsafe-inline'; img-src data:`. They can't reach the daemon
  token, the Tauri IPC or the network.
- **Charts** are Vega-Lite with inline `data.values` only; the zod schema refuses `data.url` and every URL-bearing
  field, and the loader refuses network loads.
- **Mermaid** runs at `securityLevel: 'strict'`.
- **Chat and row text** render Markdown without images or raw HTML; a link shows its URL and opens in the system
  browser only on click.
- **Tests:** a mockup with a `<script>` and a `fetch`, a chart with `data.url` and a Mermaid `click` directive
  each render inert.

The renderers are new dependencies (Mermaid, Vega-Lite and its embedder), pinned exactly, latest stable.

### 10.4 Landings

**Built:** a task's landing (`base`, `branch`, `hold`; `packages/contracts/src/landing.ts`); starting tasks in
separate copies makes one batch, and so one branch and pull request, per dependency group (`groupByDependency`,
`apps/daemon/src/delivery/grouping.ts`); a group's tasks must share a landing (`sharedLanding`); `tendb join` adds a
task to an open batch by hand.

The builder's words: "It's honestly kind of crazy that we have 300+ PRs which mean 300+ CI gates… I work in big
shifts and am fine updating the app / main much more seldomly." Today nearly every task becomes its own batch.

**Designed.**

- Claude proposes `landings[]`, leaning to fewer, bigger pull requests: by default one per goal, and loose tasks
  that chain, or touch the same area, in one. A task in no landing lands alone, as today. The builder can move a
  task between landings, split or merge them in the sidebar; each edit pins.
- Each landing row reads "Real areas · 6 tasks · 1 pull request", and the factory preview's summary counts pull
  requests and CI runs ("4 pull requests instead of 9").
- **Convert** writes each landing as a `landing_groups` row (id, project, title, shape) and sets
  `tasks.landing_group_id` on its tasks.
- **Starting.** `groupByDependency` also joins tasks that share a landing group, so Start Ready Tasks puts a
  landing's ready tasks in one batch. A task of the group started later joins the group's batch while it is still
  open, as `tendb join` does; once that batch has shipped, it makes a new one and its card says why. **(spec's
  call)**
- A landing's tasks must share placement and landing target; validation refuses one that doesn't (`sharedLanding`'s
  rule, checked at proposal time instead of at start).

## 11. Convert

**Designed.** `POST /shapes/:shapeId/convert { proposalIds }`. While a turn runs, it answers 409 with "Claude is
still answering; Stop or wait", and the modal offers both. Otherwise it holds the conversation (new turns queue)
and, in one SQLite transaction:

- inserts the selected efforts in dependency order across efforts (a goal or loose task after every effort it
  depends on), keeping a key-to-task map: goals through the adopt store functions, which write in the caller's
  transaction (`packages/db/src/store/goals.ts`; `insertGoal` gains its key-to-task map as a return value and an
  optional map of outside keys for `dependsOnOutside`), loose tasks in Backlog through `insertTask`, additions
  under their goals through `insertGoalTask`;
- writes kept landings as `landing_groups` and sets their tasks' `landing_group_id` (§10.4);
- applies changes through `patchTask` and removals through the task-removal service, each refused if its task has
  started since it was proposed;
- writes kept decisions (`insertDecision`, source `shape`, at the record's scope) and principles (§10.1);
- stores questions in `shape_questions` for goals phase 3 (nothing is sent), and specs, the eval and attachments in
  `shape_attachments`, linked to the created goal or task;
- links every created row to the shape (`shape_links`) and marks its proposal accepted.

**Partial selection.** A selected task that depends on an unselected pending proposal is refused by name ("Thin
scrollbars depends on Compact density, which isn't selected"); the modal offers to add it. A key of a converted
proposal resolves to its created task through `shape_links`, so a later Convert can depend on an earlier one. A
refusal writes nothing and lists each error. Nothing starts.

**Undo.** **Built:** removing an unstarted task. **Designed (slice 1; the builder chose to build them here):**

- **Remove Draft Goal**, in a goal's menu and drawer: allowed while every task of the goal is unstarted; removes
  the tasks (the task-removal service), the criteria and the goal in one transaction, and marks the shape's goal
  proposal `pending` again, so it can be edited and converted anew. Goals phase 2's Cancel covers started goals.
- **Withdraw Decision**, in the decision's row in Knowledge: the `decisions.withdrawn_at` tombstone of M3's plan
  (`docs/superpowers/plans/2026-10-22-10db-11-m3-knowledge.md`, "decisions gain a withdrawn tombstone"); a withdrawn
  decision leaves context packs and searches. M3 adopts the column as built.
- A principle is withdrawn the same way once it exists (§10.1); a landing group is removed with its last unstarted
  task, or ungrouped from the task's drawer.

Convert has no undo of its own beyond these.

## 12. After Convert

**Designed.**

- A goal's and a task's drawer gains **Open conversation**. `POST /shapes/:shapeId/resume { event }` reopens a
  conversation with an event injected as a note, so the engine's cards (exhausted tasks, Flip; goals phase 2) can
  offer **Re-plan in Shape** once they exist.
- The reopened session sees each converted row as its created goal or task with its current state, read-only.
- Re-planning makes new proposals only: `additions`, `changes` and `removals` (§6). Only unstarted tasks change; a
  goal's criteria stay the owner's.

## 13. Data

**Designed.** v0.1.0 has shipped, so every change is a forward migration made by `drizzle-kit generate`
(`packages/db/AGENTS.md`); the FTS5 index over finished tasks' titles and descriptions for `similar_tasks` is a
hand-written `--custom` migration. Changes to existing tables: `sessions.workstream_id` nullable and
`sessions.shape_id` added, with a check that exactly one is set (§5.1); `tasks.landing_group_id` (§10.4);
`decisions.withdrawn_at` (§11); the `proposals` columns of §6; the project setting `oneWayPaths` (§7). New
tables:

| Table               | Holds                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `shapes`            | id, project, title, state (`listening \| proposed \| converted`), SDK session id, propose unlocked, round, created, updated |
| `shape_messages`    | §5.3                                                                                                                        |
| `shape_files`       | a dropped file's name, type, size and stored path                                                                           |
| `shape_findings`    | §7                                                                                                                          |
| `shape_attachments` | kind (`mermaid \| chart \| mockup \| spec \| eval`), body, target (proposal key, or created goal or task)                   |
| `shape_questions`   | text, for, source messages, the goal or task it belongs to                                                                  |
| `shape_links`       | shape, proposal, created goal, task or decision                                                                             |
| `landing_groups`    | id, project, title, the shape that proposed it                                                                              |

Contracts: `ShapeDto`, `ShapeMessageDto`, `PlanDraft`, the proposal bodies and the MCP tool inputs, in
`@10db/contracts`. Events: `shape.changed`, `shape.message`, `proposal.created` and `proposal.resolved` (existing),
`gate.started`, `gate.finished`.

## 14. Slices

All in scope; this is build order. Each slice ships something usable.

1. **Core.** `PlanDraft` and the Shape contracts; `shapes`, `shape_messages` and `shape_links`; Shape sessions on
   `sessions` (§5.1) with confinement (§5.2), turns and resume; `note_heard` and `propose_plan` with validation
   (dependencies across efforts included) and rounds; the Shape view with a read-only sidebar; Convert for goals,
   loose tasks and decisions; Remove Draft Goal and Withdraw Decision (§11); Shape Work… in Factory. Acceptance: the
   six-item list.
2. **Editing and input.** Editable rows, pins, Restore, Drop; file drop and pasted screenshots; a check that macOS
   dictation works in the Tauri window's input.
3. **Intelligence.** `gate.started`/`finished` and lane-time reconstruction; `similar_tasks`, bases, derived sizes;
   the three Jev decisions in shadow, their scoring and Settings rows; records with principles (§10.1); questions.
4. **Ceremony and eval.** The `oneWayPaths` setting; the ceremony rule, `write_spec`, the reviewer agents,
   findings; the proposed eval.
5. **Preview, attachments, reopen.** The factory preview; Mermaid, charts and mockups with §10.3's tests; Open
   conversation, the resume route, re-plan additions, changes and removals.
6. **Landings.** `landings[]` in the draft and the sidebar; `landing_groups` and `tasks.landing_group_id`;
   `groupByDependency` joining a landing's tasks and a late task joining its group's open batch; pull request and CI
   counts in the preview.

## 15. Testing

Table-driven and red first (`.claude/rules/testing.md`), with the fake Claude adapter as the session boundary:

- confinement (§5.2) and rendering (§10.3): every row refused or inert;
- validation: one row per error in §6's list;
- rounds: create, update, supersede, a pin kept, restore, a dropped key reused, a change re-proposed after a drop;
- Convert: a full selection, a partial one refused by name, a second Convert depending on the first, a refusal
  writing nothing, a turn running (409);
- lane time against a recorded workstream with a gate that waited for its slot;
- Jev scoring: each outcome row in §9;
- the preview: two tasks clashing on an area, work already queued holding a lane, unsized running work;
- undo: Remove Draft Goal refused once a task has started, and leaving nothing behind when allowed; a withdrawn
  decision missing from search and the context pack (read back through search, `.claude/rules/testing.md`);
- landings: two unrelated tasks of one landing starting into one batch, a late task joining the open batch, a
  late task after the batch shipped making a new one, a landing with mixed placements refused;
- accounts: a Shape session's usage counted on the project's account, a rate-limit pause queueing turns;
- the view: one render test per state of the wireframe, axe in Playwright.

## 16. Open, and the spec's calls

**Open (the builder's):**

- **The name.** "Shape" is a placeholder.
- **Image mockups.** Claude draws Mermaid, charts and HTML mockups; image-style mockups need an image model,
  perhaps through OpenRouter. In or out?
- **Where a spec ends up.** The goals decision keeps briefs out of the repository. Does an effort's spec stay an
  attachment, or does a docs task commit it under `docs/superpowers/specs/`?
- **Orgtools mirror.** Shape loads no project MCP servers, so mirroring is the daemon's job after Convert:
  automatic when the project names an Orgtools connection, or offered per record?
- **The Heard so far echo** is a little generation before Propose. Keep it?

**Decided by the builder (2026-11-02):** full scope, slices are order only ("I'd rather just boil the lake
here"); Claude writes every field and Jev only nudges; proposals come as goals, loose tasks, records and questions;
Convert's undos are built in slice 1; landings are in scope as slice 6.

**The spec's calls, to confirm:**

- the idle timeout (§5.1) and Shape sessions on the project's account, as `sessions` rows (§5.1);
- no harness plugin in a Shape session (§5.2);
- the transcript digest (§5.3) and the file limits (§5.4);
- dependencies across efforts, and re-planning only this conversation's tasks (§6);
- the ceremony thresholds and the `oneWayPaths` setting (§7);
- the size buckets (§8) and the estimate for unsized work (§10.2);
- the shadow gate of 20 answers and 75% (§9);
- slice 3 building the principles table if M3 hasn't (§10.1);
- a late task joining its landing's open batch (§10.4).
