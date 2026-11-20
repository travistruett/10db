# 10db: Plan becomes part of Sessions

**Status:** designed on 2026-11-19, not built. **Replaces** the Plan view (`views/shape/`) as its own nav item.
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
  never rewritten; each round's changes are marked. The e2e flow checks a pinned item survives a round.
- Accept and Start floods the factory. It queues through the scheduler like Start Ready Tasks, within the
  project's concurrency, and the confirm says how many start now and how many wait.
- A provider can't run a review. The Review menu shows only what runs there, and says what's missing.

**Calls you might disagree with.**
1. No Propose button: the panel fills as you talk. You can still say "propose it now". **Decided:** auto;
   a switch to gate it is added only if it proves noisy.
2. No planning mode. A session has a Plan as soon as the agent proposes something or you open the panel.
3. File as Tasks and a chat sealing into a task both retire into Accept: a chat or a file becomes tasks
   and/or a goal with its tasks in the panel, then Accept (or Accept and Start for a one-task fix).
   **Decided.**
4. Word and PowerPoint files are turned into text by 10db; every other text file is accepted as is.

**Needed from you:** nothing; calls 1 and 3 are decided.

## 1. The session's workflow

A session moves through these states; the Plan panel shows in any of them once it has an item or is opened.

| State | What it is | The builder's actions |
| --- | --- | --- |
| Talking | The conversation, read-only (Sessions §1.1) | Send, drop files, dictate; **Show Plan** |
| Planning | The Plan panel holds items | Edit, pin, remove an item; **Approve** a mock-up; **Review ▾**; **Accept ▾** |
| Reviewing | A review runs; its findings land on the items | Resolve or dismiss a finding; ask the agent to fix it; **Stop Review** |
| Accepted | Some or all items are on the Board | **Undo Accept** while nothing started; open an item on the Board; keep talking |
| Running | Accepted tasks run in their own sessions | Open a task's session; the panel shows each task's live state |
| Working | The session itself changed files (Sessions §1.2) | The title row's git steps, as today |

States are not exclusive: a session that plans can also edit code once the builder asks it to; the first
change still asks Here or On a New Branch (Sessions §1.2), and Changes and the git steps appear then.

## 2. The Plan panel

Side by side with the conversation wherever both fit: the conversation keeps at least 520 px and the panel
420-480 px, and while the panel is open the Sessions list folds to the rail, as the frame folds by width.
The builder talks while the plan fills, so the two are read together. Where both can't fit, the panel is a
wide drawer (about 560 px) over the conversation, with its own close (the Plan split pane's rule). The
widths are settled from screenshots of slice 1. When the session also has changes, the column's head
switches **Plan | Changes**.

- **Head:** "Plan", the counts in words ("2 goals · 9 tasks · 3 decisions"), **Review ▾** and **Accept ▾**.
- **Goals**, each with its tasks; then **Loose tasks**; **Decisions**; **Questions** still open. A row shows
  its title, its size, a dot for its state (proposed, changed this round, pinned, accepted, running, done)
  and its findings count. Click opens it in place: description, acceptance criteria, its mock-ups, Why?
- **Tick per row**, on by default: Accept takes the ticked rows.
- **Mock-ups** show under their task as a thumbnail; open draws the sandboxed HTML. **Approve** marks it the
  design target; **Ask for Changes** puts a draft in the composer naming it.
- **Source files** the builder dropped list at the foot; at Accept they are linked to the goals they fed.
- **After Accept** a row reads "On the Board" with its live state (Queued, Running, Ready, Done) and opens
  the task's session.

## 3. How the agent plans

- Every session has the planning tools that Plan has today (`propose_plan`, `write_spec`, `report_finding`,
  `attach`, `find_records`, `note_heard`); `tools.ts`' Propose gate is removed.
- **New Plan** starts the session with the planning instructions: turn what the builder brings into goals
  and tasks, ask what is unclear, record decisions, make a mock-up for UI work, propose as things are
  decided, never rewrite a pinned item. Any other session gets the same instructions the first time the
  agent proposes or the builder opens the panel.
- A round is one `propose_plan` call; the panel marks what it changed. Rounds, pins and validation are the
  Plan engine's, unchanged (`shape/rounds.ts`, `validate.ts`).

## 4. Review

**Review ▾** runs on the ticked items; each finding lands on its item and in the conversation.

| Review | What it reads | Built? | Providers |
| --- | --- | --- | --- |
| Plan review | the goal's spec (`write_spec`), scope and engineering reviewers | Built (`shape/review.ts`) | Claude; not Codex (no subagents) |
| Check for Questions | each task, read as the agent about to build it would, for the questions it would have to ask (missing facts, unmade choices); they land on the task, so they are answered while planning, not mid-run | Built (the engine's "rehearsal") | Claude; not Codex |
| Design review | each UI task's approved mock-up and the app's screenshots, against `DESIGN.md` | **New** | Claude; Codex runs it in the session itself |

Accept warns on open findings and never blocks (the Convert rule).

## 5. Accept

- **Accept** writes the ticked items as Convert does today (`shape/convert.ts`): goals and their tasks,
  loose tasks, decisions and principles to Knowledge, approved mock-ups and source files linked to their
  goal or task. Nothing starts.
- **Accept and Start** (in Accept's menu) also starts the accepted tasks that are ready, through the same
  path as Start Ready Tasks; the confirm says "4 start now, 5 wait for a lane".
- **Undo Accept** removes what it wrote while none of it has started (`shape/undo.ts`).
- Talking on after Accept proposes new rows; Accept again takes only what is new or changed.
- A started task's lane gets its approved mock-up and its plan section in its brief.

## 6. Files

- Any file whose bytes are text is accepted, whatever its extension (`.vtt`, `.srt`, `.csv`, `.json`,
  code); PDFs and images as today; `.docx` and `.pptx` are turned into text by 10db at upload. The 20 MB and
  20-file limits stay. The extension allowlist (`dropped-files.ts`, `shape-files.ts`) becomes a content check.
- Claude Code reads PDFs and images itself. **To verify before building:** what Codex does with a PDF; where
  it can't read one, 10db hands it the PDF's text.

## 7. What goes away

- The Plan nav item and `/shape` routes in the desktop; **New Plan** is in the Sessions panel's new-session
  menu and on ⌘⇧N. Factory's "Planned in …" links open the session.
- The Propose button and its hints.
- Sessions' **File as Tasks** and a chat sealing into a task (`HandedOffLine`): both become Accept.
- Existing Plan conversations: none are kept. The baseline migration is regenerated without them, so a
  local database starts with no plans (the builder's call: this is new, nothing to carry over).

## 8. Data (for the plan)

- A chat gets an optional plan: the `shapes` row moves from owning its conversation to pointing at the chat.
  Proposal, link, attachment, finding and rehearsal tables keep their keys.
- No data migration: the baseline is regenerated (`packages/db/AGENTS.md`), and existing plans are wiped.
- `shape_attachments` gains an approved mark.

## 9. Provider parity

Talking, the panel, edits, mock-ups, Accept and Accept and Start work on every account. Plan review and
Check for Questions need subagents, so on Codex Review offers Design review only and says the other two need a Claude
account. Files: PDF reading per §6.

## 10. Build order

1. The Plan panel in a session; New Plan; the Plan view removed.
2. Planning tools in every session; no Propose gate; rounds marked in the panel.
3. Accept and Accept and Start, Undo Accept; live states after Accept; File as Tasks retired.
4. Review menu (plan review and Check for Questions wired in); approved mock-ups and their hand-off to lanes.
5. Design review. Files by content, `.docx` and `.pptx` to text.

Each slice extends `e2e/sessions.spec.ts` once; no new unit tests beyond the file check.
