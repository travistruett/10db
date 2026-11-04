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
  conversation; a dropped `.md` brief starts one too. Adopt a Plan… leaves the UI (its modal and hook,
  `apps/desktop/src/views/factory/adopt-plan.tsx` and `use-adopt-plan.ts`, are removed); the adopt route stays for
  briefs made elsewhere (the builder's choice, 2026-11-02).
- **Left, about 45%: the conversation.** Plain text blocks, not bubbles; the builder's in bright text; the list is virtualized, so a long conversation renders only what is on screen (the eng review's call). Tool use
  collapses to one dimmed line ("Read apps/desktop/src/views/board/ (12 files)", "propose_plan · 2 changes ·
  passed"). The input autosizes, takes dropped files and pasted images (§5.4), and holds the group's one filled
  primary, **Propose** (§6). Jev's nudges (§9; D5 below) sit above the input. The header shows the conversation's title and
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

  Every row edits in place (a pencil on hover). The header holds **Rehearse** (§7, `default` variant) and
  **Convert…**, both disabled until a proposal exists. Converted rows stay in the list, dimmed, under the goal or
  task they became ("Converted · on the Board"), and carry their calibration once the task finishes (§8).

- **Before the first Propose** the sidebar shows only **Heard so far** (§6) and one line: "Press Propose when
  you've said enough. Claude will split what you said into goals and loose tasks, size them from tasks like them
  that already ran, and preview how the factory would run them."
- **The Convert modal** is a form modal (DESIGN.md): a checkbox per pending proposal with where it goes ("to
  Backlog", "to Knowledge", "under Real areas"), the line "Nothing starts. Tasks wait on the Board.", and, beside
  the primary **Convert n**, a warning while a review or rehearsal runs, or a finding or rehearsal question is
  open.

| Surface       | Loading                       | Empty                                | Error                                                 |
| ------------- | ----------------------------- | ------------------------------------ | ----------------------------------------------------- |
| Conversation  | the input's `loading` state   | the starter line in the input        | a red `Alert` above the input with the daemon's words |
| Proposed      | its rows' skeleton lines      | Heard so far, or the Propose line    | a red `Alert` in the sidebar; the chat stays usable   |
| Convert modal | the primary's `loading` state | not applicable                       | each refusal as a row, beside the primary             |
| Nav list      | `Loader size="sm"`            | "No conversations yet · Shape Work…" | a red `Alert` "Couldn't load conversations"           |

**Details from the design review (2026-11-02; the builder chose each):**

- **Summary line (D1).** Under the Proposed header, sticky while the list scrolls, one dimmed `sm` line: "1 goal ·
  3 loose · 4 pull requests · ~2 days · 2 to record · 1 open question". Each count jumps to its section; open
  findings and rehearsal questions are counted. It stays visible when the sidebar is a drawer (D7).
- **Row states (D2), one quiet treatment each, no fills, borders or stripes:** pinned = Tabler `pin` (16, dimmed)
  after the title; new or changed this round = a dimmed "new" or "changed" at the row's end until the next round;
  converted = the whole row in dim_0 with "Converted · on the Board"; superseded = only under Earlier; a validation
  error = a red line under the row naming the field (red is failed, DESIGN.md); rehearsing = `Loader size="xs"`;
  an open question = a yellow dot and its count (waiting on you).
- **First run (D3).** With no conversations, Shape opens a new one with the input focused, placeholder "Talk it
  through, drop a document, or paste a list…", and one dimmed line under it: "Nothing is proposed until you press
  Propose. Nothing starts until you Convert." No illustration or tour.
- **Jev's nudges (D5)** are `Button variant="subtle" size="xs"` with a Tabler `sparkles` icon (14) and the
  suggestion, plus × to dismiss; at most two, newest first. DESIGN.md names this pattern.
- **Keys and screen readers (D6).** ⌘↩ sends; ⌘⇧↩ is Propose / Propose Again; Esc stops a turn or cancels a row
  edit. The conversation and the sidebar are labelled regions ("Conversation", "Proposed"). Sidebar rows are a list
  moved through with ↑/↓, as the Inbox's are: Enter edits, Esc cancels, P pins or unpins, W opens Why?. A round's
  summary ("Round 3: 4 changes") is announced through one `aria-live="polite"` region and never moves focus. The
  Convert modal traps focus as form modals do. Axe runs on every state in Playwright.
- **Layout (D7).** A draggable divider splits chat and sidebar: chat at least 420 px, sidebar at least 480 px,
  45/55 by default, remembered per person. Below 1100 px of content width the sidebar becomes a toggleable drawer
  over the chat, with the summary line always visible. Checked at 1440×900 and 1280×720, as the Board is.

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
constraint). Every query that joins `sessions` to `workstreams` is audited (per-project usage joins them today,
`packages/db/src/store/usage.ts`, and would drop a Shape session) and resolves the project through the workstream or
the shape; a test proves per-project usage counts a Shape session's tokens. Making the column nullable is a SQLite
table rebuild of `sessions` (which `handoffs.session_id` references); the generated migration is proven by the
repo's migration and recovery tests on a seeded database, with handoffs intact (the eng review's D2, 2026-11-02;
there is no installed data yet to protect). A rate-limit pause or a cap shows as a notice line in the conversation and queues new turns until the
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
- `tools` lists exactly `Read`, `Grep`, `Glob`, `Agent`, `WebSearch`, `WebFetch` and the Shape tools; the last two
  are listed only so the researcher (below) can inherit them, and the hook refuses them in the main session.
  `disallowedTools` names `Edit`, `Write`, `NotebookEdit`, `Bash` and `Monitor`. Permission mode `default` (not
  lanes' auto); `canUseTool` denies by default. With no Bash, Monitor or MCP server process, the session runs no
  command for a sandbox to hold.
- Path confinement runs in the **PreToolUse hook** through `judgePreToolUse` with a Shape mode of the file-access
  judge that answers **deny** where lanes' answers `ask`, so nothing reaches the broker or raises a card. It runs
  for the session and its subagents alike, so calls Claude Code settles before `canUseTool` are still judged. A file
  tool is allowed only on real paths under the project's checkout or the conversation's files directory (§5.4). A
  symlink out, a protected path, and a `Grep` or `Glob` of a directory holding one are refused, with a dimmed line
  in the conversation.
- `Agent` may launch only the three reviewer definitions (scope, engineering and rehearsal, §7) and the researcher
  (below), passed as programmatic agents, each on the session's own model; the built-in
  general-purpose type is not offered.
- **Research: a researcher agent that cannot read the project** (`decisions/2026-11-03-plan-researches-the-web-through-a-researcher.md`).
  The session cannot touch the network; a fourth agent, `researcher`, has `WebSearch` and `WebFetch` and nothing
  else (no file tool, no `Agent`, no 10db tool). The session gives it a question in words and gets text back with
  the URLs it read. The split keeps the project's code off the network: the agent that reads the code never sends
  a request, and the agent that does holds nothing to send but the question. The hook enforces it:
  - `WebSearch` and `WebFetch` are allowed only with `agent_id` present and `agent_type` `researcher`; from the main
    session or any other agent they are refused. `Read`, `Grep` and `Glob` are refused from the researcher for any
    path, the checkout's and the files directory's alike.
  - **The question is bounded, not filtered:** at most 1,500 characters (a query 300, a URL 2,000), no empty one. The
    session is told to ask in general terms with no code, path or key. Every question, search and fetch shows
    in the conversation as a dimmed line naming it, so the builder sees what left the machine.
  - **A fetched page is untrusted.** The researcher treats pages as data and reports one that tries to steer it; the
    session treats its answer as a claim, follows no request in it, and states what it relies on in its own words
    with the URL, not in the page's. It is a prompt rule, backed by the builder accepting a plan before a lane runs
    a task.
  - **Hosts are open** except those that are not the public web: `WebFetch` must be `https` on 443, with no login in
    the URL, and name a host with a dot that is not an IP address, `localhost` or under `.local`, `.internal` and
    the like, which keeps it off the daemon's loopback port and the builder's network.
  - **Tests, red first:** a `WebSearch` or `WebFetch` from the main session, scope, engineering and rehearsal is
    refused, with a dimmed line; a `Read`, `Grep` or `Glob` from the researcher is refused for a checkout path and
    a files-directory path; a fetch of `127.0.0.1`, `localhost`, a login URL and an `http` page is refused; each
    allowed search and fetch writes its dimmed line. The live test (`TENDB_LIVE_CLAUDE=1`) shows that the
    researcher inherits the session's web tools on the real SDK.
- **Seeing the app: a screenshot tool, never a browser** (`decisions/2026-11-03-plan-sees-the-app-through-screenshots-not-a-browser.md`).
  The session sees 10db's own screens through `see_screen` (§5.5), which answers a picture. It gets no browser
  tool and no MCP server other than 10db's, so nothing it holds can click, type, scroll or run a command: a
  browser would add a process that runs commands, and one click in the real app can Hold a task, answer a card
  or start work. `playwright`, `browser` and any `mcp__` tool other than `mcp__10db__*` are refused by the
  hook as they are now. Tests, red first: a browser tool call and a made-up click or key tool are each refused;
  `see_screen` is refused from the researcher and from each reviewer; the session's tool lists name no browser.
- **Who is calling.** Subagents share the session's MCP connection, so the PreToolUse hook tells them apart: the
  SDK's hook input carries `agent_id` only inside a subagent, and `agent_type` names it. The hook refuses
  `report_finding` when `agent_id` is absent (the main session can't report findings or rehearsal marks), refuses
  every other Shape tool when it is present (a reviewer can't propose), and sets the finding's `reviewer` from
  `agent_type`, never from the tool's input. Test, red first: the main session calling `report_finding` is refused.
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
- **Guards.**
  - A Propose pressed while a Propose turn is queued or running is ignored (the button shows it's pending).
  - A Propose turn that ends with no accepted `propose_plan` call shows "Claude didn't propose; Propose Again" in
    the chat and is logged with the conversation's count of refused `propose_plan` calls.
  - A builder edit and a reconcile each run as one SQLite write, one after the other, so whichever lands second sees
    the other: a pin set before a reconcile is kept by it, and a reconcile before an edit is overwritten by it.
  - **Long conversations.** Past 70% of the model's context window (the SDK's context usage), the daemon moves the
    conversation to a fresh SDK session seeded with the digest below, and notes it in the chat ("Continued in a
    fresh session; nothing is lost"). Compaction stays only as the SDK's emergency fallback, as for lanes
    (factory-loop decision 2).
- **Resume** uses the SDK session id while Claude Code still has it. When it doesn't (its cleanup removes old
  session files), the daemon starts a new SDK session seeded with a digest it builds deterministically: the last 40
  messages verbatim, the current proposals and the conversation's links (§12). The digest is stored as a `note`
  message, so what the new session saw is on record. **(spec's call: a deterministic digest, not a model summary)**

### 5.4 Dropped files

**Designed.** Markdown, plain text, PDF, PNG, JPEG and WebP, at most 20 MB each and 20 per conversation; anything
else is refused on the input with the reason. Files are copied into the conversation's files directory under the
data directory and kept as long as the conversation. Images reach the session as image content blocks; other
files as a line naming the path, which the session reads with `Read`. **(spec's call: the limits)**

The API refuses an image over about 5 MB, an image over 8000 px on a side however few bytes it takes, and a
request over 32 MB, and a resumed session resends every earlier image, so one oversize block would end every
later turn. An image over 2 MiB, over 2000 px on a side, past 6 MiB of images in one message, or past 18 MiB of
pictures across the whole conversation (24 MiB as base64, leaving the 32 MB request about 6 MB), therefore goes
as a path line marked "too large to show inline; Read it", which `Read` resizes itself. The 2000 px is the
API's limit once a request holds more than 20 images: a conversation's screens (up to 12, §5.5) and dropped
images (up to 20) together can pass 20, so a Retina screenshot under 2 MiB sent as a block could fail that turn
and every later one, and it is stricter than the 8000 px limit that holds for any request. The daemon reads the
pixel size from the PNG IHDR, JPEG SOF or WebP header; an image whose size can't be read (cut short, or not what
its name says) goes as a path too, since it would be sent blind. The conversation total is one budget for every
picture a resumed request resends that the daemon sends itself: it counts each dropped image a turn of the live
session sent as a block (`shape_files.inline_sent`, written as the turn is sent) and each screen that session
took (§5.5), and `see_screen` refuses a picture that would pass it. An image sent as a path, for its bytes or pixels or because
the message or the total was full, counts for nothing, so Retina screenshots leave room for twelve screens. A
conversation that existed before the column was added keeps the old count (every told image within both
per-image caps), an upper bound. Twelve screens at their 1.5 MB most fit inside the total, so it only limits
them beside dropped images. A session started fresh (from a digest) resends no earlier block, so it clears the
mark on every file of the conversation: its first message and every later turn of that session count only the
images that session sent. Screens count the same way: only those whose transcript row follows the latest digest,
so the picture is not charged where it is not carried, and `see_screen` is not refused on a screen the digest
told Claude to take again.
A picture Claude pulls in with `Read` is a tool result the daemon never sees, and a resumed session resends it too,
so it has a budget of its own in the session's PreToolUse hook (`shape/read-budget.ts`), sized to the 6.8 MB the
18 MiB leaves. The hook charges each of the session's own Reads of a `.png`, `.jpg`, `.jpeg`, `.gif` or `.webp`
file (a dropped image or one in the checkout) the file's size, at most 1 MiB, since Claude Code resizes what it
reads; a file that isn't there is charged nothing. A Read that would take the live session's total past 3 MiB
(4 MiB as base64, which leaves about 2.6 MB of the 32 MB for the conversation's text) is refused with a reason
that says to work from the pictures already read or ask for a smaller one. Each counted Read is a dimmed
`Read · <path> · picture · <n> bytes counted` transcript line, and the total is the lines after the latest digest, so
it survives a restart and a fresh session starts at zero. A subagent's Read is not counted: its result reaches the
session as text. A Read of a PDF is not counted (a separate task).
**Not measured:** the 1 MiB is an allowance, not a measurement, and the builder chose to ship it that way with a
follow-up task, since a lane can't run a live session. `test/shape-session.live.test.ts` reads a 6 MB noise picture, a
small one and a 4000 px one with a real session, finds the three pictures Claude Code kept in the session's transcript
and fails if one is missing or over the allowance (`TENDB_LIVE_CLAUDE=1`; it prints the sizes). It has not been run.
So the 3 MiB total is a promise only if a Read returns at most 1 MiB: at 2 MiB each, the three Reads it allows carry
8 MB as base64 against the 6.8 MB left, and a request can pass 32 MB. The test also leaves one question open. It reads a
fresh session's stored transcript, which gives an upper bound but doesn't show whether Claude Code drops an old tool
result's picture when it resends. The budget assumes it doesn't, which is the safe side.
The daemon sets these caps; it has not been checked with a live session whether Claude Code shrinks image blocks
that arrive as SDK input, and does not rely on it. **(spec's call: the inline caps)**

### 5.5 Shape MCP tools

**Designed.** Contracts in `@10db/contracts`. The tools are served by the existing `10db` MCP server, so the guard
trusts them as `mcp__10db__*`, under a per-session token on the Shape session's `sessions` row (§5.1). The MCP
handler builds a session's tool set from its row: a lane's tools for a workstream, these for a shape. Subagents
share their session's MCP connection, so what a reviewer may call is set by its agent definition's tool list (§7),
not by the token.

| Tool                                           | Who                | Does                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `note_heard(items)`                            | session            | the Heard so far echo: up to 12 strings of at most 80 characters                                                                                                                                                                                                                                                                                                 |
| `similar_tasks(query)`                         | session            | finished tasks with lane time (§8), matched by FTS over title and description, with lane time, wall time and tokens                                                                                                                                                                                                                                              |
| `propose_plan(draft)`                          | session            | the whole plan (§6); refused until the first Propose                                                                                                                                                                                                                                                                                                             |
| `attach(target, attachment)`                   | session            | a Mermaid diagram, a chart or an HTML mockup on a proposed task or goal (§10.3)                                                                                                                                                                                                                                                                                  |
| `write_spec(effortKey, markdown)`              | session            | an effort's spec (§7)                                                                                                                                                                                                                                                                                                                                            |
| `report_finding(effortKey, taskKey?, finding)` | reviewer subagents | a finding row under the effort, or under one task (§7); the daemon stamps the task's current hash; a rehearsal with nothing to ask reports `none`, which records that the task was read                                                                                                                                                                          |
| `resolve_finding(findingId, how)`              | session            | marks a finding resolved once a `propose_plan` call has answered it, with a one-line how (§7)                                                                                                                                                                                                                                                                    |
| `find_records(query)`                          | session            | read-only search over the decisions and current principles that apply to this project (the project's and the builder-wide `you` ones), and this project's earlier conversations (titles and kept records); each hit carries its date (`created_at`, added to the result) and is cited in chat as a dimmed line ("Decided 2026-10-30: …") |
| `see_screen(screen, taskId?, width?, height?)` | session            | a screenshot of one of 10db's own screens (`factory`, `board`, `inbox`, `plan`, or `task` with a `taskId`), at a window of 480 to 1600 by 400 to 2000 px (default 1200 by 900), with the project's real data as it is now; answers an image, or a refusal that says why (below)                                                                                    |

**Seeing the app: `see_screen`** (`decisions/2026-11-03-plan-sees-the-app-through-screenshots-not-a-browser.md`).
**Built, not yet proven live** (see Open, below).

- **The app's own window draws it, in a hidden frame of itself.** The installed app ships no browser engine of its
  own for this (the e2e suite's Playwright WebKit is not in the bundle). A call becomes a request in the daemon's
  broker; the window, which long-polls `POST /screens/claim`, loads the app in a hidden `<iframe>`
  (`sandbox="allow-scripts allow-same-origin"`, `inert`, transparent, behind the window) at the screen's route,
  waits until nothing is loading, draws the frame to an image with `html-to-image` and answers with it
  (`POST /screens/:id/image`) or with why it could not (`…/refuse`). Nothing is stored for a request: asking
  writes no row. Two refusals come at once. With no window asking for work (the app has quit), the daemon refuses.
  A window that is hidden, closed (which only hides it, §3) or minimised keeps asking, and a hidden WebKit page
  runs no animation frame, which the drawing waits on, so the window itself refuses when
  `document.visibilityState` isn't `visible`, and the session asks the builder to bring 10db forward. A window
  fully covered by another counts as hidden only if WebKit says so. Not chosen: a Tauri webview snapshot (needs `unsafe` Rust, which
  `src-tauri` forbids; still the upgrade path behind the same capture seam), capturing the real window (shows only
  what is on screen, needs Screen Recording) and downloading a WebKit build (a second browser the daemon drives).
- **Live data, as it is now,** for the conversation's project; never a fixture. The Inbox reads every project's
  cards, so a frame shows only that project's: a session held to one project sees nothing of another.
- **It can change nothing.** The frame runs under a **render token**, minted for that one request and dead when it
  is answered, which the daemon's auth middleware holds to `GET` of the routes a screen shows
  (`screens/render-access.ts`): never a write, the digest (it moves a goal's last-opened mark, the 2026-11-02
  design review's refused read), the event stream, `/mcp`, or a GET that probes the machine or runs a command
  against an account or a lane (`/system`, an account's `identity`, a lane's `changes`). One allowed read runs a
  command: `GET /shapes/:id`, the Plan screen's own view, lists the checkout's tracked files with `git ls-files`,
  which reads the checkout and writes nothing. Every GET the daemon serves is named there, allowed or refused with a reason,
  and a test fails for one that is in neither. A kept picture is refused too, so a Plan screen draws a line in each
  screenshot's place, not the picture. The frame's own client sends reads only, and it draws the screen alone
  (no shell, no stream, no write of the builder's remembered project). **Tests, red first:** with the token, every
  allowed route answers and the database dump is identical before and after; each write, the digest, `/system`,
  `identity`, `changes`, the stream and the screen routes answer 403; the token is dead once the request is
  answered; a screenshot changes no task, batch, card, goal view mark, setting or decision; a control shows the
  dump does see a settings write.
- **What comes back is checked by its bytes** (a whole PNG or JPEG, to its IEND or EOI, with the size it says, no
  larger than the window asked for, at most 1.5 MB; the window has already refused a drawing of one flat colour),
  kept under the conversation's `screens/` directory, and written as a `screen`
  transcript row that names it, with a dimmed `see_screen · board · 1200×900` line before it. **The builder sees
  the same image the session was given:** the transcript draws the row as the picture (read with the UI token, as
  a data URL). A picture that is wrong or blank, a screen that fails to load or does not finish loading in 15 s, a
  capture that runs past the 19 s a whole draw has from its start, a crashed view, a task outside the project, and a window that is closed or hidden are each a refusal with the reason (and a dimmed
  `see_screen · refused · …` line), never a blank image.
- **Budget.** At most 12 screens a conversation, and fewer when dropped images took the room: screens share the
  conversation's 18 MiB picture total (§5.4), and a picture that would pass it is refused with the reason and not
  kept. Each is at most 1600 by 2000 px; the system prompt says to ask for
  the one screen and width needed and to describe what it shows before proposing a change to it. A fresh session
  (§5.3) is seeded with a digest line saying a screenshot was taken, of what, and to take it again; the picture is
  not carried over.
- **Open.** `e2e/see-screen.spec.ts` is written to run the real capture through the real host in Playwright WebKit
  (Board and Plan: the picture in the conversation has the width asked for and many colours), the nearest thing to
  WKWebView a script reaches. **It has not run yet.** A lane's sandbox can't launch WebKit, and a gate 10db runs
  skips e2e (`TENDB_SANDBOX=1`), so a lane's GATE PASS says nothing about it. Its first run will be the `gate` job
  in `.github/workflows/ci.yml`, on Linux WebKit in the Playwright image, not on macOS. Even then it asserts neither
  that a picture is faithful nor that the installed app's CSP lets it work, so the Tauri window itself is still
  checked by hand. That Claude Code hands the image block to the model is `test/shape-session.live.test.ts` under
  `TENDB_LIVE_CLAUDE=1`, which a lane can't run. So is the refusal of a hidden window on a real one: the host's test
  fakes `visibilityState`. Until those have been seen, treat `see_screen` as built and unproven live. Task
  `tsk_01a18a08-e391` (a task's copy previewed live) can point the same frame and broker at its dev server.

**Remembering.** The session is told to call `find_records` before proposing a record and when the builder's words
touch something already decided, and to say so in chat when a proposal contradicts a recorded decision ("You
decided the opposite on Oct 30; still true?"). A contradiction never blocks: the builder answers, and a reversal
becomes a record proposal that supersedes the old decision.

### 5.6 Starting from a terminal

**Built:** the builder MCP server (`apps/daemon/src/builder/`), which the builder's own Claude Code sessions reach
through the 10db-task skill, with `create_task` and its siblings.

**Designed.** A brainstorm that starts in a terminal moves into Shape without retyping. The builder MCP gains
`start_shape { projectId, title, summary, files? }`: it creates a conversation whose first message is the summary,
authored `builder` (it is the builder's own session speaking for them, so proposals can cite it) and marked "From a
Claude Code session". It answers the conversation's id; the app lists the new conversation at once (`shape.changed`)
and shows a notice, since the desktop has no deep-link scheme to open it from outside **(spec's call)**. Creating it
starts no Claude turn: the first turn runs when the builder next writes or presses Propose. Jev's `shape_ready`
judges the summary like any builder message. Files
come as inline text only (name and content; Markdown or plain text, at most 256 KB in all), never as paths, so a
session can't have the daemon copy a file from elsewhere on the Mac, and a model can actually emit them in one tool
call; images and PDFs are dropped into the conversation in the app **(spec's call: the cap)**. Each file becomes a
`shape_files` row in the conversation's files directory, counts toward §5.4's 20, and reaches the session as a line
naming its path, as a dropped text file does. The conversation starts before its first Propose, like any other. The 10db-task skill, which lives outside the repository, gets a `shape` command calling it, added by hand
once the tool lands.

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

| Field          | Holds                                                                                                                                                                                                                                                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goals[]`      | a `GoalBrief` plus `key`, `ceremony`, `eval?`; each task carries `basis` or `size` (§8), `annotations` (reserved), and may add `dependsOnOutside` keys                                                                                                                                                                                          |
| `looseTasks[]` | `key`, title, description, criteria, areas, `basis` or `size`, `ceremony`, `dependsOn` keys, `annotations`                                                                                                                                                                                                                                      |
| `landings[]`   | `key`, title, the proposal keys that land together in one pull request (§10.4)                                                                                                                                                                                                                                                                  |
| `records[]`    | `key`, kind; a decision has `question`, `choice` and `rationale` (the `decisions` columns), a principle a statement and rationale; scope `you \| project \| area` (with the area); `supersedes?` (a decision id); a `you` decision's successor defaults to `you`, and the row and the Convert modal say "replaces a decision for every project" |
| `questions[]`  | `key`, text, for (a role or a person)                                                                                                                                                                                                                                                                                                           |
| `additions[]`  | once something is converted: `key`, `goalId` and the loose-task fields                                                                                                                                                                                                                                                                          |
| `changes[]`    | once something is converted: a created task's id and new title, description, acceptance criteria, areas or dependencies                                                                                                                                                                                                                         |
| `removals[]`   | once something is converted: a created task's id and why                                                                                                                                                                                                                                                                                        |

Every proposal of every kind (goals, their tasks, loose tasks, landings, records, questions, additions, changes,
removals) carries `sourceMessageIds`, at least one: the builder's messages it came from, or the injected note that
started it (an engine event reopening the conversation, §12). Rows the builder makes in the sidebar (an edit, a
split or merged landing, a chip acted on) are builder-authored and need none. A row whose draft omits its ids
keeps its stored ones, so a resumed session (§5.3) never has to restate ids it can no longer see; the resume digest
lists each row's ids too. `sourceMessageIds` ships in slice 1's `PlanDraft`; the Why? link and round marks that
read it come in slice 2.

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
- `sourceMessageIds` must be the builder's messages in this conversation, or an engine-event note (§12); Propose,
  edit and digest notes can't be cited;
- a record's `supersedes` names a current decision (not superseded or withdrawn, the head of its chain, as M3
  allows) that applies to this project: the project's own or a builder-wide `you` one. Convert sets the new
  decision's `supersedes_id` (`packages/db/src/schema.ts`, `decisions`);
- a change or removal names a task this conversation created (through `shape_links`) that hasn't started (not
  running, done, failed or cancelled); hand-filed tasks and other conversations' tasks are out of reach, so two
  conversations never hold changes to one task **(spec's call)**; a goal's criteria are out of reach too (the owner
  edits them, goals spec §6);
- every task key is in at most one landing, and a landing's tasks all share a placement and a landing target
  (§10.4);
- keys are unique across the draft;
- size caps: at most 12 goals, 40 tasks per goal and 80 proposals in all, refused by name past them.

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
(`packages/db/src/store/knowledge.ts`), with `ProposalKind` `new_task | change_task | principle | note` and three
statuses; the Inbox reads them. **Designed (the eng review's D1, 2026-11-02):** Shape's proposals live in their own
table, `shape_proposals`, owned by `apps/daemon/src/shape/`, so one module owns all their state and `proposals`,
`ProposalKind` and `knowledge.ts` stay unchanged. A row has its shape, key, kind (`goal | task | change_task |
remove_task | decision | principle | question | landing`; a `task` with `goalId` is an addition), state (`pending |
superseded | rejected | accepted`), round, pin set, typed body (JSON, parsed with its zod schema on read) and,
**per task key** (a loose task's or addition's own key, and each task key inside a goal), a content hash and the
list of fields its last round changed. Changes are announced as `shape.changed`, not `proposal.*`. Reconciling writes the hashes and changed fields; a builder edit updates the hash
of the task it touched. Round marks, rehearsal and the Convert modal all work per task key, so editing one task of
a goal never marks or re-rehearses its siblings.

**Editing.** A field the builder edits is pinned: `propose_plan` can't change it, and the edit reaches the next
turn as a note ("The builder set Compact density's size to M"). Unpinning is a row action. A chip the builder acts
on (§9) creates a builder-authored row, pinned the same way.

**What changed, and why.** After each round, rows the round created or changed carry a "new" or "changed" mark,
and superseded ones a "moved to Earlier" line, until the next round; under the sidebar's header, "4 changes in
round 3" (created, changed and superseded rows together) filters the list to them. Every row has **Why?**, which
scrolls the conversation to its source messages and highlights them. The marks come from each proposal's stored
round and changed fields; a change in `sourceMessageIds` alone, or in the order of a list, doesn't count. Nothing
is asked of a model.

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
severity, text, state `open | resolved | dismissed`) under the effort, each resolved by chat (the session amends the
plan, then calls `resolve_finding`) or dismissed. Convert warns, but doesn't block, while a review runs or a finding
is open.

**Rehearsal.** For every effort, whatever its ceremony, a third reviewer, **rehearsal**, reads each proposed task as
the implementer who will be handed it, with the same tools and confinement, and reports the questions it would
have to ask before starting ("Which column does 'density' mean: card padding or rows per column?"), as findings of
kind `question` under the task, each stamped by the daemon with the content hash of the task it read (§6 Rows). A
rehearsal with nothing to ask reports `none`, so every rehearsed task and hash leaves a mark (`shape_rehearsals`:
task key, hash, round, questions found). It covers goal tasks, loose tasks and additions; changes and removals
aren't rehearsed.

- **When.** The daemon can't launch a subagent itself, so a rehearsal is a turn it injects, as Propose is: a note
  ("Rehearse: read these tasks as their implementer") and a turn whose prompt asks for one `Agent` call to the
  rehearsal reviewer per task listed. It runs when the builder presses **Rehearse**, and when he opens the Convert
  modal while any task of a selected proposal has no mark for its current hash: the modal shows "Rehearsing 3
  tasks…" and offers **Convert Anyway**: one call, `convert { proposalIds, interrupt: true }`, which interrupts the
  turn and takes Convert's hold before the queue can start another, so it never meets the 409.
- **Checked, not trusted.** The rehearsal note lists each task with the hash the daemon read it at; a reviewer's
  marks carry that hash, and a mark whose hash is no longer the task's current one (an edit landed meanwhile) is
  discarded. A rehearsal reviewer always ends with a closing report (`none` means done with zero questions); the
  mark is written only on it, so an interrupted rehearsal leaves no mark. When the turn ends, the daemon compares
  the tasks it listed with the marks written; a task with none reads "Not rehearsed" in the modal and is never
  treated as clean.
- **Resolving.** As with other findings: the session amends the task through `propose_plan`, then calls
  `resolve_finding`; or the builder dismisses it. A builder edit to the task resolves its open rehearsal questions
  with "answered by your edit".
- Convert warns while a rehearsal question is open.
- **Measure:** Inbox question cards per converted task, against the project's rate for tasks filed any other way
  (`InboxKind.Question` cards on the task's workstreams), shown under the Sizing line in Settings › Decisions
  (§8); slice 4 builds it.
- **(spec's call:** rehearsal runs on opening the Convert modal**)**

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
- **Stored once (the eng review's call).** A workstream's lane time is computed when it finishes and stored in
  `task_lane_times` (task, workstream, lane minutes, sessions-only flag), backfilled once by the migration, so
  `similar_tasks`, bucket medians, the preview and the Sizing line read a row instead of rebuilding spans per call.
- **Buckets:** S under 1 h, M 1–3 h, L 3–8 h, XL over 8 h of lane time. **(spec's call)**
- **One source per field.** Claude writes a task's `basis` (finished task ids from `similar_tasks`); the daemon
  computes hours (the basis's median lane time) and the bucket. With an empty basis, Claude writes `size`; hours are
  that bucket's median over finished tasks, or the bucket's midpoint until it holds 10. A goal's hours are its
  tasks' sum. The XL refusal, ceremony, the preview and the measure read these derived values.
- **The builder's override.** He changes the basis (size stays derived) or pins a bucket. A pinned bucket wins for
  every consumer, with that bucket's median or midpoint as hours, and reads "size set by you". The success measure
  counts derived sizes only and reports overrides beside it.
- **Calibration, shown.** Once a converted task finishes, its converted row in the Proposed sidebar (§4) and its
  task drawer read "Sized M (~2 h) · took 5 h of lane time", the actual in plain text with a Tabler `clock-exclamation` icon when it falls outside one bucket
  either way. Settings › Decisions gains a **Sizing** line: the share of finished converted tasks whose derived
  size is within one bucket of their lane time, with n, and the same per bucket; overrides are counted beside it,
  never in it. A reopened conversation is told which of its tasks mis-sized, so its re-plans account
  for it.

## 9. Intelligence

**Built:** the judge (`apps/daemon/src/judge/`), `JudgeDecision`, Settings › Decisions and `judge_calls`.

| Who    | Does                                                                                    | When it can't       |
| ------ | --------------------------------------------------------------------------------------- | ------------------- |
| Claude | talks, reads code, splits, picks bases, writes every proposal field, specs, attachments | (it is the session) |
| Jev    | three nudges, below                                                                     | no chip             |
| Daemon | validation, hours and buckets, the preview, Convert                                     | (deterministic)     |

**Per-project opt-in (the builder's choice, 2026-11-02).** These calls send the builder's own brainstorm messages,
not code, to OpenRouter and the model's provider, and a brainstorm can hold a client's details. So Shape's Jev
decisions make no call at all, shadow included, until a project turns on **Send brainstorm messages to fast
models** in its settings, which names OpenRouter and the provider; it is off for every project by default,
including existing ones. With it off, there are no chips and nothing is logged.

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

**Supersede.** Today `insertDecision` always writes `supersedes_id` null, and search and the context pack don't
leave superseded decisions out (`packages/db/src/store/knowledge.ts`). The slice that ships `supersedes` (slice 3,
with `find_records`) extends `insertDecision` with `supersedesId` and filters superseded and withdrawn decisions
out of `searchDecisions` and the context pack, to M3's plan, unless M3 has already done so.

### 10.2 The factory preview

**Designed.** Each round, the daemon simulates the draft with the picker's inputs: "Most tasks at once", areas,
dependencies and each task's lane time. Work already running or queued in the project holds its lanes first, for
its remaining estimate: its derived hours less its lane time so far, or, for a task never sized (filed by hand or by
adoption), the project's median lane time per finished task less its lane time so far, floored at zero
**(spec's call)**. The preview shows lanes, the critical path
in blue, area clashes as a dimmed line with a Tabler `arrows-split` icon (no status color; the design review's D4) ("Compact density and Shape view both claim `desktop`: they'll run one after the
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
- **Mermaid** runs at `securityLevel: 'strict'`. It draws into a temporary element in the live document, so only
  known kinds are drawn, and one that names an image or a style `url()` is refused (`safe-render.ts`).
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
still answering; Stop or wait", and the modal offers both. It is idempotent: a proposal already accepted is never
converted again, so a repeated or double-clicked Convert answers with what the first one created. Otherwise it holds the conversation (new turns queue)
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
- **Withdraw Decision…**, in the menu of the converted decision's row in the Proposed sidebar (the design review's
  D8; there is no Knowledge view until M3, which adds the same action): M3's withdrawn tombstone as M3's plan designs it
  (`docs/superpowers/plans/2026-10-22-10db-11-m3-knowledge.md`, task 1 and K1/K3): `withdrawn_at`, `withdrawn_by`
  and a required `withdrawn_reason`, and only the head of a supersede chain can be withdrawn (409 otherwise). A
  withdrawn decision leaves context packs and searches. M3 adopts the columns as built.
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
`decisions.withdrawn_at`, `withdrawn_by` and `withdrawn_reason` (§11); the project setting `oneWayPaths` (§7).
`proposals` is unchanged. New tables:

| Table               | Holds                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shapes`            | id, project, title, state (`listening \| proposed \| converted`), origin (`app \| claude_code`), SDK session id, propose unlocked, round, created, updated             |
| `shape_messages`    | §5.3                                                                                                                                                                   |
| `shape_proposals`   | §6 Rows                                                                                                                                                                |
| `shape_files`       | a dropped file's name, type, size and stored path                                                                                                                      |
| `shape_findings`    | §7: effort or task, reviewer (`scope \| engineering \| rehearsal`), kind (`finding \| question`), severity, text, state, how resolved, the round and task hash it read |
| `shape_rehearsals`  | task key, the hash it read, round, questions found (zero included)                                                                                                     |
| `shape_attachments` | kind (`mermaid \| chart \| mockup \| spec \| eval`), body, target (proposal key, or created goal or task)                                                              |
| `shape_questions`   | text, for, source messages, the goal or task it belongs to                                                                                                             |
| `shape_links`       | shape, proposal, created goal, task or decision                                                                                                                        |
| `task_lane_times`   | §8: task, workstream, lane minutes, sessions-only flag                                                                                                                 |
| `landing_groups`    | id, project, title, the shape that proposed it                                                                                                                         |

Contracts: `ShapeDto`, `ShapeMessageDto`, `PlanDraft`, the proposal bodies and the MCP tool inputs, in
`@10db/contracts`. Events: `shape.changed`, `shape.message`, `gate.started`, `gate.finished`.

## 14. Slices

All in scope; this is build order. Each slice ships something usable.

1. **Core.** `PlanDraft` and the Shape contracts; `shapes`, `shape_messages` and `shape_links`; Shape sessions on
   `sessions` (§5.1) with confinement (§5.2), turns and resume; `note_heard` and `propose_plan` with validation
   (dependencies across efforts included) and rounds; the Shape view with a read-only sidebar; Convert for goals,
   loose tasks and decisions; Remove Draft Goal and Withdraw Decision (§11); the guards (§5.3); Shape Work… in
   Factory and Adopt a Plan…'s UI removed; the live confinement test (§15). Acceptance: the six-item list.
2. **Editing and input.** Editable rows, pins, Restore, Drop; round marks and Why? (§6); file drop and pasted
   screenshots; `start_shape` (§5.6); a check that macOS dictation works in the Tauri window's input.
   *Built, except the dictation check, which needs a person on a Mac (`pnpm --filter @10db/desktop dev:shell`,
   open Shape, Fn twice, speak; a test pins only the input's structure). Enter on a row still opens its details
   (slice 1's behaviour), so E edits, P pins and W asks why. Files upload to `POST /shapes/:id/files` as the raw
   body (20 MB limit on that route only), not base64 JSON. The edit note reaches the next turn from memory and
   stays out of the transcript view. See `decisions/2026-11-02-shape-editing-and-dropped-files.md`.*
3. **Intelligence.** `gate.started`/`finished` and lane-time reconstruction; `similar_tasks`, bases, derived sizes;
   calibration shown back (§8); `find_records` (§5.5); the three Jev decisions in shadow, their scoring and Settings
   rows; records with principles (§10.1); questions.
   *Built: the gate events and `task_lane_times` with its backfill (migrations 0031, 0032); `similar_tasks`, derived
   sizes and hours (a builder-pinned `size` is the override), the actual on a finished converted row and Settings ›
   Decisions › Sizing; `find_records` with dated hits cited in the chat, and supersede through Convert; the
   per-project opt-in (Settings › General), the three decisions in shadow (`shape_shadow_answers`, judge outcome
   `shadow`), their scoring and agreement rows. `similar_tasks` ranks by shared words, not an FTS5 index (finished
   tasks with lane time are few). A pending row the builder pinned counts as kept when scoring. The task drawer of a
   converted task reads the same size line as the Proposed row. A conversation's next turn names each task that
   finished more than one bucket from its size, however the conversation was opened (Open conversation, History, the
   Plan list, a live session), because the service adds it at turn intake rather than on the resume route, which
   nothing calls yet. `shape_links.size_told_at` (migration 0041), set once the turn is sent, keeps it from being lost
   or repeated across a failed start or a restart; a fresh session reads the same lines in its digest. Also built:
   Convert writes principles (confirmed, replacing the current one with the same topic key and scope) and stores
   questions in `shape_questions` under the goal or task they are about (migrations 0039, 0040;
   `decisions/2026-11-03-convert-writes-principles-confirmed-and-stores-questions-under-their-goal-or-task.md`);
   Withdraw Principle… beside Withdraw Decision…; `find_records` returns principles beside decisions; and a
   conversation's session starts with the builder-wide and project policies and heuristics, again after a 70%
   re-seed.*
4. **Ceremony, rehearsal and eval.** The `oneWayPaths` setting; the ceremony rule, `write_spec`, the reviewer
   agents, findings and `resolve_finding`; the rehearsal reviewer, Rehearse, the rehearsal turn on opening the
   Convert modal and the question-card measure (§7); the proposed eval.
   *Built, except the proposed eval's screen (only the eval a session states is stored as an attachment at Convert).
   `oneWayPaths` is an app setting (`shape.oneWayPaths.<projectId>`, Settings › General), as `shape.jev` is.
   `report_finding` takes a `final` flag: the rehearsal's mark for a task is written only by a closing report, so an
   interrupted rehearsal leaves none. The reviewer is stamped by the PreToolUse hook (`updatedInput`) from the
   subagent's `agent_type`. The Rehearse note has its own message kind (`rehearse`). A task's content hash ignores
   `ceremony`. The question-card measure counts started, non-cancelled tasks of projects that have a converted task.
   Migration 0033. See `decisions/2026-11-02-shape-ceremony-review-and-rehearsal.md`.*
5. **Preview, attachments, reopen.** The factory preview; Mermaid, charts and mockups with §10.3's tests; Open
   conversation, the resume route, re-plan additions, changes and removals.
   *Built. The preview is in `ShapeViewDto.preview` and under the Proposed list. `attach` keeps a diagram, chart or
   mockup in `shape_attachments` (on a proposal key, or a goal or task the conversation converted) and the view
   carries them as `attachments`. Charts and diagrams are drawn to SVG and shown as an `<img>`, so no script or link
   in them runs; charts use `vega-interpreter` (a fifth pinned renderer package) because the window's CSP has no
   `unsafe-eval`. Open conversation reads `GET /goals/:id/shape` and `GET /tasks/:id/shape` and opens the Shape
   view; `POST /shapes/:id/resume` is for the engine's Re-plan in Shape cards, which don't exist yet.*
6. **Landings.** `landings[]` in the draft and the sidebar; `landing_groups` and `tasks.landing_group_id`;
   `groupByDependency` joining a landing's tasks and a late task joining its group's open batch; pull request and CI
   counts in the preview.
   *Built. Migration 0034 adds `landing_groups` and `tasks.landing_group_id`; Convert writes a selected landing as
   a group; a landing's tasks start into one batch titled after the landing, a late task joins the landing's OPEN
   batch, and once that batch has shipped it makes a new one with a `landing-shipped` notice. A landing whose batch
   is cutting, shipping or failed refuses the start by name. The preview's `landings` counts pull requests and CI
   runs with and without them (one CI run per pull request). Not built: removing a group with its last unstarted
   task, and ungrouping from the task's drawer (§11 Undo). See `decisions/2026-11-02-landings-share-a-batch.md`.*

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
- accounts: a Shape session's usage counted on the project's account and in per-project usage, a rate-limit pause
  queueing turns; the `sessions` migration on a seeded database (handoffs intact, recovery tests green);
- regression (the eng review's D3): `insertGoal` with no outside keys and `groupByDependency` with no landing groups
  return exactly what they do today (rows added to their table-driven tests), and the adopt route answers as before;
- rehearsal: a question finding resolved by a `propose_plan` that changes the task, a task re-read after it
  changes, Convert warning on an open question;
- memory: `find_records` finding a recorded decision with its date, never returning another project's; a record
  that supersedes a decision (the project's, or a `you` one) converting with `supersedes_id` set, and the superseded
  one missing from search and the context pack; one naming a withdrawn, already superseded or foreign decision
  refused;
- provenance: a builder-authored row needing no source ids, a draft omitting a row's ids keeping its stored ones;
- rehearsal turn: opening the Convert modal with an unrehearsed task starting one; a task rehearsed with no
  questions not re-rehearsed; a listed task the turn skipped reading "Not rehearsed"; Convert Anyway stopping the
  turn and converting even with a message queued; a builder edit resolving a question; editing one goal task
  leaving its siblings' marks; an edit during the turn discarding the stale mark; an interrupted rehearsal leaving
  no mark; the main session's `report_finding` refused and a reviewer's other Shape tools refused;
- withdraw: a reason required, and withdrawing a decision that isn't the head of its chain refused (409);
- round marks: a changed field marked, an unchanged row unmarked, Why? pointing at the cited messages;
- `start_shape`: a conversation created with the summary first, a path-like file refused, an over-limit file
  refused;
- calibration: a finished converted task showing its actual, the Sizing line's share over a fixed set;
- guards: a second Propose ignored, a Propose turn with no proposal noticed, a double Convert creating once, a
  draft over a cap refused, an edit and a reconcile in both orders keeping the pin, the context handoff at 70%;
- Jev opt-in: a project with it off making no judge call and logging nothing;
- the view: one render test per state of the wireframe, axe in Playwright.

**Beyond the fake adapter** (the builder's choice, 2026-11-02):

- `apps/daemon/test/shape-session.live.test.ts`, outside `make gate` and run with `TENDB_LIVE_CLAUDE=1` after each
  Claude Code or SDK upgrade, as `lane-sandbox.live.test.ts` is: a real Shape session's `Edit`, `Bash` and a `Read`
  outside the checkout are refused, the main session's `report_finding` is denied through `agent_id`, and a
  reviewer's `propose_plan` is denied.
- **The Shape eval:** the three reference transcripts (the design doc's assignment: the 2026-11-02 six-item list,
  one document-driven brainstorm, one single idea), each with what the builder actually filed, replayed through a
  live session and scored on splits, kinds, sizes and dependencies against what was filed. It runs on any change to
  Shape's prompts or tool contracts, with its baseline recorded, and needs the three transcripts first.

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
Convert's undos are built in slice 1; landings are in scope as slice 6. From the CEO review (scope expansion), the
builder added: the rehearsal reviewer (§7), `find_records` (§5.5), calibration shown back (§8), round marks and Why?
(§6), and `start_shape` (§5.6). In the same review the builder chose: Jev's Shape decisions as a per-project opt-in
(§9), the robustness guards (§5.3, §6, §11), removing Adopt a Plan… from the UI (§4), and a live confinement test
plus the Shape eval (§15). The eng review chose a `shape_proposals` table (§6), audited usage joins (§5.1) and regression
rows (§15); the design review chose the summary line, row states, first run, nudges, keys and screen readers, the
resizable split (§4), icon lines instead of yellow (§8, §10.2) and Withdraw Decision on the converted row (§11).

**The spec's calls, to confirm:**

- the idle timeout (§5.1) and Shape sessions on the project's account, as `sessions` rows (§5.1);
- no harness plugin in a Shape session (§5.2);
- the transcript digest (§5.3) and the file limits (§5.4);
- dependencies across efforts, and re-planning only this conversation's tasks (§6);
- the ceremony thresholds and the `oneWayPaths` setting (§7);
- the size buckets (§8) and the estimate for unsized work (§10.2);
- the shadow gate of 20 answers and 75% (§9);
- slice 3 building the principles table if M3 hasn't (§10.1);
- a late task joining its landing's open batch (§10.4);
- rehearsal running on opening the Convert modal (§7);
- `start_shape` answering an id and a notice rather than a deep link, and its 256 KB text-only cap (§5.6).
