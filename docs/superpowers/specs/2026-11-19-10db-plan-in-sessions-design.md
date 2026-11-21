# 10db: Plan becomes part of Sessions

**Status:** designed on 2026-11-19; slices 1-4 are built. **Replaces** the Plan view (`views/shape/`) as its own nav item.
**Keeps** the Plan engine as built: proposals, rounds, pins, reviewers, rehearsal, attachments, Convert
(`2026-11-02-10db-brainstorm-chat-design.md`), and the Sessions life as built
(`2026-11-17-10db-sessions-simplified-design.md`).

## Brief

**What changes for you.** There's one place to talk: a session. Any session can grow a **Plan**, a panel
beside the conversation that holds the goals, tasks, decisions and mock-ups taking form as you talk. **New
Plan** opens a session with the panel open, ready for a dropped document or a first message. The agent fills
the panel as things are decided; you edit, pin or remove items, approve mock-ups, and run **Review** (plan
review, Check for Questions, design review) when the work looks ready. **Accept** puts the ticked work on the
Board; **Accept and Start** also starts it, one session per task, and the panel then tracks each one
live. The Plan nav item, the Propose button and Sessions' File as Tasks go away.

**What it buys.** It replaces your background session writing a changelog, decision log and project plan
by hand. The plan is formal, reviewed and on the Board in one flow, and you can watch the 1-10+ sessions it
starts from the conversation that planned them.

**What could go wrong, and how we'd know.**
- The agent churns the panel every turn. It updates only what the conversation decided; pinned items are
  never rewritten; each round's changes are marked; a fresh session after the context limit starts from the
  plan as it stands, so it can't sweep rows away by forgetting them. The e2e flow checks a pinned item
  survives a round.
- Accept and Start floods the factory. It queues through the scheduler like Start Ready Tasks, within the
  project's concurrency, and the confirm says how many start now and how many wait.
- The migration loses something it shouldn't. It deletes only plans that fed nothing on the Board; a plan
  that made tasks becomes an archived session. A test checks the tasks keep their plan context and the rest
  of the database survives.

**Calls you might disagree with.**
1. No Propose button: the panel fills as you talk. You can still say "propose it now". **Decided:** auto;
   a switch to gate it is added only if it proves noisy.
2. No planning mode. A session has a Plan as soon as the agent proposes something or you open the panel.
3. File as Tasks and a chat sealing into a task both retire into Accept. **Decided.** The agent's own
   `create_task` and `save_decision` tools stay, for "just file this".
4. Word and PowerPoint files are turned into text by 10db; every other text file is accepted as is.
5. **Existing plans: a forward migration**, not a regenerated baseline (v0.1.0 has shipped, so a
   regenerated baseline would refuse your whole database, `packages/db/AGENTS.md`). Plans that fed nothing on
   the Board are deleted; a plan that made tasks becomes an archived session, because its tasks' lane
   briefs carry its plan block (`task_context`). **Decided.**
6. A planning session runs as a session does (your setup, its sandbox, the judge), not as today's read-only
   Plan; Plan's reviewers, rehearsal and researcher join it as 10db's own agents.
7. On Codex the three reviews run inside the session itself, without separate reviewers, and say so; a
   follow-up task adds separate reviewers when Codex can run them.
8. The Record view stays, reached from the panel and from Factory's "Planned in …".

**Needed from you:** nothing; calls 1 and 3 are decided, the rest follow from them.

## 1. The session's workflow

A session moves through these states; the Plan panel shows in any of them once it has an item or is opened.

| State | What it is | The builder's actions |
| --- | --- | --- |
| Talking | The conversation, read-only (Sessions §1.1) | Send, drop files, dictate; **Show Plan** |
| Planning | The Plan panel holds items | Edit, pin, remove an item; **Approve** a mock-up; **Review ▾**; **Accept ▾** |
| Reviewing | A review runs; its findings land on the items | Resolve or dismiss a finding; ask the agent to fix it; **Stop** |
| Accepted | Some or all items are on the Board | **Undo Accept** while nothing it wrote started; open an item on the Board; keep talking |
| Running | Accepted tasks run in their own sessions | Open a task; the panel shows each task's live state |
| Working | The session itself changed files (Sessions §1.2) | The title row's git steps, as today |

States are not exclusive: a session that plans can also edit code once the builder asks it to; the first
change still asks Here or On a New Branch (Sessions §1.2), and Changes and the git steps appear then.

### 1.1 What interrupts what

| While | This happens | Then |
| --- | --- | --- |
| A turn runs | Builder presses Accept | Accept takes the rows as they stand; the turn goes on. A round that lands after it shows as new or changed rows for the next Accept. Convert's "still answering" refusal goes. |
| Builder edits a row | A round changes that row | The editor keeps the builder's text and says "The agent changed this"; Save pins the builder's version. |
| A round lands | Builder pins or removes a row | Last write wins per row; a pinned row is never rewritten by a later round. |
| A Review turn runs | Builder sends a message | It queues behind the review turn, as any message does. |
| A Review turn runs | Stop, Archive, a move to a branch, or a daemon restart | The turn ends; tasks it didn't read show "Not checked"; findings already written stay; Review can run again. |
| A turn runs | Builder opens the panel | The panel opens, empty or not; the planning instructions are already in the session's prompt (§3), so nothing is injected. |
| Accept and Start | Some tasks can't start (a dependency, no free lane) | The confirm counts them ("4 start now; 3 wait for a lane, 2 for other tasks"); they stay Queued and the panel shows each one's state. |
| Undo Accept | The scheduler starts one of its tasks | Undo checks, in its own write, that nothing it would remove has started; if one has, it refuses and names it. |
| A session plans | Tasks it accepted run | Lanes work in their own worktrees. A session that hasn't chosen where to work holds no checkout and never waits; one that chose Here shares the checkout as Sessions §1.3 says. |
| A session with a plan | Archive | The plan, its files and its links stay; the session reopens with them; "Planned in …" opens it, archived or not. |

## 2. The Plan panel

Side by side with the conversation wherever both fit: the conversation keeps at least 520 px and the panel
420-480 px, and while the panel is open the Sessions list folds to the rail, as the frame folds by width.
The builder talks while the plan fills, so the two are read together. Where both can't fit, the panel is a
wide drawer (about 560 px) over the conversation, with its own close (the Plan split pane's rule). The
widths are settled from screenshots of slice 1. When the session also has changes, the column's head
switches **Plan | Changes**.

- **Head:** "Plan", the counts in words ("2 goals · 9 tasks · 3 decisions"), **Review ▾**, **Accept ▾** and a
  ⋯ with **Record**, **Export** and the Board preview (how the lanes would run the draft, Plan's preview
  panel as built).
- **Goals**, each with its tasks; then **Loose tasks**; **Decisions**; **Questions for others** (Plan's
  question proposals, for a person or role). A row shows its title, its size, a dot for its state (proposed,
  changed this round, pinned, accepted, running, done) and its findings count. Click opens it in place:
  description, acceptance criteria, its mock-ups, Why?
- **Tick per row**, on by default: Accept takes the ticked rows (in its modal; the panel itself has no ticks, and Review ▾ reads every pending row).
- **Mock-ups** show under their task as a thumbnail; open draws the sandboxed HTML. **Approve** marks it the
  design target; **Ask for Changes** puts a draft in the composer naming it.
- **Source files** the builder dropped list at the foot; at Accept they are linked to the goals they fed.
- **After Accept** a row reads "On the Board" with its live state (Queued, Running, Ready, Done) and opens
  the task on the Board, whose drawer opens its session (Sessions §6.7).
- "Heard so far" (`note_heard`) shows at the panel's top while the plan has no rows.
- **Plan measures** (sizing and question calibration) move to the project's settings, beside rigor.

## 3. How the agent plans

- A session with a plan has Plan's tools as built (`shape/tools.ts`) beside its chat tools; slice 2 gives
  every session both. `tools.ts`' Propose gate and the imported plan's refusal are removed.
- **The session's profile wins.** The builder's setup, the session's sandbox and judge, the web and any
  `Agent` run as in every session (Sessions §1). Plan's read-only confinement (`shape/confinement.ts`,
  `judgeShapeCall`) does not run there: it has no hard-limit reason in a session that may edit code.
- **Plan's agents join the session** as 10db's own agents, named with a `tendb-` prefix (`tendb-scope`,
  `tendb-engineering`, `tendb-rehearsal`, `tendb-researcher`, `tendb-code-researcher`). `report_finding` and
  rehearsal marks still come only from a subagent of one of those types, and the reviewer is stamped from
  the type: this is 10db's bookkeeping of who reviewed, not a limit, so a builder's own agent of the
  same name is the builder's choice. On an account without subagents (Codex),
  the main session may report findings during a Review turn, stamped with the review that turn runs.
- **The planning instructions** are part of a session's system prompt from its start: every session with a
  plan in slice 1, every session from slice 2. They are Shape's prompt (`shape/policy.ts`) rewritten: no
  "read-only", no Propose gate; propose as things are decided; never rewrite a pinned item; ask what is
  unclear; record decisions; make a mock-up for UI work. **New Plan**'s first message carries one line
  telling the agent the builder came to plan.
- **The digest** that starts a fresh session (the context limit, a model change) carries the plan's rows as
  they stand (`shape/digest.ts`), after the chat's own digest, so a round after a restart restates the plan
  rather than dropping what it forgot.
- **One plan per session** (a unique key). New Plan starts on the Plan role's model and effort; the session's
  model menu changes it after.
- A round is one `propose_plan` call; the panel marks what it changed. Rounds, pins and validation are the
  Plan engine's, unchanged (`shape/rounds.ts`, `validate.ts`).
- The owner hooks: the chat's (`chat/hooks.ts`) own the conversation. When the chat has a plan they add the
  plan's parts from `shape/explore-owner.ts`: the prompt and agents, the digest, the file intake lines, and
  the end-of-turn checks (a review that didn't read every task). The Plan owner is removed.

## 4. Review

**Review ▾** runs on every pending goal and loose task (the panel has no ticks; the ticks are Accept's modal); each finding lands on its item and in the conversation.

| Review | What it reads | Built? | Claude | Codex |
| --- | --- | --- | --- | --- |
| Plan review | the goal's spec (`write_spec`), scope and engineering reviewers | Built (`shape/review.ts`) | separate reviewers | in the session; says it ran without separate reviewers |
| Check for Questions | each task, read as the agent about to build it would, for the questions it would have to ask (missing facts, unmade choices); they land on the task, so they are answered while planning, not mid-run | Built (the engine's "rehearsal") | a rehearsal agent per task | in the session, one task after another; says so |
| Design review | each UI task's approved mock-up against the project's screenshots and its `DESIGN.md` where it has one | **Built** (slice 5) | a design reviewer | in the session |

Accept warns on open findings and never blocks (the Convert rule). A follow-up task gives Codex separate
reviewers once it can run subagents.

## 5. Accept

- **Accept** writes the ticked items as Convert does today (`shape/convert.ts`): goals and their tasks,
  loose tasks, decisions and principles to Knowledge, approved mock-ups linked to their goal or task. Source
  files are linked to the goals whose rows cite them (new: §8); a row cites a file by its id beside the
  message ids it cites, and validation accepts either. Nothing starts.
- **A plan of more than five goals** asks for the builder's cut (needed, later, cut) in Accept's confirm, as
  Convert does today (`shape/milestone-cut.ts`); an unticked goal counts as later.
- **Accept and Start** (in Accept's menu) also starts the accepted tasks that are ready, through the same
  path as Start Ready Tasks; the confirm says what starts and what waits (§1.1).
- **Undo Accept** is new (`shape/undo.ts` has only Remove Draft Goal and the two Withdraws). Each Accept is
  recorded with what it wrote; Undo removes that Accept's new goals and tasks and withdraws its decisions and
  principles (Knowledge tombstones, as Withdraw does), while none of its tasks has started. An Accept that
  also changed or removed existing Board tasks says so in its confirm and offers no undo for those changes.
- Talking on after Accept proposes new rows; Accept again takes only what is new or changed.
- A started task's lane gets its approved mock-up and its plan section in its brief.

## 6. Files

- Any file whose bytes are text is accepted, whatever its extension (`.vtt`, `.srt`, `.csv`, `.json`,
  code); PDFs and images as today; `.docx` and `.pptx` are turned into text by 10db at upload. The 20 MB and
  20-file limits stay. The extension allowlists (`apps/daemon/src/shape/dropped-files.ts`,
  `apps/desktop/src/conversation/dropped-files.ts`, `shape-files.ts`) become a content check.
- A session with a plan keeps its files in the plan's folder (`<data>/shapes/<id>`), not the chat folder, so
  Archive never deletes them. The session may read that folder as it reads its chat folder: it is added
  to the Claude hook's file access and to Codex's sandbox.
- Claude Code reads PDFs and images itself. **Verified in slice 5's research:** Codex 0.167.0
  (`codex-generated/ts/v2/UserInput.ts`) takes only `text`, `image`, `localImage`, `audio`, `skill` and `mention`
  input, and its `view_image` reads PNG, JPEG and WebP only, so it can't read a PDF; this Mac has no `pdftotext`.
  10db extracts the PDF's text at upload with `unpdf` (bundled into the daemon) and keeps it beside the PDF as
  `<stored>.txt`; a Codex session's intake line points at that text file, and a PDF with no text (a scan) says so
  to Codex only, since Claude reads the scan itself.

## 7. What goes away, and where the rest goes

| Today | After |
| --- | --- |
| The Plan nav item, `/shape` and `/shape/$shapeId` | Gone. **New Plan** is in the Sessions panel's new-session menu and on ⌘⇧N. |
| `/shape/$shapeId/record` (the Record view) | Moves under the session; opened from the panel's ⋯ and Factory's "Planned in …". |
| Links to a Plan: rail, `board-view.tsx`, `task-drawer.tsx`, `plan-context-disclosure.tsx`, `goal-line.tsx`, `factory/planned-in.tsx`, `goal-detail.tsx`, `open-conversation.tsx` | Open the plan's session. |
| The Propose button and its hints | Gone. |
| Sessions' **File as Tasks** | Accept. `HandedOffLine` stays, for the sealed chats that still exist. |
| `start_shape` (terminal and chat tool), `ShapeOrigin.ClaudeCode` | Starts a New Plan session. |
| Plan import (`/projects/:id/plans/import`, `import_plan`) | Imports into a new session with a plan; its rows arrive pinned, so rounds never rewrite them. |
| Re-plan in Shape (`POST /shapes/:id/resume`) | Opens the plan's session. |
| The Plan model menu | The session's model menu. |
| `see_screen`'s `plan` screen | Takes a session id and draws that session with its Plan panel open. |
| Existing Plan conversations | Deleted when they fed nothing on the Board; otherwise archived sessions with their plan (§8). |

## 8. Data (for the plan)

- `shapes` gains `chat_id`, unique: a chat has at most one plan, and the plan no longer owns a conversation.
  `ConversationOwnerKind.Shape` goes; the plan's messages are the chat's conversation items. Proposal, link,
  attachment, finding and rehearsal tables keep their keys.
- **One forward migration.** A plan fed the Board when a `task_context` or `landing_groups` row names it, or
  one of its links names a goal or task. Such a plan gets an archived chat row whose conversation is the one
  it owned (`owner_kind` becomes chat), and `shapes.chat_id` names it. Every other plan is deleted with its
  rows, its conversation and that conversation's items; a session row that named such a conversation keeps
  its row with `conversation_id` set to null. The column is then made required. A migration test (real
  SQLite) checks a database holding both kinds of plan, Board tasks, Knowledge and sessions: the kept plan
  opens as an archived session, its tasks keep their `task_context`, the unused plan is gone, and
  `foreign_key_check` is clean.
- `shape_attachments` gains an approved mark.
- New: an Accept record (which Accept wrote which goal, task and record, for Undo Accept) and a link from a
  source file to the goal it fed.

## 9. Provider parity

| Feature | Claude plan | Bedrock / API key | Codex plan |
| --- | --- | --- | --- |
| Talking, the panel, edits, pins, mock-ups | yes | yes | yes |
| Accept, Accept and Start, Undo Accept | 10db's own writes | same | same |
| Plan review, Check for Questions | separate reviewers | same | in the session, saying so; follow-up task for separate reviewers |
| Design review | a reviewer agent | same | in the session |
| PDFs | Claude reads them | same | per §6 |

## 10. Build order

Each slice ends with something the builder can run.

1. **The move.** The migration and `shapes.chat_id`; the chat's hooks with the plan's parts; Plan's tools,
   agents and prompt in a session with a plan; **New Plan**; the panel (rows, edit, pin, remove, mock-ups,
   Heard so far) with today's Convert as **Accept**, its cut list included; the Plan view and its routes
   removed, every row of §7 retargeted. Extends `e2e/sessions.spec.ts` (New Plan, a round, a pinned row
   surviving the next, Accept) and moves what `e2e/shape.spec.ts`, `see-screen.spec.ts` and
   `window-csp.spec.ts` check about Plan into it.
2. Every session can grow a plan: **Show Plan**, the prompt and tools in every session; rounds marked in the
   panel; File as Tasks retired.
3. **Accept and Start**, **Undo Accept**; live states after Accept.
4. **Review ▾** (plan review and Check for Questions, Codex in the session); approved mock-ups and their
   hand-off to lanes.
5. Design review. Files by content, `.docx` and `.pptx` to text; Codex and PDFs.

Tests follow `.claude/rules/testing.md`: the migration (data), the reviewer stamp in a session (the trust
surface), and the file content check (a parser) earn unit tests; `views/shape/attachments/attachments.test.tsx`
moves with the mock-up renderer. Every user-visible piece extends `e2e/sessions.spec.ts`.
