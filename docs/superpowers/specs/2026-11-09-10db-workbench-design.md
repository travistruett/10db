# 10db Workbench: work through pages with the agents, live in Your folder

**Status:** designed on 2026-11-09, not built. Written after a design conversation: the builder's decisions are
in §3 as W1 to W20, and the reviews' as D3 to D25, cited where each applies. Every call the builder has
not made is marked **(call)** and listed in §20 for review. Revised three times on 2026-11-09 for three
independent plan reviews' engineering findings; §20 says where each went.
**Extends:** `2026-10-29-10db-task-placement-design.md` (Your folder is where a pass runs),
`2026-10-21-10db-batch-delivery-design.md` (a pass has a shared batch of its own kind, §5.5),
`2026-11-02-10db-brainstorm-chat-design.md` (a task's thread reuses Plan's turns, pictures and resume).
**Keeps:** `2026-10-25-10db-lane-sandbox-design.md` unchanged. A pass task is a lane in the project's own
checkout, under the rules that exist.
**Depends on:** the decision "Scope follows the question" (file `2026-11-09-scope-follows-the-question.md`, on
branch `feat/ui-polish`, not on `main` when this was written). The sidebar placement in §4.1 assumes it has
merged. It is not cited by its path here because the repo test `cites only decision files that exist`
(`tests/repo/src/architecture-docs.test.ts:107`) reads this branch.

**Words:** the **Workbench** is the project view. A **pass** is one sitting in it: a set of pages the builder
works through with the agents. A **page** is a code area marked as a page (§7). A **pass task** is a task in
a pass. A **turn** is one run of a pass task's agent, from a message to the moment it stops. **Ready** means a
turn has ended and the page waits for the builder. A fact marked **built** is in the code on `main` and cited;
everything else is designed here.

## 1. Intent

Plan is before: think, decide, make tasks. The Board is while agents work alone. The Workbench is when the
builder works with them: "this got to 80%, now I need to go in and tweak it by hand".

The builder does this today with three or four Claude Code terminals, each kept to one page in their head,
flipping between pages in the browser and typing feedback into whichever terminal owns the page. The reason for
the parallelism is latency: a turn can take ten minutes, the builder's attention is the scarce thing, so they
work another page while they wait. The Workbench keeps that way of working and takes over the juggling: 10db
starts and owns the sessions, each page has a thread that takes pasted screenshots, one queue says what is
ready, and signing off a page lands it.

The app is seen where it already runs: the builder's own browser, on the app's own port, served by the dev
server the builder started. A pass adds no stack, no database, no port and no process to supervise. That is
why it comes before previews of separate copies (§17).

**Success means** (§15 turns each into tests, §16 into scenarios with bars):

1. The builder opens a pass on existing tasks, on pages, or from a goal, in three clicks, writing nothing.
2. Each page has a thread. A message with pasted pictures reaches that page's session, and the session's reply
   and its changes come back to the same thread.
3. A change shows in the builder's browser as soon as the agent writes the file. No commit, check or gate
   stands between an edit and the screen.
4. One queue shows what needs the builder next, and a macOS notification says when a page becomes ready.
5. Twelve rounds of feedback on one page never fail the task or change its model, and nothing said is lost:
   when a session's context fills it hands off, as any lane does, and the next session starts from the handoff
   and the thread.
6. Two pass tasks never edit the same file at the same time, and neither commits the other's work.
7. No gate runs on a folder that holds another task's unfinished work.
8. Signing off a page lands it as one commit on the pass's branch. The pass's pull request holds signed-off
   work only.
9. Every task that changes UI in Your folder, in a pass or not, keeps a before and an after picture.
10. A daemon killed at any point leaves threads, pictures and landed commits intact, and no process running.

**Non-goals:** an embedded view of the app (the builder's browser is the view); a capture button in the
app under test (a later task: a dev-only overlay or extension that files a screenshot, URL and element to the
page's task); previews of separate copies, live links and screenshots for copies (§17); showing pictures to the
agent by itself; undoing one turn; Features as a kind of surface (§7 says how they fit later); passes that span
projects; more than one open pass per project; a model review step per turn.

**Anti-goals:** a gate or a commit that the builder waits for before seeing a change; 10db starting, restarting
or stopping the builder's dev server; a pull request that carries a page the builder has not signed off;
pictures of the builder's app leaving the Mac.

## 2. What is already built

Read on 2026-11-09 at `c308cca`. Paths are relative to the repo root.

| Piece | What it does now |
|---|---|
| Your folder | Tasks run in the project's own checkout; the placement spec was written so that "a dev server shows every change as the agents make it and several sessions work on different screens at once" (`2026-10-29-10db-task-placement-design.md` §1). |
| Area claims | Taken all-or-none when a task starts (`apps/daemon/src/scheduler/scheduler.ts:216-225`); a Write outside them is denied (`apps/daemon/src/guard/judge.ts:123-136`); `classifyPath` gives any path its areas (`apps/daemon/src/guard/paths.ts:203`); a write no held claim covers is a stray (`apps/daemon/src/watcher/strays.ts:79-86`). |
| `request_claim` | Waits for a held claim, shows a notice naming the holder, detects a deadlock (`apps/daemon/AGENTS.md:92`). A single claim can be released in the store (`packages/db/src/store/claims.ts:163`); nothing releases one at the end of a turn. |
| The commit tool | Judges each named path against the task's claims (`apps/daemon/src/mcp/tools.ts:636-647`), then commits under the per-checkout lock from a private index made new from the branch tip (`apps/daemon/src/git/git.ts:1125-1138`, `:2158-2177`), and moves the branch with a compare-and-swap (`:2194`). |
| Kept refs | The daemon keeps commits at refs under `refs/10db/` that touch no file, index or branch (`apps/daemon/AGENTS.md:133`). |
| The shared batch | One unfinished per project (`packages/db/src/schema.ts:331-333`); the folder is switched to its branch and back (`docs/architecture/02-batch-delivery.md:51`); it ships with a gate, a push and a pull request. Four of its rules do not fit a pass (§5.5): a batch start in a `local` project answers 400 (`docs/architecture/02-batch-delivery.md:26`); the ship trigger ships an `OPEN` batch when its last member settles (`apps/daemon/src/delivery/trigger.ts:7-9`); ship fails on any changed path in the checkout (`apps/daemon/src/delivery/ship.ts:1000-1006`); the pull request watch reads `SHIPPED` batches only (`apps/daemon/AGENTS.md:88`). |
| The end of a session | When a turn completes with nothing running, the runner records `step_done` and stops the session (`apps/daemon/src/runner/runner.ts:2167-2181`); its `finally` stops the lane's processes, disposes the sandbox and ends the session row (`:2275-2295`). `verify` then sends a step back, with `attempt + 1`, when its claims hold uncommitted changes (`:2365-2388`, `:2529-2539`). The commit tool commits on the batch's branch (`apps/daemon/src/mcp/tools.ts:628-630`). A session is nudged to hand off at `handoffPct`, default 40 (`packages/contracts/src/entities.ts:525`). |
| The watcher | A write inside a claim whose holder is not running raises a foreign-claim card; "running" means a lane state, which `WAITING_HUMAN` is not (`apps/daemon/src/watcher/watcher.ts:284-304`, `packages/contracts/src/workflow.ts:49-54`). |
| Claim leases | A claim is held until it is released: the holder lookup reads `releasedAt` only (`packages/db/src/store/claims.ts:71-87`), and the heartbeat renews the lease of every workstream that is not terminal, launched or not (`apps/daemon/src/scheduler/scheduler.ts:306-315`). Asking again for a claim one already holds grants nothing new and is no conflict (`claims.ts:107-114`). |
| The scheduler | Every `QUEUED` workstream is a candidate to launch (`scheduler.ts:159-160`); a task parked in a human column never launches (`:212-214`). |
| The builder's check | A project with no gate stops a finished task at `WAITING_HUMAN` with `builder_review` and a `check` card, Approve or Send Back (`decisions/2026-10-28-optional-gate.md`). Send Back queues a `fix` on a fresh session and counts against the fix limit (`apps/daemon/src/runner/runner.ts:3160-3227`; the limit is 3, `packages/contracts/src/review-rounds.ts:6`). A workstream has one live `check` card, refreshed in place when the head changes (`apps/daemon/src/runner/builder-check.ts:55-63`); its facts are the commits since the task's base (`runner.ts:2440-2444`). |
| A lane session | Takes streamed input (`apps/daemon/src/sessions/claude-adapter.ts:87`); its handle has `send(text)`, "the agent sees it at its next opportunity" (`apps/daemon/src/sessions/types.ts:240-247`, `claude-adapter.ts:868-878`), used only for the runner's nudges (`runner.ts:1942`, `:1987`, `:2039`, `:2166`). It resumes by provider session id (`types.ts:56`, `claude-adapter.ts:294`). It reports the end of a turn with the model's last text (`types.ts:200`). |
| A Plan session | Takes pictures and can be interrupted: `send(text, images)`, `interrupt()` (`types.ts:256-261`); `userMessage` builds image blocks (`apps/daemon/src/sessions/claude-mapping.ts:209-236`). Its service runs turns from a queue, closes an idle session after 10 minutes, resumes it by id, and moves to a fresh session with a digest past 70% of the context (`apps/daemon/AGENTS.md:177`). Dropped files are checked by their bytes and stored on disk with a row (`apps/daemon/src/shape/dropped-files.ts:14-24`, `:170-196`; `packages/db/src/schema.ts:1264-1292`); picture limits follow the account (`apps/daemon/src/screens/picture-limits.ts`). |
| Lanes | A project runs `maxLanes`, default 2, at most 16 (`packages/contracts/src/entities.ts:522`); an account runs 4 (`packages/contracts/src/accounts.ts:88`). A waiting task holds a lane only while its session is live (`packages/db/src/store/workstreams.ts:487-495`). One gate runs at a time on the Mac (`runner.ts:239-240`), through one runner that every gate shares: "a new place that starts a gate goes through that same runner, never a second one" (`apps/daemon/AGENTS.md:165`, `decisions/2026-10-28-gate-slots.md`). |
| Screens | `see_screen` draws 10db's own screens in a hidden same-origin frame with `html-to-image` (`decisions/2026-11-03-plan-sees-the-app-through-screenshots-not-a-browser.md`; `apps/desktop/package.json:34`). The desktop's e2e suite has Playwright 1.64.1 (`apps/desktop/package.json:49`), runs WebKit only (`apps/desktop/e2e/playwright.config.ts:24`) and takes `page.screenshot` when `E2E_SCREENSHOT_DIR` is set (`apps/desktop/e2e/worktree-board.spec.ts:18`, `:291`). The daemon has no browser. It does fetch pinned tools into its data directory (`decisions/2026-11-08-10db-runs-pinned-copies-of-codex-and-claude-code.md`). |
| Notifications | `tauri-plugin-notification` is a dependency (`apps/desktop/src-tauri/Cargo.toml:20`); a new inbox item raises a macOS notification while 10db's window is not focused (`notifyNewCard`, `apps/desktop/src/desktop/tauri.ts:92-99`); a card refreshed in place is not new and raises none. The same module opens a URL in the builder's browser (`openInBrowser`, `:23-31`), for the three `https` origins the capability allows (`apps/desktop/src-tauri/capabilities/default.json:13-19`). |

Two facts that shape the design, both checked in the code:

- **A gate in the folder reads every task's unfinished work.** The gate's working directory is the checkout
  (`apps/daemon/src/sandbox/gate-sandbox.ts:254`, `apps/daemon/src/verify/gate-runner.ts:151`). Before a gate
  the runner checks only that the task's own claims hold nothing uncommitted (`runner.ts:2354-2359`,
  `:2529-2539`); nothing exports a tree or sets a neighbour's edits aside. With four pages changing, a gate can
  fail on a neighbour's half-written file and spend a fix attempt on it, or pass because of one.
- **A daemon commit cannot revert a neighbour's commit.** The failure reported upstream for a per-session git
  index (a stale index writes old content back) needs an index that outlives a move of HEAD. The daemon's is
  made per commit, from the tip read under the lock, and deleted. Two things stay outside it; §18 names them.

What does not exist: a task thread or task pictures; a builder message to a running lane; a lane session that
stays open after its step; a stop for the builder after every turn in a project with a gate; anything that
knows the app's address.

## 3. Decisions

W1 to W13 are the builder's, in their words where quoted. W14 to W20 are defaults the builder accepted.

| # | Decision | Why |
|---|---|---|
| W1 | The Workbench is a project view, a peer of Plan and the Board. Factory links into it. | It works one project's app, on one port, in one folder. A global view answers "what needs me?" across projects. |
| W2 | The view is the **Workbench**; one sitting is a **pass**. | "Polish" implied only the end and "Live" reads as deploying. The mode is hands-on at any stage. "Session", "batch" and "round" are taken in the code. |
| W3 | The builder looks at the app in their own browser on its normal port. 10db sits beside it with the Ready queue and the thread. No embedded view. | The app is already running there, signed in, with the builder's tools. |
| W4 | Feedback is typed into the task's thread, with pasted screenshots. | "Instead of jumping to random terminal sessions I'm jumping from task to task." |
| W5 | A second task that needs shared code asks the builder in its thread. The question shows inline in the Ready queue and in the Inbox. | One folder has one button: the builder decides whether a change is for every page. |
| W6 | A task lands when it is signed off, as a commit on the pass's branch. The pull request can be opened at any time with what is signed off. One pull request per pass. Unfinished tasks stay open. | Sign-off is the builder saying "yes, this is right". |
| W7 | Squash merge is fine: per-task commits live in the pull request, one commit per pass on the base. | The builder: "they could each be a commit within a single PR for all I care". |
| W8 | A pass makes its own branch and pull request on any project, whatever its delivery. Ordinary tasks keep the project's delivery. | ampsio delivers `local`; a pass there still lands as one reviewable pull request. |
| W9 | Other Your-folder work in the project runs in a separate copy if it can, else waits until the pass closes. The Board says why. | The pass's branch holds only the pass's work. |
| W10 | The builder's hand edits ride the owning task's next commit, and its agent is told what changed. Edits to files no task owns are listed at close, to place or leave out. | The builder edits by hand in this mode; the edit must not be lost or silently overwritten. |
| W11 | 4 pages by default, 6 at most. A pass's lanes do not count against the project's `maxLanes`. The Workbench says when there is a backlog or idle time. | §4.5. |
| W12 | The screenshot matrix is a project setting: by default one desktop width, one theme, before and after. | Storage and time grow with the matrix; most projects need one row. |
| W13 | A message sent during a turn reaches the running agent at its next step. **Stop and Redo** interrupts. | The streamed `send` exists; waiting for a ten-minute turn to end before correcting it wastes the turn. |
| W14 | A session stays open for 10 minutes after a turn, then closes and is resumed by the next message. | Plan's rule; a warm session answers in about a second. |
| W15 | Sign-off releases the page at once. | Another task may take the page while the pass is open. |
| W16 | Each turn runs the project's changed-files check, as advice. The full gate runs once, for the pull request. | §2's first fact. |
| W17 | Pictures come from a browser the daemon owns, a pinned Chromium, signed in through a per-project dev login. | §10. |
| W18 | An area is a page or shared, and a page may name its route. Features come later, as names over areas. | §7. |
| W19 | A pass runs on the project's account, Claude or Codex, with the fallback and move-back rules every lane follows. | The builder bills a project to a ChatGPT plan on purpose. The first reading, "a pass is Claude only", rested on Codex taking no pictures and showing no turn took a message; the pinned Codex does both (`decisions/2026-11-11-a-pass-runs-on-the-projects-account-claude-or-codex.md`). |
| W20 | Separate copies get previews later, declared in a committed `.10db/preview.json`; ampsio gets none until measured. | §17. |

## 4. The screen

### 4.1 Where it is

Under the Project label in the sidebar: Board, Plan, **Workbench**, Knowledge, Project Settings (the
builder's choice, design review D20). The Workbench item carries a count of items that need the builder in the open pass. On `main` today
the sidebar is one flat list (`apps/desktop/src/shell/app-layout.tsx:29-36`); the grouping comes with the
decision this spec depends on.

Factory shows, per project, a line when a pass is open: its name and how many items wait, linking in.

The Inbox keeps its promise that it holds what needs the builder
(`decisions/2026-11-08-the-inbox-holds-what-needs-the-builder.md`). A ready page is a `check` item and a
shared-code question is a `question` item, both stored as today, so both count in the badge and raise a
notification. The Inbox view folds one pass's `check` items into one row, "Workbench: 3 pages ready", which
opens the Workbench; a question shows as its own card (W5).

### 4.2 Three ways in

| From | What the builder does | What the pass starts with |
|---|---|---|
| The Workbench | **Start Pass**, after ticking pages | one new task per page, titled "<Page>: UI work", with no brief |
| The Board | select open tasks, **Work on These** | those tasks; each must name at least one page area |
| A goal, in Factory | **Work on This** on a goal whose UI tasks are done or nearly done | one new task per page those tasks committed in (found with `classifyPath` over their commits), linked to the goal, with the goal's kept pictures (§10) as the first thing in each thread |

**With no pass open, the page list is the screen.** The Workbench is most often seen with no pass, so its empty
state is the picker for the first way in, not a blank page with a button:

- one line of purpose: "Work through pages with the agents, live.";
- a filter box, then **Pages**: every page area as a checkbox row with its name, its route and when its files last
  changed; then **Open UI tasks**: Board tasks that name a page area and could join (§4.2's second way in);
- an optional field, "What's bothering you?", one or two rows, autosizing;
- **Start Pass (n)**, the one filled button, enabled from one ticked row up to the page cap (W11).

If "What's bothering you?" is filled, every new page task starts at once with it as its first message. If it is
empty, each new page waits for the builder's first message.

A project with no page area shows, in place of the list, the Workbench setup: its areas rebuilt with a page per
route and the settings a pass wants, applied in one click
(`decisions/2026-11-10-the-workbench-setup-rebuilds-the-areas-for-one-apply.md`).

- A task with no brief costs nothing until spoken to: its session starts on the builder's first message. A
  task with a description starts working when the pass opens.
- A shipped task is never reopened; its page gets a new task. A task that is running, or that sits in a
  separate copy, cannot join; its page can once nothing else holds it.
- Opening is refused, with the reason, while the project has an unfinished shared batch or a lane running in
  the folder that is not joining the pass (the rule a shared cut has today), and while the folder's HEAD is
  detached: the commit tool already refuses a detached HEAD (`apps/daemon/src/mcp/tools.ts:631-634`), and
  closing needs a branch to return to (§5.4).

**What Start Pass says before it starts** **(call)**. Two kinds of line sit above the button, each only when it
has something to say:

- **Files already changed.** For each ticked page whose area holds uncommitted files: "Settings: 3 files
  already changed in your folder will be part of this page's work." The builder starts the pass knowing it, or
  cancels and commits them first. Nothing from before the pass joins a page's work unseen (§6.4). Uncommitted
  files in shared areas and elsewhere are counted in one line, "12 other changed files stay as they are", and
  are never kept under a task's name (§7.2).
- **What the project lacks** (§14 slice 0): "No changed-files check: turns run unchecked", "Docker is off: the
  gate needs it", "`build` has 4 commits `origin` lacks: the pull request will carry them". None blocks the
  pass; each links to where it is fixed.
- **Areas that overlap.** Two ticked pages whose globs match the same file cannot both be in a pass: Start
  Pass refuses the second, naming a file both match, and Settings refuses to save two page areas that overlap.
  A page that overlaps a shared area is allowed, with one line, "Files under Settings count as Settings', not
  as shared `src`", because §7.3 makes that so.

### 4.3 The Ready queue and the thread

The Workbench is usually a narrow window beside the builder's browser (W3), so it lays out by width:

- **Under 900 px** (the common case, about 420 to 520 px beside Chrome): the app's sidebar folds away; the
  queue is a strip of compact rows across the top, one row a page, at most six; the selected task's thread
  fills the rest, with its composer fixed at the foot.
- **900 px and wider**: two panes, the queue on the left and the thread on the right.

```
NARROW (~480 px, beside the browser)      WIDE (900 px and up)
┌ ampsio · <pass name> ────────────┐      ┌ queue ──────────┬ thread ───────────────┐
│ ● Settings   Ready · 3 min       │      │ ● Settings Ready│ Settings              │
│ ● People     Question            │      │ ● People   Asks │ reply · files · shots │
│ ○ Billing    Working · 4 min     │      │ ○ Billing  4 min│ your message [image]  │
│ ✓ Home       Signed off          │      │ ✓ Home          │ [reply…]     Sign Off │
├ Settings ────────────────────────┤      └─────────────────┴───────────────────────┘
│ reply · files · shots            │
│ your message [image]             │
│ [reply… paste a screenshot]      │
│ Open Page               Sign Off │
└──────────────────────────────────┘
```

**The pass header**, above the queue at every width, holds the pass's own actions; a page's actions stay at its
composer, so the two never share a bar:

- one line: the project, the pass's name and its counts ("ampsio · Settings pass · 2 signed off · 1 ready");
- **Add Page**; **Open Pull Request** (a `default` button, shown once a page is signed off); a `⋯` menu with
  **Close Pass…** and **Rename**;
- the timing hint of §4.5 as a dimmed `xs` line under it, shown only when it has something to say.

**The queue**, in this order:

1. A question or a permission from a task of the pass, or a failed turn: an agent is stalled. A shared-code
   question (§7.2) is one of these, answered in place. A failed turn's row is red and says what happened and
   what **Retry Turn** will do, in `failureLine`'s words (`apps/desktop/src/views/board/task-state.ts`), which
   gains the failure kinds of a pass turn; Retry Turn sends the builder's last message again, to the resumed
   session or a fresh one with the digest (§6.3). A turn paused by a usage limit is not stalled: its row is
   orange, "Paused: usage limit, resumes 3:40", sits with the working pages, and needs no action. A turn
   resumed after a daemon restart notes "Resumed after 10db restarted" on its thread.
2. "The preview is broken", against the task that broke it (§8.2).
3. Ready pages, the longest-waiting first.
4. Dimmed: pages being worked on, each with how long its turn has run beside the pass's median turn; then pages
   not yet spoken to; then signed-off pages.

**A queue row** follows Factory's list, not the Board's cards (design review D13): a status dot, the page's name
(weight 500 when it waits on the builder) and one short state line; no border, hairline dividers between rows,
the selected row on the `bg_1` fill. The dot uses DESIGN.md's status colors: yellow when the page waits on the
builder (ready, a question, or not spoken to yet: "Your turn", "Stopped · your turn"), blue working, orange
paused, red failed, green signed off. A page not spoken to yet is not counted on the sidebar, so a new pass's
pages don't all count at once.
Working, not-started and signed-off rows take `dim_0` text. Order and the yellow dot carry "needs you"; nothing
pulses.

**Getting back to the right page** (design review D12), the loop's most repeated step:

- Clicking a "Settings is ready" notification raises 10db with Settings selected and the cursor in its composer.
  Today a notification is sent with a title and a body and nothing reads a click on it
  (`apps/desktop/src/desktop/tauri.ts:92-99`; the plugin is only initialised,
  `apps/desktop/src-tauri/src/lib.rs:57`). If the plugin cannot say which notification was clicked on macOS,
  D12's intent is kept another way **(call)**: when 10db's window gains focus within 10 seconds of showing a
  ready notification, it selects that notification's page, under the no-draft rule of the next bullet. When
  two were shown in those 10 seconds, the later one wins: it is the one on screen. The plan confirms which of
  the two ways is buildable before slice 8.
- When 10db gains focus by other means (⌘-Tab, a click), it selects the oldest item of ranks 1 to 3 only if the
  selected page is not waiting on the builder and its composer holds no draft; otherwise nothing moves. The
  composer takes focus either way.
- **J** and **K** move through the queue; ⌘V pastes a screenshot into the focused composer. The round trip is the
  macOS screenshot shortcut, ⌘-Tab, ⌘V, a line of text, ⌘↩.

One key moves to the next item of ranks 1 to 3. A page becoming ready raises a macOS notification naming the
page, by the rule inbox items follow today: only while 10db's window is not focused, which is the usual case in
a pass, where the builder is in their browser.

**The thread** shows, oldest first: the builder's messages with their pictures; the agent's reply for each turn
(the model's last text of the turn) with the files the turn changed; notices (a hand edit carried, a shared
file changed by another task, a failed check); and each turn's pictures (§10). Beside the composer: **Open
Page** (the page's route on the app's address, in the builder's browser), **Send**, **Stop and Redo** while a
turn runs, and **Sign Off** when the page is ready.

**The composer's buttons** (design review D14; DESIGN.md: one filled primary per group). **Open Page** is always a
`default` button on the left. On a ready page with an empty composer, **Sign Off** is the filled primary and Send
is hidden; once the builder types, **Send** (⌘↩) becomes the filled primary and Sign Off turns `default`. While a
turn works, **Stop and Redo** is `default` and Send is filled once there is text.

**Open Page** (design review D18): its first click for a page in a pass opens the page's route in the builder's
default browser; after that it reads **Copy Link** (⌘L in the thread), because the builder's tab is already open
and hot reload keeps it current. macOS cannot reuse a browser tab, so this avoids a new tab per click. Opening a
loopback `http` address needs the desktop's opener capability widened; today it allows three `https` origins
(`apps/desktop/src-tauri/capabilities/default.json:4-15`). §13 and a decision record cover it.

**Before the first message**, a page's thread is not blank: it opens with the page's before picture (taken when
the pass opened, §10), its route and **Open Page**, and the composer's placeholder asks "What should change on
Settings? Paste a screenshot…". With no app address set, or before slice 9, it shows the route and Open Page
only.

**While a turn works**, the thread ends with one live line under the builder's last message: a blue dot,
"Working · 4 min · editing `settings/page.tsx`" (the elapsed time and the agent's current tool and target),
and under it "3 files changed so far · Show Log". The line updates as the session reports each tool call; Show
Log opens the turn's full activity in the task's log view. The composer stays open, its placeholder "Add to this
turn…", and **Stop and Redo** takes Sign Off's place beside it. The daemon streams the current tool and the
files touched for each pass lane to the UI as events.

The composer takes pasted or dropped PNG, JPEG and WebP, checked by their bytes as Plan's are.

### 4.4 The loop, as the builder lives it

| Step | The builder does | Feels | What carries it |
|---|---|---|---|
| 1 | Opens the Workbench, ticks 3 pages, types "these feel cramped", Start Pass | "finally, not four terminals" | the page list as the empty state (§4.2) |
| 2 | Goes to the browser; agents work | free to look elsewhere | three live lines (§4.3); nothing to babysit |
| 3 | A notification: "Settings is ready" | pulled back, not nagged | one notification per ready page, only while 10db is unfocused |
| 4 | Clicks it; 10db shows Settings' reply, files and after picture; looks at the page in the browser | oriented in seconds | the queue selects the page from the notification; Open Page |
| 5 | Pastes a screenshot, "padding too tight", Send | heard | the message goes in at once (warm) or within seconds (resumed) |
| 6 | Moves to the next ready page | busy, not waiting | the next-ready key; the timing hint says when to add a page |
| 7 | A page is right: Sign Off | done with one thing | the row turns green; the next ready page opens |
| 8 | All pages signed off: Close Pass | finished, and it's still on screen | the close modal's summary; the branch keeps the work (§5.4) |

Five seconds: the queue says what is ready. Five minutes: the loop never needs a terminal. Over months: the
before and after pictures of every page are the record of how the app got to where it is.

### 4.5 How many pages

Parallelism exists to keep one person busy, so it follows from two times: T, a turn, and R, the builder's look
and reply. Each page cycles through T + R, so the builder is busy about N·R / (T + R) of the time and stops
waiting once N is about 1 + T / R. With the builder's figure of 10 minutes for a turn and a look of 3 to 4
minutes (a guess until measured), that is 3 to 4 pages; with one-minute tweaks it is 1 to 2.

More pages than that make nothing faster: ready pages queue, pages are held longer and warm sessions idle out.
So a pass holds 4 pages by default and 6 at most (W11), records T and R for every turn (§11), and says what it
sees in one line above the queue: "You waited 6 of the last 10 minutes: add a page", or "3 pages have been
ready for over 10 minutes".

### 4.6 Keyboard and screen readers

Design review D16. The Workbench changes on its own, so it says out loud only what the builder acts on:

- The queue is a labelled list ("Pages in this pass") of buttons; the selected page carries `aria-current`.
  **J** and **K** move, **Enter** selects, ⌘↩ sends; every control is reachable by Tab and shows Mantine's
  focus ring.
- One polite live region announces a page becoming ready ("Settings is ready"), a question ("People asks a
  question") and a failure ("Billing failed"). The working line of §4.3 is not a live region and is never
  announced as it ticks.
- Every picture has alt text naming the page, the kind, the turn and the size ("Settings after, turn 3, 1440 by
  900"); a pasted picture's alt text is its file name until the builder's message gives it context.
- The e2e axe run covers the Workbench at a narrow and a wide width, in dark and light, with a pass open.

## 5. A pass

### 5.1 Opening

All of it happens under the checkout's repo lock, in the project's delivery queue.

1. The daemon makes the pass's row and its batch (§5.5; W8: on any project, whatever its delivery). The batch
   is made by the pass, not by the batch-start route, which answers 400 in a `local` project.
2. It records where the folder is: the branch HEAD names (`return_branch`) and its commit (`start_sha`).
3. It makes the pass's branch, `10db/<slug>-<6 hex>`, **at `start_sha`**, and points HEAD at it. No file is
   written, so uncommitted work in the folder is left as it is and a clean folder is not required **(call)**.
   This differs from today's shared cut, which starts from the base and needs a clean checkout.
4. **It records the folder's dirt:** every path that differs from `start_sha`, with the hash of its content on
   disk, in `pass_dirt` (§11). This is what lets every later step tell "already there" from "made in the pass":
   Start Pass has shown the builder the same list (§4.2). The content is kept too, not only its hash: each
   file is written as a git object and held by an unsigned commit at `refs/10db/passes/<pass id>/dirt`, so a
   take-out or an Abandon can put a file back exactly as it was before the pass (§5.4).
   The batch's `base_sha` is `start_sha`, and its `repo` is read from `origin` as a cut reads it, or left
   null when there is none; the built ship refuses a batch with either missing
   (`apps/daemon/src/delivery/ship.ts:993`), which is one more reason a pass with no `origin` closes without
   entering it (§5.5).
5. If `start_sha` has commits the project's base on `origin` lacks, the pass opens and says so **(call)**. The
   consequence is stated where it bites: the pass's pull request lists those commits too, until the builder
   pushes the branch they are on; Open Pull Request shows the count before it pushes (§8.3). A `local` project
   is often in this state.
6. Each task takes its page areas as claims when the pass opens, before it has a session, through the same
   `acquireClaims` the scheduler uses. Today a claim is taken when a task launches
   (`apps/daemon/src/scheduler/scheduler.ts:216-225`). A claim with no session behind it stays held: the holder
   lookup reads only whether it was released, and the heartbeat renews every live workstream's lease (§2). When
   the task launches later, asking again grants nothing new. A page another task holds makes that one task
   wait, with the holder named.

### 5.2 Lanes

A pass counts its own lanes: its tasks are left out of the project's `maxLanes` count and held to the pass's
page count instead (W11). The account's lane limit still applies (4 by default), so a fifth and sixth page
run only while another page's session is idle, or after the builder raises the account's limit. Only a working
or warm session holds a lane. The overload guard still holds work on a loaded Mac.

A pass's lanes are outside one limit and inside two. They do not count against the project's `maxLanes`. They
do count against the account's limit and against the daemon-wide cap on lanes, which is 4 by default
(`apps/daemon/src/scheduler/scheduler.ts:162`, `apps/daemon/src/daemon/start.ts:367`). So with the defaults a
pass of four working pages is everything the Mac runs, and both yields below apply to the daemon-wide cap as
well as the account's.

Four warm pages fill the default account limit, so a warm session must never be why something else waits
**(call)**:

- **Inside the pass:** a message for a page with no session, when the account has no free lane, closes the
  pass's longest-idle warm session and takes its lane. The closed page loses nothing; its next message resumes
  it (§6.3). If every session of the pass is working, the row says so: "Waiting for a free session: 4 are
  working".
- **Outside the pass:** when any workstream on the account waits for a lane, the scheduler asks the pass to
  close its longest-idle warm session. A pass keeps sessions warm only with lanes nobody else wants.

### 5.3 Other work in the folder

While a pass is open, a task that would run in Your folder and is not in the pass does not start there (W9).
Placement proposes a separate copy where the project allows copies (pull request delivery, as today);
otherwise the task waits, with a notice on its card: "Waits for the Workbench pass to close". Notices, not
cards (`decisions/2026-10-31-notices-not-cards.md`).

**After the close, on a pull request project, the wait goes on until the pass's work is in the base**
(builder's decision, D22). D8 leaves the folder's branch ahead of the base on `origin` by the pass's commits.
An ordinary shared batch is cut from the fetched base with a clean checkout
(`docs/architecture/02-batch-delivery.md:30`), so cutting one then would take the pass's work off the screen
and build on a base that lacks it. So a pass that has closed is `CLOSED` but not yet `SETTLED` (§11), and
while it is not settled an ordinary folder task still runs in a copy or waits, its notice now "Waits for the
Workbench pass's pull request to merge". The pass settles in one of three ways:

- the pull request merges and the trees match: 10db realigns the branch (§5.4), no file changes, settled;
- the pull request merges and the trees differ, or it closes unmerged: one card, **Move `<branch>` to
  `origin/<base>`**;
- the builder clicks that same card at any time before the merge, choosing to let the work leave the screen
  until it merges.

The card uses the built switch (`read-tree -m -u`, as the switch back does), which refuses when an uncommitted
file or a file git does not track lies where it would write, and says which. It also refuses, with the
reason, when the branch holds a commit that is neither on the base nor on the pass's pushed branch: that is
the builder's own commit, and moving the branch would drop it. A `local` project settles at close: the
fast-forward is its landing.

**A new pass may open on a pass that has closed and not settled** (builder's decision, D24). It stacks:

| | The closed pass, A | The new pass, B |
|---|---|---|
| `return_branch` | R, already fast-forwarded to A's tip | R again |
| `start_sha` | where R was before A | A's tip, which is where HEAD is |
| `stacked_on` | | A |
| Pull request | head A's branch, base the project's base | head B's branch, **base A's branch** while A's is open, so it shows B's work alone |
| The Move card | withdrawn while B is open or closing; raised again, if still due, when B is abandoned | its own, after its close, by the rules above |
| Realigning R | not done while B is open or closing: B's close moves R from A's tip to B's tip by compare-and-swap, and a moved R would fail it | after B's pull request merges, R moves to the base when the base's tree equals B's tip, which then holds A's work too |

- **When A's pull request merges,** A is `SETTLED`: its work is in the base, and R's alignment is B's to do.
  10db retargets B's pull request to the project's base. If the base's tree equals A's tip (no drift, no CI
  fix), it also brings the base into B's branch by one merge commit whose tree is B's tip, so no file changes
  and B's pull request goes on showing B's work alone **(call)**. Otherwise it only retargets, and B's pull
  request lists A's commits beside its own until it merges; B's header says so.
- **When A's pull request closes unmerged,** B's header says the pass it was built on did not merge and offers
  **Retarget to `<base>`**, after which B's pull request carries A's work as well as its own **(call)**.
- **If B is abandoned** with its branch still at its `start_sha`, HEAD returns to R at A's tip and A's card and
  realignment resume. Otherwise §5.4's rule for an Abandon holds.
- W9's wait is unchanged: it lasts while any pass of the project is neither settled nor abandoned.
- A third pass may stack on B the same way. `stacked_on` is one pointer per pass.
- **On a `local` project there is nothing to stack.** A settled when it closed, so B opens at the folder's
  HEAD as §5.1 says and continues on the same branch: `return_branch` is R again, already at A's tip. If B's
  record pull request is opened while A's is unmerged, it takes A's branch as its base in the same way.

### 5.4 Closing

A pass closes when every task in it is signed off or taken out.

**Close Pass…** opens one form modal (DESIGN.md: centered, a footer that stays put while the body scrolls) that
settles every loose end with a safe default before anything lands:

- **Not signed off:** each unfinished page with a select, **Take Out** (the default: it keeps its thread and
  kept work and goes back to the Board) or **Sign Off Now**.
- **Edits no page owns:** each file with its diff size (`+4 −1`) and a select, **Leave Out** (the default: it
  stays uncommitted in the folder) or **Add to <page>**.
- Above the footer, one line saying what will happen: "Lands 3 pages and 1 shared change on `build`; opens a
  pull request for review."
- Footer: **Cancel** and **Close Pass**, the one filled button.

A section with nothing in it is not drawn. With nothing loose, the modal is the summary line and its footer.

**Opening the modal stops nothing** (builder's decision, D25). A page whose agent is working is listed with
"Working · will be stopped", and Cancel leaves every turn running. On Close Pass, 10db stops the agents (step
0 below), works both lists out again, and closes only if they are what the modal showed. If a stopped turn
changed them (a file no page owns, a page that is no longer finished), the modal stays, shows the new lists
with what changed marked, and asks again.

Two things the lists also carry: a page set to Take Out that has shared changes not yet landed shows, for
each, **Keep** (the default) or **Drop**, as a take-out at any other time asks (§7.2); and pages set to Sign
Off Now are signed off first, in the order the modal lists them, before anything else lands.

- **Taking a task out** (the builder's choice per unfinished task at close, or at any time) is six steps in
  this order, each recorded on the task's `pass_take_outs` row so a restart continues from the step it reached:
  0. stop the task's session: interrupt a working turn, wait for the session to end, and run steps 2 to 4 of
     §6.2's turn end for what it left (the shared change, the page's kept work, the reply), so nothing is
     still writing the page and its last work is kept. **Steps 5 and 6 are not run:** a stopped turn never
     makes the page Ready, raises no `check` item, sends no notification and asks for no check or picture
     (D25);
  1. fold in hand edits (§6.4);
  2. make a last kept commit (§9.1), which holds every file of the page that differs from the pass's branch,
     files git does not track yet included (ignored files are never touched);
  3. check that the kept commit's page files hash the same as the files on disk. A mismatch means something
     wrote between steps 2 and 3: steps 1 to 3 run again, three times at most. After that a take-out the
     builder asked for by itself stops: the task stays in the pass, and its thread says the files keep
     changing and names them. **Inside a close or an Abandon it does not stop,** because those must finish:
     the last kept commit stands, the files that still differ are left on disk exactly as they are, step 4
     skips them, and the close's or the Abandon's card names each one, with its page;
  4. put the page's files back **to what they were without this task**: the pass's branch version where
     something has landed on that path during the pass, otherwise the file as it was before the pass, its
     earlier uncommitted content included (§5.1 step 4 kept it). A file the task added is removed. Each file is
     hashed again just before it is written; one that changed since step 3 is left as it is and named on the
     thread, because the builder's editor is not under the daemon's lock;
  5. release the page, **cancel the task's workstream**, and return the task to the Board, open, with its
     thread and no pass (W6: unfinished tasks stay open). The workstream is cancelled, not queued: the
     scheduler launches every `QUEUED` workstream that is not parked (§2), so a queued one would start an
     ordinary session in the folder the moment the pass let go of it. `WAITING_HUMAN → CANCELLED` and
     `RUNNING → CANCELLED` are edges today (`packages/contracts/src/workflow.ts:19-29`). The task itself is
     not cancelled.

  So a take-out gives back the builder's own earlier edits to the page's files; they are also inside the
  task's kept work, which was built on top of them (§4.2).

  **What an ordinary start does with kept work** **(call)**. A taken-out task shows "Has saved Workbench work
  · 3 files" in its drawer, with **Discard Saved Work**. Starting it from the Board, in Your folder or in a
  separate copy, first puts the kept work back in the checkout it will run in, by the put-back below; the
  session's brief carries the thread's digest and names any file that did not apply. From there it is an
  ordinary task, gate and all. The kept ref is deleted when the task's work lands or the builder discards it.

  The kept commit moves to `refs/10db/kept/<task id>` and stays until the task is removed or its work lands.
  A later pass that takes the task puts the kept work back file by file: a file still exactly as step 4 left
  it takes the kept version; any other is merged three ways, the commit it was kept on as the base, the file
  on disk as one side and the kept version as the other (`merge-tree` with a named base, as a revert uses it,
  `apps/daemon/src/git/git.ts:1597`); a file that does not merge cleanly is left and named on the thread.
- **Unowned edits** (W10): files that differ from the pass's branch and that no task of the pass owns are
  listed, dirt from before the pass marked as such. For each, the builder places it in a signed-off task (it
  lands as one more commit naming that task) or leaves it out (it stays uncommitted in the folder).
- **Shared changes of pages taken out** that were kept (§7.2) land now, as commits naming their task.
- **Nothing in a close is refused for a dirty folder, and no close writes a file** other than step 4 of a
  take-out. The built ship fails on any changed path (§2); a pass's ship does not make that check, because it
  removes no worktree and switches nothing back, so there is no work it could throw away.
- Then the pass's batch ships by its own steps (§5.5): the gate (§8.3), the push, the pull request made ready
  for review. Its body lists the tasks, one line each, and says how the pass was checked, and on what (§8.3).
  A gate that fails puts the pass back to `OPEN` with the batch's card; nothing below has happened yet
  **(call)**. The batch has no edge from `SHIPPING` to `OPEN`
  (`packages/contracts/src/batch-workflow.ts:13`): it goes `SHIPPING → FAILED`, as a failed ship does today,
  and the pass's reopening moves it `FAILED → OPEN`. Every rule of §5.5 that names an `OPEN` pass batch reads
  `OPEN` or `FAILED`.
- **The order of a close,** so that a failed gate undoes as little as it can:
  1. show the modal, stopping nothing (D25);
  2. on Close Pass: stop every session of the pass, as step 0 of a take-out does; work the lists out again
     and go on only if they match what was shown, else show them again; then sign off the pages set to Sign
     Off Now, and land the placements and the kept shared changes (commits only);
  3. where the gate runs in a scratch worktree (§8.3), **run it now, before any take-out**, on the tip that
     will be pushed. If it fails, no page has been taken out and the pass is open exactly as it was, plus the
     commits of step 2;
  4. take out the pages chosen for it;
  5. where the gate runs in the folder, run it now: it needs the folder to hold only what the branch holds.
     The consequence is stated in the modal for such a project: if this gate fails, the pass reopens with
     those pages already taken out, their work kept with their tasks;
  6. push, make the pull request ready, then D8's fast-forward.
- **The work stays on screen** (builder's decision, design review D8). At close the branch the folder was on
  fast-forwards to the pass's tip and the folder returns to it, so the builder's app keeps showing every
  signed-off page and ordinary folder tasks build on them. The fast-forward is always possible: the pass's
  branch started at the folder's HEAD (§5.1) and nothing else committed in the folder while the pass was open
  (W9). On a `local` project (ampsio) this is the landing, and the pass's pull request is a review record the
  builder may merge or close; this narrows W8 for `local` projects. On a pull request project, once the squash
  merge lands, 10db moves the folder's branch to the base on `origin` when their trees match, so the branch
  carries no duplicate of the pass's commits. The built switch-back
  (`docs/architecture/02-batch-delivery.md:51`) is not used for a pass.

  How D8 is done, under the repo lock, each step safe to run again after a crash:
  1. If `return_branch` is checked out, being rebased or bisected in another worktree (the check the daemon
     already has, `branchInUseElsewhere`, `apps/daemon/src/git/git.ts:1458`), stop: moving a ref another
     worktree sits on would leave that worktree's files behind its branch. The folder stays on the pass's
     branch and one card says why.
  2. If `return_branch` already points at the pass's tip, this step is done (a rerun). Otherwise
     `update-ref refs/heads/<return_branch> <pass tip> <start_sha>`: a compare-and-swap, so it moves the branch
     only if nothing moved it since the pass opened. W9 keeps 10db from committing there; a `git` typed by hand
     in another worktree still can.
  3. HEAD is pointed back at `return_branch`, if it does not name it already. No file is written: the folder
     already holds the tip's files.
  4. The folder's own index is refreshed for the paths the pass landed (§18).

  If step 2 finds the branch moved, nothing is forced: the folder stays on the pass's branch and one card says
  so, with the command that merges the pass's branch into it.

  **After the merge** (D22). The realignment is the same compare-and-swap. It runs when the pull request
  watch reports the merge, only if `return_branch` still points at the pass's tip, HEAD still names it, no
  other worktree has it, and the fetched base has the same tree as the pass's tip; then the ref moves, no
  file changes, and the pass is settled. It matches only when nothing else reached the base first. Two things
  make the trees differ, and both end at the card of §5.3, never at a forced move:
  - **drift:** another pull request merged into the base before this one, so the base holds more than the
    pass;
  - **a CI fix:** after the close the pass's batch is `SHIPPED` and the built fix path applies to it
    (`docs/architecture/02-batch-delivery.md:44-46`). A fix is made in a separate copy and pushed to the pull
    request, so the merged work holds commits the folder's branch never had. Until the builder clicks the
    card, the folder shows the pass as it was signed off, without the fix.
- If the pull request merges while the pass is open, the pass must close: tasks still open are taken out and
  carry over to a new pass **(call)**. The pull request watch follows a pass's batch from the moment it has a
  pull request (§5.5), so the merge is seen.
- **Abandon Pass** (in the `⋯` menu) is the exit that always works. By the builder's decision (D23) it puts
  each unsigned page's files back to their state before the pass; that page's work stays saved with its task,
  which goes back to the Board with its thread; signed-off pages stay as landed. Its confirm lists both:
  "Reverts on screen: Billing, People (their work is kept with their tasks). Stays: Settings, Home (signed
  off)." It also lists shared changes that have not landed, which revert with their pages.

  The built Abandon does not fit: it cancels every member's workstream and has no way out of `SHIPPING`
  (`apps/daemon/src/delivery/ship.ts:2298-2307`). A pass's Abandon is its own sequence, each step recorded on
  the pass (`passes.abandon_step`) so a restart continues it:
  1. the pass becomes `ABANDONING`; no message, sign-off or close is taken from here on;
  2. **a ship in flight is aborted:** the gate's signal is raised and the ship job is waited for, to the end of
     its current step. If the push had already happened, the pull request stays as it is, and the confirm's
     result says so; closing it is the builder's act on GitHub;
  3. **every session of the pass is stopped,** as step 0 of a take-out does, and each one's last work is kept;
  4. each shared change that has not landed is dropped, newest first, as §7.2's Drop does, without Drop's
     refusals blocking the rest: a file that has changed on disk since is left as it is and named;
  5. each unsigned page is taken out by steps 1 to 5 above. Its workstream is cancelled and its task is open
     on the Board with no pass, its claims released, its work at `refs/10db/kept/<task id>`;
  6. signed-off tasks are untouched: `DONE`, their commits on the pass's branch;
  7. the batch goes to `ABANDONED` (from `OPEN` or `FAILED`; from `SHIPPING` through `FAILED` after step 2,
     since those are the edges that exist), which frees the project's one unfinished shared batch; the pass
     is `ABANDONED`, which ends W9's wait;
  8. the folder's own index is refreshed for every path steps 4 and 5 wrote.

  **An Abandon always finishes.** No step waits on the builder or retries without end: a session that will
  not end is killed as a stop does today; a file that keeps changing, or changed since it was hashed, is left
  as it is (steps 3 and 4 of a take-out, three tries); a drop that cannot write a file skips it. Every such
  file is named on the Abandon's card with its page, so a pass stuck in `ABANDONING` cannot hold the project.

  **Where the folder ends** **(call)**. It is decided by the branch, not by counting pages. If the pass's
  branch is still at `start_sha` (nothing landed: no sign-off, no placement, no shared change), HEAD is
  pointed back at `return_branch` and the folder is as it was before the pass, earlier dirt included.
  Otherwise HEAD stays on the pass's branch, which is what holds the landed work: moving back would take it
  off the screen, and fast-forwarding `return_branch` would land work no gate has passed. One card says
  where the folder is and offers the two ways on: the command that merges the pass's branch into
  `return_branch`, or **Move to `<return_branch>`**, the built switch, which takes the landed pages off
  the screen and keeps them on the pass's branch. A pass opened while the folder is still on an abandoned
  pass's branch records that branch as its `return_branch`, as §5.1 would for any branch, and Start Pass
  says so. Nothing is pushed or deleted by an Abandon. A pull request the pass had already opened stays open
  and is **no longer watched**: an `ABANDONED` batch is not read by the watch, so its merge or its failing
  checks raise nothing in 10db, and the card says that too.

  Because unsigned pages are put back, no page file is left changed and unowned for the next ordinary task
  to commit as its own, which `claimedChanges` would otherwise do (`apps/daemon/src/runner/runner.ts:2354-2388`).
  A file step 5 could not write is named on the card for the same reason.

### 5.5 The pass's batch

A pass has one batch row with `pass_id` set and no worktree. It reuses the batch's branch name, push, pull
request text, pull request watch and cards. These built rules read differently for it:

| Built rule | For a pass's batch |
|---|---|
| A batch start in a `local` project answers 400 | Unchanged for the route; the pass makes its batch itself (§5.1), on any delivery (W8) |
| The cut starts from the base and needs a clean checkout | The branch starts at the folder's HEAD and no file is written (§5.1) |
| The scheduler launches every `QUEUED` workstream | It skips a pass task's workstream until that task has a builder message no session has taken (§6.1), one more skip beside the parked-column rule |
| The ship trigger ships an `OPEN` batch when its last member settles | It never ships a pass's batch; signing off the last page lands a commit and nothing more. Only Close Pass moves the pass to `CLOSING` and its batch to `SHIPPING`; start-up's same check skips it too |
| Ship fails on any changed path in the checkout | Not checked (§5.4). The gate's evidence names files that differ from the tip when the gate ran in the folder (§8.3) |
| The checkout is switched back after `SHIPPED`, `CLOSED` or `ABANDONED` | Not used; D8's fast-forward instead (§5.4) |
| The pull request watch reads `SHIPPED` batches, and starts a Fix CI task and batch when required checks fail (`docs/architecture/02-batch-delivery.md:44-46`) | It also reads a pass's `OPEN` batch once Open Pull Request has made one, **for merged and closed only**. While the pass is open it starts no fix: failing checks are one notice in the pass header naming the checks, with Send to Agent on the page the builder picks (D19). After the close the batch is `SHIPPED` and, on a pull request project, the built fix path applies (§5.4). On a `local` project the pull request is a record and a fix needs a separate copy the project does not allow: the watch reads it for merged and closed only, always, and failing checks are a notice on the closed pass |
| The built Abandon cancels every member and cannot leave `SHIPPING` | A pass has its own (§5.4, D23) |
| A daemon commit is signed as the project's config asks (`apps/daemon/src/git/git.ts:2185-2190`) | Commits on the pass's branch are signed the same way. Kept commits, chain commits and the commits that hold recorded content are unsigned, as the daemon's other commits under `refs/10db/` are: they are never pushed |
| A project with no `origin`, or no `gh`, cannot ship | A pass still closes: D8's fast-forward is the landing, the push and pull request are skipped, and the close says so **(call)** |

## 6. A pass task

### 6.1 Lifecycle

Today a task's workstream runs `QUEUED → STARTING → RUNNING → VERIFYING → DONE`, with a gate after each
implement step. In a pass:

```
OPEN ──first message──▶ WORKING ──turn ends──▶ READY ──Sign Off──▶ SIGNED OFF ──pass closes──▶ DONE
                           ▲                     │
                           └──── a message ──────┘
```

| Shown | Workstream | Notes |
|---|---|---|
| Open | `QUEUED`, not launched | the page is claimed (§5.1); the scheduler skips it (§5.5) until the first message, or the task's description, is there to send |
| Working | `RUNNING` | one implement step, no plan or review step per turn (one review of the pull request instead, §8.3); model and effort from the project's implement step |
| Ready | `WAITING_HUMAN`, `nextAction.kind = 'pass_review'`, a `check` item | no new workstream state, as the optional-gate decision chose; used here whether or not the project has a gate; the session is still attached while it is warm |
| Signed off | `DONE` | the pass's Sign Off (§9.2); the page claim is released (W15) |

**Ready in a pass is not the built builder check, though it looks like it.** The built check means "no
session, no lane": `waitsForCheck` requires `currentSessionId` to be null
(`apps/daemon/src/runner/builder-check.ts:89-95`), `approveCheck` throws when it is not
(`apps/daemon/src/runner/runner.ts:3145-3148`), the built card offers Send Back, which adds to `attempt`
(§2), and recovery raises the card again with the built facts (`apps/daemon/src/recovery/recover.ts:120-139`).
A Ready page has a warm session. So:

- a pass's Ready has its own next action, `pass_review { inboxId }`, and `waitsForCheck` stays false for it;
- its `check` item carries the pass in its detail and one option, Sign Off. The built Approve and Send Back
  are refused for a task in a pass (409), whoever calls them; the only ways on are the thread and the pass's
  sign-off route;
- recovery has a branch for `pass_review`: it keeps the live item, or raises it again with the pass's facts
  (the kept commit), never the built ones;
- the Inbox draws a pass's `check` items folded, with no Approve or Send Back, from the slice that first
  makes them (§14 slice 5), not from the Workbench's slice;
- three places test for `builder_review` by name, in checks that are not exhaustive switches, and each must
  decide for `pass_review` as well: the parked-answer delivery (`apps/daemon/src/runner/runner.ts:3129-3132`),
  the head a check was shown (`apps/daemon/src/delivery/workstream-changes.ts:29`) and recovery's choice of
  the open item (`apps/daemon/src/recovery/recover.ts:145`).

This holds on a project with a gate, a plan step and a review step too (10db is one): inside a pass no task
runs them. W16 and D21 put one gate and one review at the pull request instead.

- **A message** moves Ready to Working through a new next action, `feedback { messageId, providerSessionId }`.
  It is not Send Back: it adds nothing to `attempt`, never escalates the model, and continues the same session.
- **Every turn starts from a row the builder wrote** in `task_messages`: a message, the task's description, or
  "What's bothering you?". The daemon never starts a turn by itself (D19).
- **Each Ready is a new `check` item.** Today a workstream's one live card is refreshed in place, and a
  refreshed card raises no notification (§2), so from the second turn on the builder would hear nothing. In a
  pass, a builder message withdraws the page's live `check` item, and the next Ready raises a new one. Its
  facts are not the commits since the task's base, which a turn does not make: they are the kept commit, the
  files that turn changed, and the page's files against the pass's branch (§9.1).
- **W15's consequence:** a signed-off page is free at once, so a later task may build on work that has landed
  on the pass's branch and not yet merged. Both are in the same pull request.
- **Reopening:** a message to a signed-off task makes a new workstream for it that takes the page again, or
  waits for it. What it lands is a second commit.
- A question the agent asks (`ask_human`) and a permission it needs are the cards they are today, shown in the
  queue at rank 1.

### 6.2 A turn

A turn starts with a builder message (or the task's description, for the first) and ends when the session
reports the turn complete with nothing of its own still running.

**The end of a turn is a new mode of the runner, not the end of a step.** Today that event records `step_done`,
stops the session, kills its processes, ends its row, and goes to `verify`, which sends a step back with
`attempt + 1` when its claims hold uncommitted changes (§2). A pass lane would lose its warm session every
turn and fail on its third. So for a workstream whose task is in a pass:

- the event neither records `step_done` nor stops the session; the session, its sandbox and its row stay, and
  the runner goes on reading the same session's events;
- `verify`, the send-back for uncommitted changes and `finishWithoutGate` are never entered; uncommitted files
  in the task's claims are the normal state of a pass, and `attempt` never moves;
- the session ends only when it idles out, hands off, is stopped, fails, or its page is signed off or taken
  out. Its processes are stopped then, as built;
- **a command the turn left running does not hold the page.** Today a turn that ends with a background
  command still running is held open, up to `backgroundMs`, 15 minutes, whenever the step's claims hold
  uncommitted changes (`apps/daemon/src/runner/runner.ts:2139-2163`, `:238`). In a pass uncommitted changes
  are the normal state, so one watcher left running would keep every turn out of Ready for 15 minutes. A pass
  turn is over when the session says so. What it left running goes on until the session ends, and its
  finishing is a notice on the thread, never the nudge the runner sends today, which would be a turn nobody
  wrote **(call)**;
- **a handoff the builder did not ask for must not start a turn.** When a project moves accounts for a usage
  limit, the daemon asks every live session of the project to hand off by sending it a nudge
  (`apps/daemon/src/accounts/moves.ts:188-189`, `runner.ts:3121-3125`, `:1934-1943`). On a Ready page's warm
  session that nudge would be a turn nobody wrote. So for a pass lane that is not working, the request closes
  the session and sends nothing; its next message starts fresh on the new account (§6.3). A working pass lane
  is nudged as built, and a handoff that names work left continues the same turn in the next session
  (`decisions/2026-11-08-a-handoff-that-names-work-left-stands.md`);
- **the limit on handoffs nobody asked for** counts handoffs that made no progress by comparing the checkout's
  head (`runner.ts:2126-2129`), which a pass turn never moves. For a pass lane it compares the task's kept
  commit instead, so a long turn that hands off twice with work kept between is not stopped as stuck.

At the end of a turn the daemon, not the agent:

1. checks no builder message is still on its way in (§6.3). If one is, the turn is not over: the agent is
   about to see it, and the steps below wait for the next completion, so the page does not flap to Ready and
   back;
2. keeps what the turn changed in shared areas as a shared change, and releases those areas (§7.2);
3. keeps the turn's page work (§9.1);
4. writes the agent's last text to the thread as its reply;
5. parks the workstream `WAITING_HUMAN` with `pass_review` and raises a new `check` item, which notifies;
6. asks for the changed-files check (§8.1) and the turn's pictures (§10), neither of which the builder waits
   for.

A pass task's brief tells the agent: work inside your page; ask for shared code with `request_claim`; do not
run the gate or start a dev server; stop when the change is on screen and say in two lines what you changed.

**The `commit` tool is rerouted in a pass.** Today it commits on the batch's branch (§2), which in a pass
would land work nobody signed off. For a pass lane it runs the same judge on each path, then does steps 2 and
3 early: page paths go to the task's kept commit and shared paths under a hold go to a shared change. It
answers with that commit and never moves the pass's branch. The daemon's own steps at the end of the turn mean
a turn never ends with work that nothing has kept, whether or not the agent called the tool.

### 6.3 The session: warm, then resumed

- The lane session handle gains what Plan's has: `send(text, images)` and `interrupt()`.
- After a turn the session stays open. A message goes straight in. After 10 idle minutes it closes and frees
  its lane; the next message starts Claude Code again with `resume` (W14).
- **A full context uses the built handoff, and only that.** The runner nudges a pass lane to hand off at the
  project's `handoffPct` as it does any lane; the session writes its handoff and ends, and the next session
  starts from it, mid-turn or at the next message. An earlier draft added a second rule (a fresh session past
  70%); two thresholds would race, so there is one.
- **The thread digest is how every fresh session starts,** not a trigger: the brief, the builder's messages,
  each turn's reply and the files changed, built by the daemon from rows, after the latest handoff when there
  is one. Pictures the builder pasted are not resent; the digest names them, and the session can read a stored
  picture by its path.
- **A session that cannot be resumed starts fresh from the digest.** Three cases exist today: a resume that
  fails falls back to a start or a handoff (`apps/daemon/src/runner/next-action.ts:29-35`); a project moved to
  another account cannot resume a conversation kept under the first account's config (`:40-44`), which is what
  a usage-limit fallback does mid-pass; and a session whose id was never recorded. In each, `feedback` keeps
  its message and drops the session id, and the fresh session's first message is the digest followed by the
  builder's message. The thread notes "Started a fresh session".
- **During a turn** (W13): Send queues the message with the adapter's `next` priority, so the agent sees it at
  its next step. Stop and Redo calls `interrupt()`, then sends the message; the interrupted turn's edits stay
  in the folder and are in the next turn's work.
- **A message is marked delivered on evidence, not when it is pushed.** `send` pushes into a channel in the
  daemon's memory (`apps/daemon/src/sessions/claude-adapter.ts:868-878`), so "pushed" proves nothing: a crash
  loses it, and a message pushed as a turn ends runs after the completion. A row therefore has `pushed_at`
  and `delivered_at`.
  - **The evidence is consumption, not receipt.** Each message is pushed with its row's id as the SDK
    message's `uuid`: the UUID part of the id, since a row id is a prefix, an underscore and a UUID
    (`packages/contracts/src/ids.ts:101`). The agent SDK stamps, on the assistant's messages, the uuids of every user message whose
    prompt the turn has consumed so far: `user_message_uuids` (in the pinned
    `@anthropic-ai/claude-agent-sdk` 0.3.316, `apps/daemon/package.json:17`; its `sdk.d.ts:3724-3731`). `delivered_at` is set when a row's id
    appears there. An echo of the message back would only prove the process read it, not that a turn took it.
  - **Stop and Redo:** an interrupt answers with the uuids still queued (`still_queued`, `sdk.d.ts:4858-4862`).
    A message named there stays undelivered and is the next turn's start; one not named and not yet seen in
    `user_message_uuids` is pushed again. A Claude Code that does not advertise the interrupt receipt answers
    nothing (`sdk.d.ts:2944-2952`); then every message pushed and not delivered is pushed again after the
    interrupt, which at-least-once delivery allows.
  - **A session that ends with a message it never consumed** (idled out, handed off, stopped, crashed): the
    workstream is queued again with `feedback` for that message, so it starts the next session rather than
    being lost.
  - A message pushed and not delivered holds the page out of Ready (§6.2 step 1). Delivery is at least once:
    the id travels with the message, and the brief says a repeated id is one message.
  - The live Claude test (not in `make gate`) asserts the stamps for a message sent mid-turn and for one sent
    as a turn ends; it is run again at each Claude Code or SDK upgrade, as the Plan session's live test is.
  - **On Codex** the row's uuid goes as `clientUserMessageId` on `turn/start` and `turn/steer`, and the thread
    records it as the `clientId` of the user message item a turn takes the input in. That record comes as the
    turn begins, before the model answers, so the message is delivered once a model item follows it in its
    turn, or the turn completes. An interrupt's receipt is the messages the session has not handed to Codex
    yet; Codex drops a steered message the interrupted turn had not taken, so every other one is pushed again.
    A turn that fails, or that the guard interrupts, drops what it was handed and did not take: the message
    goes back to 10db's queue and the turn fails, so Retry Turn or the next message sends it. A Codex lane can
    open no stored picture by its path, so every push sends every picture as a local image Codex reads from
    the stored file. `test/codex.live.test.ts` runs the real binary.
- A picture is sent as an image block when it fits the account's limits, otherwise as a path the session
  reads; the budget is counted per thread as Plan counts it per conversation.

### 6.4 The builder's hand edits

When the builder sends a message, and when a page is signed off, the daemon compares the task's page files with
what its last turn left (§9.1). Files that differ were edited by hand, or by the builder's own tools.

- They become part of the task's kept work at once, attributed in the thread: "You edited 2 files by hand."
- The message the agent receives lists them with a diff summary and says to keep them (W10).
- A hand edit during a turn cannot be told from the agent's own; it is kept with the turn.
- A write to a file no pass task owns is a stray today (`apps/daemon/src/watcher/strays.ts:79-86`). In a pass
  it is the builder's only when no agent could have made it: **while no lane of the pass is working**, it
  raises no card and goes on the list that closing shows (§5.4). While any pass lane is working it raises the
  stray card as built, naming the lanes that were working, because an agent's shell command can write
  outside its claims and the guard's hook does not see it. The file is on the closing list either way.
- **A hand edit to a page that is Ready or Open raises no card either.** Today it would: the watcher treats a
  write inside a claim whose holder is not in a lane state as a foreign write and cards it (§2), and a Ready
  page's holder is `WAITING_HUMAN`. While a pass is open, the watcher raises neither a foreign-claim card nor a
  stray card for a path inside a claim a task of that pass holds. The write is found by the comparison above
  instead.
- The watcher cannot tell the builder's hand from another page's agent writing through a shell, which the
  guard's hook does not see. So when a file in a page changed outside that page's turns while another pass
  lane was working, the fold does not call it the builder's: the thread says "2 files changed outside this
  page's turns, while People was working" and lists them **(call)**. Sign Off still asks nothing (D11); the
  line is there to read first.
- **Files changed before the pass** in a page's area join that page's first kept work, marked "from before the
  pass", as Start Pass said they would (§4.2). They are told apart by `pass_dirt` (§5.1).

### 6.5 How fast

The edit shows through the dev server's hot reload when the file is written. Nothing in §6.2 runs before that.
Expected, to be measured (§16): a warm session has the message in about a second; a resumed one in 5 to 20
seconds; the agent's own work takes from seconds for a spacing change to the builder's ten minutes.

## 7. Pages and shared code

### 7.1 What an area gains

`AreaDef` is a name, globs and an optional `catchAll` (`packages/contracts/src/entities.ts:90`). It gains two
optional fields (W18):

- `role`: `page` or `shared`. Absent, the area behaves as today.
- `route`: on a page, the path that shows it (`/people`).

A **page** is held by one task for the task's life, as any area is today. A **shared** area is one many pages
import (a components directory, global styles, public assets); in a pass it is held one turn at a time. Claims
stay on areas: that is what the guard and the commit tool judge.

**An area with no role, claimed by a pass task,** behaves as a page in the pass: held for the task's life, its
files part of the task's kept work and its sign-off commit. It has no route, so no Open Page and no pictures.
A Board task that joins a pass naming a shared area starts without that claim and asks for it per turn. A
task must still name at least one page area to join (§4.2).

**A hazard a pass task holds** (`deps` or `migrations`, granted as today where the project allows no copy,
§8.4) is held for the task's life, as a hazard is now. The files it covers that the task changed, a manifest
or a lockfile or a migration, are part of that task's kept work and of its sign-off commit, exactly as its
page's files are. Without this they would belong to no bucket: not a page's, not a shared change, and so
never landed. A take-out and an Abandon put them back with the page.

Features, the open question about value surfaces, do not block this. A Feature will be a name and a line over
one or more areas; "pick pages" lists page areas now and Features when they exist.

What each project needs before its first pass (live settings, read on 2026-11-09):

| Project | Today | Needs |
|---|---|---|
| ampsio | 22 areas: 11 of one Next route directory each, one that bundles six routes with docs and e2e files, and `src` for `amps/frontend/src/**` | the roles and routes set; the bundled area split; the root layout's area marked shared (§7.3) |
| 10db | one area, `repo`, `**` | page areas, one per view under `apps/desktop/src/views/`, and a shared area |
| orgtools | one area | page areas |

The area proposer (`decisions/2026-10-29-propose-areas-from-the-repository.md`) learns to propose a role and a
route with each area; Settings › Areas and hazards edits them. A project with no page area cannot open a pass,
and the Workbench says so with a link to that screen.

### 7.2 When a task needs shared code

1. The agent calls `request_claim` for the shared area, as it must today before writing there.
2. **The first task to ask in a pass gets it for the turn.**
3. **A later task asks the builder first** (W5), if another task of the pass has changed that area during the
   pass or holds it now. The daemon raises the question itself, so it does not depend on the agent choosing to
   ask: "People wants to change shared code in `src`. Settings changed `Button.tsx` there 12 minutes ago."
   Answers: **Allow**, **Keep It to This Page**, or a reply. It is a `question` item on the task, shown in the
   queue at rank 1 and in the Inbox.
4. On Allow the claim is granted, after the usual wait if another task holds it this turn. On Keep It to This
   page the call answers `granted: false` with that instruction.
5. When the turn ends, the daemon keeps the shared files the turn changed as a **shared change**: a commit on
   the pass's shared chain, `refs/10db/passes/<pass id>/shared`, naming the task, and releases the claim. The
   branch does not move. "Changed" means changed during the hold: the daemon records the shared area's dirty
   paths and their blob hashes when it grants the claim, and keeps only what differs from that record, so
   edits already in the folder are never kept under a task's name.

**A shared change lands with its page** (builder's decision, design review D17), so the pull request holds only
signed-off work (W6):

- Holds on a shared area are one at a time, so the chain is in the order the folder saw. Signing off a page
  lands, on the pass's branch, every shared change on the chain up to and including that page's last one,
  then the page's own commit.
- A shared change made by a page that is still open lands early only when an earlier-signed page needs it: the
  sign-off lands the chain up to the point it needs, and its thread says so ("Landed People's change to
  `Button.tsx` with Settings, which builds on it"). A page needs a shared change when its kept work was made
  after that change entered the folder.
- Taking a page out asks, for each of its shared changes not yet landed, **Keep** (it stays in the folder and on
  the chain, and lands with the next sign-off) or **Drop** (its files are put back to the version before it;
  pages that changed later are named first).

Each shared change posts a line to every other open thread of the pass: "Settings changed shared `Button.tsx`."

**How the chain works.** The rules above are the builder's (D17); these are the mechanics that make them hold.

| Step | Mechanics |
|---|---|
| The record at a grant | When a shared claim is granted, the daemon stores, for the area, every path that differs from the chain's tip (the pass's `start_sha` when the chain is empty) with the hash of its content on disk: `pass_holds` (§11). Dirt from before the pass and hand edits made between holds are in this record, so they are not "changed during the hold". The content is stored too, as git objects held by an unsigned commit at `refs/10db/passes/<pass id>/holds/<claim id>`, so a Drop can put a file back to exactly what it was before the hold. A path that belongs to a page (§7.3) is never in the record. The hold is given its chain number here, at the grant (`pass_holds.seq`), not when its turn ends. |
| What a hold kept | At the end of the turn, a path in the area is in the shared change when its content on disk differs from the record (or, for a path not in the record, from the chain's tip). The change's tree is the chain tip's tree with those paths as they are on disk. A file that was already dirty and that the agent also changed is kept whole, since a file cannot be split; the notice on the threads says "includes edits that were already in your folder". |
| The chain | A line of commits at `refs/10db/passes/<pass id>/shared`, the first on `start_sha`, each the parent of the next, each naming its task and carrying a sequence number. Its trees hold shared files only over the start. The ref moves by compare-and-swap under the repo lock, so two turn ends cannot both extend the same tip. One hold at a time per area makes the order of the chain the order the folder saw. **The chain is ordered by its sequence numbers, not by the order commits were appended:** two tasks can hold two different shared areas at once, and the one granted second may end its turn first. Their paths cannot overlap, so each change is landed from its own paths and blobs (below), read in number order from `pass_shared_changes`; the ref only keeps the commits alive. |
| What a page needs | Each kept commit records the highest chain number **granted** when its turn ended (`pass_turns.shared_seq`), holds still open included: another page's agent may already have written a shared file that this page was built and looked at with. A page needs the chain up to that number. Folding hand edits at sign-off does not advance it. If a hold the page needs is still open at sign-off, the sign-off waits for that hold's turn to end, and the row says so: "Signing off: waiting for People's turn". The builder can stop that turn. |
| Nothing to keep | A hold that changed nothing makes no chain commit; its number is recorded as empty and landing skips it. |
| Landing | Sign-off lands, in chain order, every shared change above `passes.shared_landed` up to the number the page needs, then the page's commit (§9.2). Each landed commit is the branch's tip with that change's paths set to its blobs. Landing is always a prefix of the chain, so the branch's shared files are always a state the folder was in. |
| Drop at a take-out | Offered only when no later change on the chain touches the same paths and the files on disk still hash to the chain's tip; otherwise only Keep, with the reason. A drop appends a change that puts the paths back and writes the files, each hashed again just before it is written. "Back" is the file as it was when the hold was granted: the content recorded at the grant for a path that was already changed then (so the builder's earlier edits return, not the committed version), and the chain's previous version otherwise. |
| Keep at a take-out | The change stays on the chain. It lands when a later sign-off needs it, or at close (§5.4). |
| At close | With every page signed off or taken out, the whole chain has landed or been dropped, so for shared files the branch equals the chain's tip. |

### 7.3 A file under a page is the page's, even when a shared area also matches it

Areas may overlap. `classifyPath` returns every area whose globs match a path
(`apps/daemon/src/guard/paths.ts:203-219`), and the guard allows a write when any one of them is claimed
(`apps/daemon/src/guard/judge.ts:132`). So if a shared area's globs also covered a page's directory, a task
holding the shared area for a turn could write another page's files, and the turn's shared change would
sweep them up. In a pass, three rules close that:

1. **Membership.** A path that matches a page area (or an area with no role that a pass task holds as a page)
   belongs to that page only. It is never in a hold's record, never in a shared change, and always in its
   page's kept work.
2. **The guard.** For a lane in a pass, a write to a path that matches a page area is allowed only when the
   lane holds **that page**. Holding a shared area that also matches is not enough: the write is denied with
   the page named. Holding a hazard that also matches is not enough either: today the judge allows any path
   under a held hazard before it looks at areas (`apps/daemon/src/guard/judge.ts:131`), so this rule is
   checked **before that allow**. This is one more row in the judge's table, with a test through the hook.
3. **The pick.** Two page areas that match the same file cannot both be saved as pages or both be in a pass
   (§4.2); a page that overlaps a shared area is allowed, because rules 1 and 2 decide it.

ampsio's live areas were read for this (the `areas` column only, 2026-11-09): its route directories are under
`amps/frontend/app/(app)/…` and its `src` area is `amps/frontend/src/**`, so **no page there sits under the
shared area today** and the rules above are a guard, not a fix for a present fault. Two things in those areas
do need the builder's hand before a first pass (slice 0): the area `accounts-diagnostics` bundles six route
directories with `docs/**` and `amps/frontend/e2e/**`, so it is one page with no single route until it is
split; and `amps/frontend/app/*`, the root layout's files, sits in the `frontend` area, which should be marked
shared.

## 8. Checks and the preview

### 8.1 Each turn: advice

After a turn the daemon asks for the project's `changedCheckCommand` when it has one
(`packages/contracts/src/entities.ts:513`), in the folder, under the gate's sandbox.

- **It goes through the one gate runner and its one slot,** as every gate must (§2). An earlier draft gave it a
  slot of its own; that broke the rule, and four checks at once would all exec into ampsio's one stack.
- **It is coalesced per pass:** a pass has at most one check waiting and one running. A turn that ends while
  one waits replaces it, since the check reads the folder as it is and the latest run covers every turn before
  it. A check may therefore wait behind another project's gate; it is advice, and nothing waits on it.

Its result is advice (W16):

- It never holds the page back from Ready, never adds to `attempt`, and never starts a fix by a retry rule.
- A failure is offered, never sent by itself (design review D19). It is a notice on the thread of the task whose
  claims hold the files it names ("Check failed: 2 errors in `settings/page.tsx`"), or on the thread of the
  task whose turn ran the check when it names no claimed file, with **Send to Agent**. The page stays Ready until
  the builder clicks it, which sends the output as the builder's message and starts a turn.
- **Finding the task is deliberately crude in the first version (call).** A check's output is free text. The
  daemon matches it only against the exact paths that differ from the pass's branch, each of which one task
  holds; it parses no tool's format. The failure always shows in the pass header as well, so a miss in the
  matching hides nothing. "The task whose turn ran the check" is every task whose turn ended since the last
  check ran.
- A project with no changed-files check runs nothing per turn, and Start Pass says so (§4.2).

### 8.2 When a task breaks the preview

Most breaks stay on their page, since Next and Vite compile per module. A break in shared code reaches every
page that imports it.

- A page whose task is mid-turn shows "changing" in the queue: a half-written page is expected.
- After each turn the browser of §10 loads the task's route for its picture. A document that fails to load, or
  that shows the dev server's error overlay, when the turn before it loaded cleanly, marks the preview broken
  by that task **(call: the overlay is detected by the element each dev server uses, per framework)**.
- "Preview broken by Settings" sits at rank 2 until a turn of that task loads cleanly, with **Send to Agent**
  (D19): nothing reaches the session until the builder clicks it. No other task loses anything.
- The builder can always say it in the thread, with a screenshot.
- A task that breaks the preview on two turns running is offered a move to a separate copy (§8.4).

10db does not start or restart the builder's dev server. It is the builder's own process, which the lane
process rules already leave alone: "Working in the checkout never makes a process the session's"
(`decisions/2026-10-30-stop-what-a-lane-session-started.md`).

### 8.3 Once: the gate

The gate runs for the pull request, on what the pull request holds (W16).

- **Open Pull Request** is offered at any time (W6). It pushes the pass's branch, which holds signed-off pages
  and the shared changes they landed only, and opens a draft. When the pass started on commits the base on
  `origin` lacks (§5.1), it first says how many and that the pull request will list them; on a `local` project
  that is usual, and the pull request is a review record (D8). With no `origin` or no `gh` the button is not
  offered, with the reason (§5.5).
- A project that allows separate copies gates the pushed commit in a scratch worktree of that commit, seeded
  and installed as a batch's worktree is (`decisions/2026-10-27-worktree-seed-by-clone.md`), so the gate reads
  no unfinished work and the builder keeps working **(call)**.
- A project whose gate can only run in the folder (a `local` project such as ampsio, whose gate execs into its
  one running stack) opens the draft marked "gate not run: pages are still open in the folder", and gates at
  close, when the folder holds only what the branch holds plus any edits the builder left out, which the
  gate's evidence names. Such a gate tests the folder and the running stack, not the pushed commit alone, and
  the pull request's "How it was checked" says exactly that.
- At close the batch's shipping gate runs through the one gate runner, in the scratch worktree where the
  project allows it.
- A failed gate at close raises the batch's card as today. The fix is a message to the task whose files it
  names, or a hand edit.

**One code review, at the pull request** (design review D21). A pass runs no plan step and no review step per
turn: the builder judges how the page looks. When the builder opens the pass's pull request, the project's review
step reads its diff once, with the project's reviewer model and effort, beside the gate. Each finding is a notice
on the thread of the task whose files it names, with **Send to Agent** (D19); a finding that names no pass task's
files is a notice in the pass header. A page that is reopened to fix a finding lands a second commit, and the
next Open Pull Request reviews the new diff only.

### 8.4 When a task leaves for a separate copy

Before it starts, placement already proposes a copy for a task tagged migration or dependency
(`decisions/2026-10-29-workspace-per-task.md`). During a pass, a pass task that asks for the `migrations` or
`deps` hazard, or breaks the preview twice running, gets one card with **Move to a Separate Copy**. Moving takes the
task out (§5.4) and queues it as a separate-copy task with the thread as its brief, where the project allows
copies; otherwise the hazard is granted as today and the Workbench says the page will be slow.

The card, the move and its trigger on a hazard request are built in slice 7, with take-out, which the move
is. The second trigger, a preview broken twice, needs the page load of slice 9 and arrives with it.

## 9. Landing

### 9.1 A turn's work is kept, not committed

At the end of each turn the daemon builds a commit from the pass's branch tip plus the task's page files as
they are on disk, with a private index as every daemon commit is, and keeps it at
`refs/10db/passes/<pass id>/<task id>` with the previous kept commit as its parent. The branch does not move.
The kept commit is what "what its last turn left" means in §6.4, what a taken-out task's work is saved as, and
what a turn's pictures are tied to.

- **A task's page files** are every path under the areas it holds for its life (§7.1) that differs between
  disk and the pass's branch tip: changed, added and not yet tracked, or deleted. Ignored files are never
  included. Those areas are exclusive, so each such path is this task's, the builder's hand edit to it, or dirt
  from before the pass that Start Pass named. The files under a hazard the task holds count the same way
  (§7.1).
- Each kept commit records the tip it was built on (`pass_turns.kept_base_sha`), which a later put-back merges
  against (§5.4), and the highest chain number granted when its turn ended (§7.2).
- The ref moves by compare-and-swap under the repo lock. A signed-off task's ref is deleted when its pass
  closes; a taken-out task's moves to `refs/10db/kept/` (§5.4).
- A turn that changed no page file makes no new kept commit: the turn's row points at the one before.
- Kept commits are unsigned (§5.5). They never leave the Mac.

### 9.2 Sign-off lands one commit

Sign Off first ends the page's session, then lands. The built approval needs a workstream with no session
(§6.1), and a commit must not race an agent that could still write:

0. stop the page's warm session and wait for it to end; its lane is freed and its processes stopped. If a
   hold the page needs is still open in another page's turn, wait for that turn to end (§7.2). The row reads
   "Signing off…" meanwhile.
   - **The wait is a row** (`pass_sign_offs`: the task, the hold it waits for, when it was asked), so a
     restart finds it and goes on waiting, or lands at once if the hold has closed; the builder can cancel it.
   - **It cannot deadlock with `request_claim`.** The other page's turn may itself be waiting for a claim
     the signing page holds, and then neither would move. A sign-off that waits on a hold whose task is
     waiting for a claim of the signing task answers that `request_claim` at once, `granted: false`, with
     "Settings is being signed off; do without it or ask again after your turn". The built deadlock check
     reads live waits (`apps/daemon/AGENTS.md:92`) and gains this wait as one of them.

Then one critical section under the repo lock, in this order:

1. fold in any hand edits (§6.4), as one more kept commit;
2. land the shared changes the page needs, in chain order (§7.2), one commit each;
3. commit the task's page files on the pass's branch, through the same private index and compare-and-swap the
   commit tool uses, as **one commit**: the subject is the task's title, the body lists each turn's first
   line, and the trailers carry the operation id and the task **(call: the message)**. It is signed as any
   daemon commit on a branch is. A page with no file that differs from the branch lands no commit, since git
   has nothing to commit (`apps/daemon/src/git/git.ts:2183-2184`): its thread says "Signed off · nothing to
   land", and the shared changes of step 2 still land;
4. refresh the folder's own index for those paths, and say so on the thread if another git held it (§18);
5. resolve the `check` item and end the workstream, in one write, which releases the page: `WAITING_HUMAN →
   VERIFYING → DONE`, the two edges the built approval takes, since there is none straight to `DONE`
   (`packages/contracts/src/workflow.ts:28-29`). This is the pass's own route, not the built Approve (§6.1).

Every commit of steps 2 and 3 has its own operation id (the pass and the chain number; the pass, the task and
the sign-off's count), so a crash at any point is recovered by finding the commits already on the branch and
making only the rest (`apps/daemon/src/git/git.ts:2174`). A compare-and-swap that fails because a hand-typed
`git` moved the branch (§18) retries from the new tip; the order is unchanged.

So the pass's branch reads, in order of sign-off, one commit per page, each preceded by the shared
changes it landed (W6, W7, D17).

**What the builder sees** (design review D11): Sign Off asks nothing. The thread's last line becomes "Signed off
· landed as `a1b2c3d` · 2 files", the row turns green and drops to the signed-off group, and the selection moves
to the next ready page. With none ready it stays, and the header says "Nothing ready · 2 working". A stray
sign-off is undone by sending the page a message, which reopens it (§6.1).

## 10. Screenshots for tasks in Your folder

A record: what each page looked like before and after a task. It applies to every task that changes UI in
Your folder, in a pass or not (success criterion 9). Tasks in separate copies wait for §17.

**The browser.** The daemon owns one headless Chromium, through `playwright-core` with a pinned browser build
fetched into the data directory as the pinned agents are (W17). It starts on first use and closes when idle.
The desktop's e2e suite keeps WebKit; this is a second, separate use of Playwright, in the daemon.

**What a project sets** (Settings › General, three new fields, all optional; with none, no pictures are taken):

| Field | Meaning | ampsio's value |
|---|---|---|
| App address | where the builder's dev server answers; a loopback host only | `http://localhost:8800` |
| Dev login command | prints a URL or path on the app's address that signs a browser in | its `dev_login` management command, which prints a `/api/auth/dev-login/…` path and is what its own e2e setup visits |
| Screenshot matrix | viewports and themes (W12) | default: one viewport, 1440 × 900, the app's default theme |

**Signing in.** The daemon runs the dev login command under the gate's sandbox, opens the printed address in a
fresh browser context, and keeps the context's storage state for the project. It runs the command again when a
capture lands somewhere other than the route asked for. A project with no login needs no command (10db's own
UI, served by `pnpm dev:factory`, takes its token from the dev server).

**Which pages.** Every page area the task has changed files in, by its `route`. In addition, routes the agent
names with a new lane tool, `report_pages { routes }`: needed for a route with a parameter (`/people/42`) and
for a task that changed only shared code. Each is a path on the app's address, at most 4 a turn.

**When.**

| Picture | Taken | Kept |
|---|---|---|
| Before | when the task starts, before its first edit | for good |
| Turn | after each turn of a pass task | 14 days after the task is done, unless a thread message shows it **(call: the 14 days)** |
| After | at sign-off; for a task outside a pass, when it is done | for good |

In a shared folder a picture shows the folder as it is, a neighbour's unfinished shared change included. The
row records the kept commit it was taken at.

**How.** The viewport, not the full page; animations off and the caret hidden, so an unchanged page gives the
same bytes; PNG. A turn that changed nothing under the page or a shared area is not shot.

**Where.** Files under the data directory, named by their content hash; rows hold the task, the turn, the
route, the viewport, the theme, the kind, the hash, the size and the path (§11). No picture is stored in
SQLite, as Plan's files are not. A file is deleted when no row names its hash. A turn whose picture has the
same hash as the one before it stores no new file.

**Where they show.** On the thread, each turn; in the task's drawer, before beside after. They are not sent
to the model, and they go to the pull request only when the project turns on Pictures in pull requests
(`decisions/2026-11-12-a-pass-pull-request-can-show-before-and-after-pictures.md`): they can show the builder's own data **(call)**.

**Size and time**, to be measured in the first pass: a 1440 × 900 PNG of an app screen is expected to be a few
hundred kilobytes, so a task that keeps before and after of two routes keeps about four pictures, and a
thousand such tasks a low number of gigabytes. A capture is one page load on a running dev server.

## 11. Data

All new IDs are branded and made in the ID module. Every row below has a zod schema in `packages/contracts`.
Until the first published release the migration baseline is regenerated, not extended (`packages/db/AGENTS.md`).

| Table or field | Holds |
|---|---|
| `passes` | `id`, `project_id`, `name`, `state` (`OPEN`, `CLOSING`, `CLOSED`, `SETTLED`, `ABANDONING`, `ABANDONED`), `batch_id`, `page_cap`, `return_branch`, `start_sha`, `shared_landed` (the chain number landed so far), `close_step`, `abandon_step`, `opened_at`, `closed_at`, `settled_at`. `CLOSED` means shipped and fast-forwarded; `SETTLED` means its work is in the base or the builder moved the branch (§5.3); a `local` project's pass goes straight to `SETTLED`. A partial unique index allows one row per project that is `OPEN`, `CLOSING` or `ABANDONING`. W9's wait reads every state before `SETTLED` and `ABANDONED`. |
| `passes.stacked_on` | the closed, unsettled pass this one was opened on, or null (§5.3, D24) |
| `pass_sign_offs` | a sign-off that is waiting: `task_id`, `waits_for` (a hold), `asked_at` (§9.2 step 0) |
| `batches.pass_id` | set on a pass's batch; what every rule of §5.5 reads |
| `pass_dirt` | the folder's dirt when the pass opened: `pass_id`, `path`, `blob` (the hash on disk, or absent for a deleted file). The content is held by the commit at `refs/10db/passes/<pass id>/dirt` |
| `pass_holds` | one row per shared grant: `claim_id`, `pass_id`, `task_id`, `seq` (its chain number, given at the grant), `closed_at`, `empty`; and per path the record taken at the grant: `path`, `blob`. The content is held by the commit at `refs/10db/passes/<pass id>/holds/<claim id>` |
| `pass_shared_changes` | one row per chain commit: `pass_id`, `seq`, `task_id`, `sha`, `paths`, `landed_sha`, `dropped_by` |
| `pass_take_outs` | `task_id`, `pass_id`, `step` (0 to 5 of §5.4), `tries`, `kept_sha`, `left` (files step 4 did not write) |
| `tasks.pass_id` | the pass a task is in, or null |
| `tasks.kept_work_sha`, `tasks.kept_base_sha` | a taken-out task's saved work and the commit it was kept on |
| `pass_turns` | `id`, `task_id`, `workstream_id`, `session_id`, `seq`, `message_id`, `started_at`, `ended_at`, `kept_sha`, `kept_base_sha`, `shared_seq` (the highest chain number granted when the turn ended, §7.2), `check` (`none`, `passed`, `failed`), `ready_at`, `opened_at` (when the builder first opened the ready page), `answered_at`. T and R of §4.5 are read from these. |
| `task_messages` | `id`, `task_id`, `author` (`builder`, `agent`, `system`), `kind` (`message`, `reply`, `notice`), `body`, `turn_id`, `created_at`, `pushed_at`, `delivered_at` (§6.3: a row pushed and not delivered is sent again) |
| `task_files` | a pasted picture: `id`, `task_id`, `message_id`, `name`, `media_type`, `size`, `sha256`, `stored_path`, `inline_sent`, `created_at` |
| `task_screens` | `id`, `task_id`, `turn_id`, `kind` (`before`, `turn`, `after`), `route`, `viewport`, `theme`, `sha256`, `size`, `width`, `height`, `stored_path`, `kept_sha`, `created_at`, `pruned_at` |
| `projects` | `app_url`, `dev_login_command`, `screens` (JSON: viewports, themes) |
| `projects.areas` | each area may carry `role` and `route` |
| `NextAction` | two new kinds: `feedback` (a builder message to act on) and `pass_review` (Ready in a pass, §6.1) |
| Files | `<data dir>/tasks/<task id>/files/` for pasted pictures, mode 0600; `<data dir>/screens/<2 hex>/<sha256>.png`; `<data dir>/browser/<project id>/state.json` for a project's storage state, mode 0600 |

New API routes, each with a contract: open a pass, add or take out a task, close; list a pass with its queue;
a task's thread; post a message (multipart, with files); stop and redo; sign off; open the pull request; a
picture by id. New events: pass opened, closed; turn started, ended; page ready; preview broken, mended.
Every new GET is classified in `screens/render-access.ts`, as that module requires.

## 12. Recovery

| The daemon dies | On restart |
|---|---|
| with a page Ready | the workstream is `WAITING_HUMAN` with `pass_review`; recovery's own branch for it keeps the live `check` item or raises it again with the pass's facts (§6.1); its warm session died with the daemon and is not restarted; the thread is rows |
| with a page Open | nothing to do: it is `QUEUED`, skipped by the scheduler, and its claim is still held (§2) |
| mid-turn | the session is resumed once, as after any crash (`apps/daemon/src/runner/next-action.ts:11-37`); `feedback` survives as `answer` does |
| mid-turn, and the session cannot be resumed | a fresh session from the digest and the latest handoff, with the builder's message (§6.3); the same after a move to another account |
| with a message pushed and not delivered | it is sent again to the resumed or fresh session; the page is not Ready until a turn after it ends. A Codex thread is read back first: a message pushed under a client uuid the thread took (`task_messages.push_uuids`) is delivered and not sent again (exactly once); a thread that can't be read starts a fresh session that is sent the message again, and the thread says so (at least once, as for Claude) |
| between a turn's end and its kept commit | the files are on disk; the kept commit is made at start-up for any turn with `ended_at` and no `kept_sha` |
| during sign-off | each commit's operation id finds what already landed; the rest are made, in order; the approval is applied if it was not |
| with a shared claim held for a turn | released with the turn's recovery; its changes are kept on the shared chain first if they differ from the record taken at the grant (`pass_holds` survives the restart) |
| during a take-out | continued from the step on its `pass_take_outs` row; step 4 hashes each file again, so a file written before the crash is not written twice and one the builder changed is left |
| while a pass is `CLOSING`, before the gate | the close starts again from its rows: take-outs, placements and kept shared changes are each idempotent |
| while a pass is `CLOSING`, after the push | the batch's own recovery covers the push and the pull request; the close continues from `close_step` |
| between two steps of D8's fast-forward | each step first checks whether it is already done (the branch already at the tip, HEAD already naming it), so the four run again in order and change nothing twice |
| while a pass is `ABANDONING` | continued from `abandon_step`: sessions are gone with the daemon; a drop or a take-out half done continues by its own row and hashes each file before writing it; the batch's move to `ABANDONED` is one write |
| after a close, before the pass is settled | the watch reads the pull request again; the card of §5.3 is raised once, by its fold key; W9's wait is read from the pass's state, so waiting tasks still wait |
| with a sign-off waiting on another page's hold | the `pass_sign_offs` row is found: the sign-off lands if the hold has closed, else it waits again |
| with a pass stacked on a closed one | both rows hold everything: `stacked_on`, each pass's `return_branch` and `start_sha`; the retarget and the merge into the stacked branch are each checked for "already done" first |
| with a check waiting or running | dropped; the next turn's end asks again |
| with the browser open | its processes are in a ledger in the temp root, reaped at start-up as lane processes are; a capture in flight is dropped and taken at the next turn |
| during a picture's write | files are written under a temporary name and renamed; a row is written after its file |

A warm session that dies with the daemon is not restarted: its task is Ready, and the next message resumes it.

## 13. Security

- **The thread's pictures** are checked by their magic bytes, stored outside every checkout, and readable by
  the task's own session only (the lane sandbox's read rules gain the task's files directory, as Plan's gain a
  conversation's).
- **A builder message is the builder's word**, typed in the app, carried over the UI token. It is not a
  permission: a tool call the message asks for is still judged by the guard and the broker.
- **The browser** loads only the project's app address, which must be a loopback host. A navigation or request
  to any other origin is refused. Routes the agent names are paths on that address, loaded with GET. The page
  is the project's own code, run with the session the builder's dev login gives: it can do in the dev backend
  what the builder's own browser can, and nothing on the Mac.
- **The storage state is a credential** for the dev app. It lives in the data directory, mode 0600, outside
  every path a lane or a gate can read.
- **The dev login command** is typed by the builder in Settings, as the gate command is, and runs under the
  gate's sandbox. For ampsio it needs Docker (§18).
- **Pictures stay on the Mac**: not in the pull request, not in a prompt.
- **Open Page** needs the desktop's opener capability widened, which is built for three `https` origins only
  (§2). A capability is a static file, so it cannot name one project's address: it gains `http` patterns for
  loopback hosts only (`localhost`, `127.0.0.1`, `[::1]` and names under `.localhost`, any port) **(call: which
  hosts)**. The window opens an address only when its origin equals the selected project's app address, checked
  in the one function that calls the opener. No other `http` origin is allowed. This is its own decision
  record (§19) and ships in slice 8.
- **The pass's branch** is written only by the daemon. A lane in a pass cannot write git state, as now.
- Nothing here runs a repository-controlled command outside a sandbox.

## 14. Components and build tasks

Each row is one pull request, in an order that leaves the app working after each.

| # | Slice | Touches |
|---|---|---|
| 0 | **Project readiness. Owner: the builder, per project; no code.** ampsio: turn its Docker switch on, name a frontend check as its changed-files check, push `build` so the base on `origin` holds it. 10db and orgtools: approve page areas once slice 1 can propose them. Every project: set the app address. Start Pass shows what is still missing (§4.2, built in slice 8) | project settings |
| 1 | Areas carry `role` and `route`; the proposer and Settings set them | contracts, db, daemon `folders/`, desktop settings |
| 2 | A task's thread: messages and pasted pictures, stored, with their routes | contracts, db, daemon `api` |
| 3 | Lane sessions take pictures and `interrupt()`; delivery marks; the `feedback` action; a fresh start from the digest when a session cannot be resumed | daemon `sessions/`, `runner/` |
| 4 | A pass and its batch: the rows, the batch rules of §5.5 (made by the pass, skipped by the scheduler and the ship trigger), the branch at HEAD, the dirt record, claims at open, the pass's lane count and warm sessions that yield, other folder work waits; the page-over-shared rule in the guard and the overlap refusals (§7.3). **No route opens a pass yet** | contracts, db, daemon `delivery/`, `scheduler/`, `placement/`, `guard/` |
| 5 | The pass turn: the runner's new mode (no `step_done`, no `verify`), `pass_review` with its recovery branch and the refusal of the built Approve and Send Back, the session kept warm and idled out, the handoff rules of §6.2, kept work, the rerouted `commit` tool, a new `check` item per Ready with its facts and the Inbox's folded row for it, the watcher's rules, hand edits, take-out and put-back, Abandon Pass. **The route that opens a pass ships here**, so no build can open a pass whose turns would run the built verify, and every pass that can be opened can be abandoned | daemon `runner/`, `recovery/`, `git/`, `mcp/`, `watcher/`, `api`, desktop inbox |
| 6 | Shared areas: held for a turn, the record and its content at a grant, the question, the shared chain, Drop, the notice to other threads; Abandon drops what has not landed | daemon `mcp/`, `runner/`, `git/`, db `claims` |
| 7 | Landing and closing: sign-off (the session stopped first, then the critical section), the chain's landing, Open Pull Request and the watch on an open pass (merged and closed only), the gate in a scratch worktree, the one review (D21), unowned edits, the order of a close, D8's fast-forward, the realignment and D22's card and wait, a pass stacked on a closed one (D24), the close that stops on confirm (D25), Move to a Separate Copy on a hazard request (§8.4), an ordinary start that puts kept work back | daemon `delivery/`, `git/`, `verify/`, `scheduler/`, `github/` |
| 8 | The Workbench view: the sidebar item, three ways in, Start Pass's lines, the queue, the thread, notifications, the opener capability and Open Page, the Factory line, the Inbox row, the timing line | desktop, desktop `src-tauri`, daemon `api` |
| 9 | Pictures: the pinned browser, the dev login, capture, storage, pruning, the broken-preview mark | daemon (new `pictures/`), `environment/`, contracts, db, desktop |
| 10 | The per-turn check as advice: one shared slot, coalesced per pass, offered with Send to Agent | daemon `runner/`, `verify/` |

Slice 1 is useful alone. Slices 2 to 4 add code whose first caller is slice 5; each is covered by its own tests
and changes nothing the builder can reach. The repo's rule is "no new test-only code": this is production
code that waits one to three pull requests for its caller, not a branch or an export a test alone uses, and
the plan must say so for each of the three and land 2 to 5 close together, or fold 2 to 4 into 5 if a
reviewer finds any piece with no production caller planned **(call)**. The second trigger of §8.4 (a preview
broken twice) ships with slice 9.

**For the plan.** Points a plan must settle that this spec leaves to it, each small:

- Which of the two ways of §4.3 a ready notification selects its page by: confirm whether the notification
  plugin reports a click on macOS before slice 8.
- Whether the pinned Claude Code advertises the interrupt receipt; if not, the fallback of §6.3 is the only
  path and the live test asserts that one.
- The three `builder_review` sites of §6.1, and a search for any other test of that name, in slice 5.
- Every rule keyed on an `OPEN` pass batch reading `OPEN` or `FAILED` (§5.4), in slices 4 and 7.
- The `gh` calls D24 needs (a pull request opened on another branch as its base; a retarget), added to the
  `Gh` interface with its fake, in slice 7.
- How each dev server's error overlay is recognised (§8.2), per framework, in slice 9.
- A value card per newly tested behaviour (§15), and the red-first run of each test. A pass can be opened through the API after slice 5 and left only by
Abandon Pass until slice 7; the builder first reaches one from the app in slice 8, when it can also close. 9
and 10 can follow the first usable pass. The plan may split 5 and 7 into two pull requests each; the order
above is the order they land.

## 15. Testing

By the cheapest rung that can fail for the regression (`.claude/rules/testing.md`). Claims, the guard, git,
recovery and the sandbox stay on the rung that exercises the real thing.

| Behaviour | Rung | The regression it catches |
|---|---|---|
| The queue's order; the timing line; N from T and R | pure | a stalled agent sorted below a ready page |
| `role` and `route` on an area; a pass refused with no page area | pure, plus one HTTP test | a project that can open a pass it cannot run |
| A message is delivered on evidence: pushed and not delivered is sent again after a restart; a message pushed as a turn ends holds the page out of Ready until the next turn ends | real SQLite and a restart, the fake adapter | a message lost in a crash, or a page that flaps to Ready and back |
| `feedback` adds no attempt and keeps the model; twelve rounds end Ready, with a low `handoffPct` so the rounds cross a handoff and the session after it starts from the handoff and the digest | the real pipeline (`createTestEngine`) | Send Back's rules leaking into a pass, or a handoff that loses what was said |
| The built Approve and Send Back are refused for a pass task; Sign Off stops the warm session, waits for it to end, then lands; recovery raises a pass's `check` again with the kept commit's facts | the real pipeline, a restart | a sign-off that throws on a warm session, or a Send Back that spends an attempt |
| A usage-limit move closes the warm session of a Ready page and sends it nothing; a working page is nudged and its turn continues; two handoffs with kept work between are not counted as stuck | the real pipeline | a turn nobody wrote, or a long turn stopped as a loop |
| A message's row id is its uuid; it is delivered when an assistant message lists it in `user_message_uuids`; one still queued after an interrupt stays undelivered; a session that ends without consuming one is queued again with it | the fake adapter emitting the SDK's frames, real SQLite | a message marked delivered that no turn took |
| A pass turn's end keeps the session, its sandbox and its row, never enters `verify`, and leaves `attempt` alone with uncommitted files in its claims | the real pipeline | a pass task that fails on its third turn, or loses its session every turn |
| The `commit` tool in a pass lane moves no branch: page paths reach the kept ref, shared paths the chain | a real git repo through the MCP handler | unsigned work on the pass's branch |
| A warm session takes a second message; an idle one is resumed; a handoff at `handoffPct` starts the next session from the handoff and the digest | the real pipeline, the injected clock | a session that never frees its lane, or two context rules racing |
| A session that cannot be resumed (a failed resume, another account, no id) starts fresh with the digest and the builder's message | pure table for `feedback` in `next-action`, one pipeline test | a builder message dropped with the session |
| A warm session gives up its lane to a waiting workstream of another project, and to a page of its own pass | the real pipeline, the injected clock | a pass starving the account |
| Each Ready raises a new `check` item and a message withdraws the live one; its facts come from the kept commit | real SQLite, one rendered Inbox test for the fold | no notification after the first turn, or a card listing no changes |
| The scheduler never launches an Open pass task; its claim holds across a restart with no session | real SQLite and a restart | a brief-less page that starts a session, or loses its page |
| The ship trigger never ships a pass's batch when its last page is signed off; start-up's check skips it | the delivery harness | a pass that ships itself |
| A picture reaches the session as a block, or as a path past the limit | pure for the choice, one adapter test | a request the API refuses for size |
| A turn's kept commit holds only the task's page files; the branch does not move | a real git repo | a neighbour's file in a task's work |
| Sign-off makes one commit of the task's files; a crash between commit and approval makes no second | a real git repo, a restart | two commits, or a signed-off page that never landed |
| A shared area is held for one turn, released at its end; the second task's question; Keep It to This Page | real SQLite for the claim, the real pipeline for the wiring | a claim held while a page sits Ready |
| A shared change holds only what changed during the hold: dirt recorded at the grant is left out; a file dirty before and changed in the hold is kept whole and said so | a real git repo | the builder's earlier edits committed under a task's name |
| The chain: two turn ends cannot extend one tip; sign-off lands the prefix the page needs, in order, then the page; a crash between two of those commits makes each once | a real git repo, a restart | a branch state the folder never had, or a shared change landed twice |
| Two tasks, one shared file, in sequence, signed off in either order: both edits on the branch, none reverted | a real git repo, table of orders | a lost edit, or an older version written over a newer one |
| Drop at a take-out is refused when a later change touches the path or the file changed on disk; Keep lands at close | a real git repo | a drop that discards another page's edit |
| A hand edit rides the task's next kept commit and is named to the agent; an unowned edit is listed at close; dirt from before the pass is marked as such | a real git repo | a builder's edit dropped at sign-off |
| A write to a Ready or Open page's files raises no foreign-claim card and no stray card while its pass is open, and does once the pass has closed | the watcher's rung: a real directory and real SQLite | cards for the builder's own edits, or the exemption outliving the pass |
| A pass opens on a dirty folder and closes with the dirt still there: nothing is refused, no file is written, the dirt is listed | the delivery harness, a real git repo | a pass that cannot close (the built ship's clean check) |
| Close fast-forwards the return branch by compare-and-swap and repoints HEAD; a return branch that moved leaves the folder on the pass's branch with one card; after a merge the ref realigns only when trees match | a real git repo | work vanishing from the screen at close, or a forced branch |
| Take-out, step by step, with a kill after each step: hand edits and untracked files are in the kept commit; a file changed after the check is left; put-back in a later pass merges or names the file | a real git repo, a restart per step | a take-out that loses a hand edit |
| Abandon Pass: unsigned pages' files return to their state before the pass, earlier dirt included; their work is at a ref and their tasks on the Board; signed-off commits stay; unlanded shared changes are dropped; a ship in flight is aborted; the batch is `ABANDONED` and a new pass can open. Killed after each step, it continues | a real git repo, the delivery harness, a restart per step | a stuck pass holding the next one, or an Abandon that loses a page's work |
| A page file is the page's under an overlapping shared area: the guard denies a write to an unheld page under a held shared claim; the path is in no hold's record and no shared change | the judge's pure table for the row, one test through the hook, a real git repo for the change | a shared hold writing another page's files and landing them as shared |
| Two page areas that overlap cannot both be saved as pages or both be in a pass | pure, plus one HTTP test | two tasks owning one file |
| Drop puts a file back to what it was at the grant, the builder's earlier edit included; a take-out puts a file back to its content before the pass | a real git repo | a drop or a take-out that discards the builder's own uncommitted edit |
| A sign-off waits for an open hold it needs and lands its change first | a real git repo, the real pipeline | a page landed without a shared change it was built on |
| A page with no changed file signs off with no commit; a hold that changed nothing makes no chain commit; a turn that changed nothing makes no kept commit | a real git repo | an empty commit, or a sign-off that fails on "nothing to commit" |
| After a close on a pull request project an ordinary folder task still waits, or runs in a copy, until the pass is settled; the Move card refuses on an overlapping uncommitted file and on a commit of the builder's own; a merge with matching trees settles with no file changed; a merge with drift, or after a CI fix, raises the card | the delivery harness, a real git repo, the fake `gh` | a shared cut that takes the pass's work off the screen |
| The watch on an open pass's pull request starts no Fix CI task when checks fail | the delivery harness, the fake `gh` | a fix batch cut under an open pass |
| A write outside every claim raises the stray card while a pass lane is working, and none while no lane is | the watcher's rung | an agent's shell write hidden as the builder's edit |
| Pass lanes count against the daemon-wide cap; a warm session yields to it | the real pipeline | a fifth lane past the cap |
| Kills: with a page Ready (the item is kept or raised again); mid-turn with a session that can be resumed (resumed once, the message not repeated as a second turn); between a turn's end and its kept commit (made at start-up); with a shared hold open (kept on the chain, then released); between each two steps of D8's fast-forward | the real pipeline or the delivery harness, a restart each | each row of §12 that had no test |
| The opener capability names `http` only for loopback hosts | a repo test over `capabilities/default.json` | a capability widened to any `http` origin |
| A restart after a close and before the pass settles: the waiting ordinary task still waits, the Move card is not raised twice, and the realignment still runs when the merge is reported | the delivery harness, a restart, the fake `gh` | folder work let loose by a restart, or two cards |
| A taken-out task's workstream is cancelled and nothing launches it; an ordinary Board start puts its kept work back first and names a file that did not apply; Discard Saved Work deletes the ref | real SQLite for the scheduler, a real git repo for the put-back | a taken-out page that starts a session by itself, or kept work silently dropped |
| A pass opens on a closed, unsettled pass: its pull request's base is the first pass's branch; the first pass's Move card is withdrawn; when the first merges the second is retargeted and, with matching trees, takes the base by a merge commit that changes no file; closing the second moves the return branch from the first tip to the second | the delivery harness, a real git repo, the fake `gh` | a stacked pass whose close fails its compare-and-swap, or a pull request showing another pass's work |
| Close Pass… stops nothing when it opens; on confirm it stops the agents and closes only if the lists are unchanged, else shows them again; a stopped turn raises no `check` item and no notification | the real pipeline, one rendered test for the modal | a Cancel that cost six turns, or a Ready page made of half a turn |
| Inside a close and an Abandon a page whose files keep changing does not stop either: after three tries the files are left and named on the card | a real git repo with a writer racing the take-out | a pass stuck in `ABANDONING` or `CLOSING` for good |
| A file under a hazard the task holds is in its kept work and its sign-off commit; a held hazard does not allow a write to an unheld page it also matches | a real git repo; the judge's pure table and one test through the hook | a lockfile change that never lands, or a hazard used to write another page |
| Shared changes land in number order when two areas' holds end in the other order | a real git repo | a change landed ahead of one it follows |
| A sign-off waiting on a hold survives a restart; when that hold's task waits for a claim of the signing page, its `request_claim` is refused at once and the sign-off lands | real SQLite and a restart, the real pipeline | a sign-off lost in a restart, or two pages waiting on each other |
| A pass turn that leaves a command running goes Ready at once; the command's end is a notice and starts no turn | the real pipeline | a page held out of Ready for 15 minutes by a watcher |
| On a `local` project the watch starts no Fix CI task for a pass's pull request, before or after the close | the delivery harness, the fake `gh` | a fix batch cut for a project with no copies |
| A pass on a `local` project makes its batch, a branch and a pull request; with no `origin` it closes by the fast-forward alone; an ordinary folder task waits with a notice | the delivery harness | W8 or W9 undone |
| The pull request watch sees a pass's pull request merge while the pass is open | the delivery harness, the fake `gh` | a merged pass that keeps taking sign-offs |
| The gate for a pass runs in a scratch worktree and never sees an open page's files | the delivery harness, a real git repo | §2's first fact coming back |
| A per-turn check goes through the one gate slot; a pass has one waiting and one running, the latest replacing the waiting one; a failure is a notice with Send to Agent and starts no turn | pure for the coalescing, one pipeline test | four checks at once, or the daemon messaging an agent by itself |
| A failure's notice reaches the thread whose claim holds an exactly matching path, and always the header | pure | a task told to fix a neighbour's error with nothing in the header |
| `CLOSING` killed before the gate and after the push | the delivery harness, a restart | a pass half closed for good |
| The window opens only the selected project's app address; another loopback address, or an `https` one, is refused | pure for the check, one rendered test | Open Page as a way to open any local URL |
| The browser refuses another origin; the storage state is unreadable from a lane | the sandbox's own rung | a lane reading the dev credential |
| A capture is stored once per hash; pruning keeps before and after | real SQLite and a temp directory | pictures that grow without bound |
| After a kill: the browser's processes in the ledger are reaped at start-up; a picture half written leaves no row; a waiting check is dropped | a real temp directory, real SQLite, a restart | a browser left running, or a row naming a file that is not there |
| The Workbench renders a queue and a thread; Send, Stop and Redo, Sign Off call their routes | rendered components | a button wired to the wrong task |
| One e2e: open a pass on two pages with the fake adapter, send a message with a picture, see Ready, sign off | Playwright | the parts not working together |
| The Workbench at a narrow and a wide width, dark and light, with a pass open: axe clean; the live region announces ready, question and failure and nothing else | Playwright (the e2e axe run) | an unlabelled queue, or a live region that chatters |

The pinned browser is exercised by one test that is not in `make gate`, as the live Claude test is not; the
capture code is tested against a boundary that hands back bytes.

Every row of §12 has a row above: Ready and Open pages, a mid-turn crash, a session that cannot be resumed, an
undelivered message, the kept commit, sign-off, a shared hold, a take-out, both halves of `CLOSING`, and
pictures.

**Value cards** are not written here. Each newly tested behaviour above gets its one card
(`protects`, `fails_when`, `why_new`, `no_claim`) in the plan and in the commit that adds the test, as
`.claude/rules/testing.md` requires; the third column above is each card's `fails_when`. Each test is seen red
first, before the code that makes it pass.

## 16. Assessment

Run by the builder on real projects, in three stages: **P** once slices 0 to 8 exist, **S** after slice 9
(pictures), **K** after slice 10 (the check). A scenario names the stage it can first pass in. Each ampsio
scenario assumes slice 0 is done there; P1 fails, by design, if it is not.

| # | Project | Scenario | Pass |
|---|---|---|---|
| P1 | ampsio | open a pass on 4 pages from the Workbench, writing no brief, with the folder as dirty as it usually is | three clicks; Start Pass names the files already changed; each page takes a first message; no stray card and no foreign-claim card; the builder opens no terminal |
| P2 | ampsio | 30 minutes of work with turns of about 10 minutes | the builder waits on agents less than 20% of the time; no page is Ready for more than 5 minutes unnoticed; one notification per ready page, on the fifth turn as on the first |
| P3 | ampsio | a one-line spacing change, 10 times on a warm session and 5 times after 15 idle minutes | warm: on screen within 30 seconds at the median; after idle: within 60 seconds at the median, with the thread intact |
| P4 | ampsio | two pages need the same file in `src/` | the second task's question appears in the queue and the Inbox; after Allow it has the file within one turn; sign the second page off first: both edits are on the branch, the first page's change landed with it and its thread says so |
| P5 | 10db | a pass task's agent asks for the `deps` hazard (the brief: "add a date library to this view") | the Move to a Separate Copy card appears before any manifest or lockfile changes (slice 7 builds it); after Move, the page's files are back, the task is queued as a separate-copy task with the thread as its brief, and the pass closes without it. On ampsio (`local`, no copies) the bar is instead: the hazard is granted as today and the row says the page will be slow |
| P6 | 10db | page A mid-turn with a type error on disk; page B signed off; Open Pull Request | the gate runs in a scratch worktree and passes or fails on B's commit alone; one review reads B's diff |
| P7 | any | 12 rounds on one page, two with pasted screenshots, two hand edits: one while the page is Ready, one mid-turn | no retry limit, no model change; no card for either hand edit; both are in the landed commit and the agent was told of the first; the thread survives a daemon restart |
| P8 | 10db | 3 views against `pnpm dev:factory`, entered from a goal | as P1, each thread opening with its route and Open Page; the pass survives the app updating and restarting itself. The goal's kept pictures at the top of each thread are checked in stage S, once slice 9 exists |
| P9 | orgtools | the area proposal, then a pass on 3 pages | one page area per route, approved on one screen; then as P1 |
| P10 | ampsio | close a pass with one page unfinished, one stray hand edit and the folder still dirty from before | the close is not refused; the unfinished task is on the Board with its thread and kept work, hand edits included; the edit is listed; the pull request holds signed-off pages only; **the browser shows every signed-off page after the close, with no reload to the old UI**; `build` points at the pass's tip |
| P11 | 10db | close a pass; start an ordinary folder task before the merge; then merge by squash, twice: once with nothing else merged first, once after another pull request reached the base | before the merge the ordinary task waits with "Waits for the Workbench pass's pull request to merge", or runs in a copy. Nothing else merged: within one watch round the folder's branch is at the base on `origin`, no file changed on disk, no duplicate commits, and the waiting task starts. Something else merged first: the card Move `main` to `origin/main` appears instead; clicking it moves the folder, or names the file in the way |
| P12 | any | kill the daemon three times in one pass: mid-turn, during a sign-off, during a close | each time the pass resumes where it was: no message lost or sent twice as two turns, no commit made twice, no page stuck, no process left running |
| P13 | ampsio | commit an unrelated file by hand on the pass's branch (`git commit -- <path>`), then at once sign a page off; and once more with a bare `git commit` after a sign-off | the sign-off lands on top of the hand-made commit (a turn's end moves no branch, so the sign-off is where the two can meet); the hand-made commit is listed at close; after the bare commit no landed file has gone back to old content |
| P14 | any | one page working and two Ready with warm sessions when the account hits its usage limit and the project moves to its fallback account | the working page hands off and its turn continues on the fallback account from the handoff and the thread, its row orange only while it is paused; the two Ready pages stay Ready, receive nothing and start no turn; the next message to each starts a fresh session there and is acted on once |
| P15 | 10db | an ordinary Your-folder task is started while a pass is open | it runs in a separate copy; on ampsio it waits with "Waits for the Workbench pass to close" and starts when the pass closes |
| P16 | any | send a message to a page signed off ten minutes ago | it reopens, takes the page again, and its next sign-off lands a second commit |
| P17 | ampsio | a close whose gate fails; then Abandon Pass with one page signed off and two not | the pass is open again with the gate's card. The confirm names the two pages that revert and the one that stays; afterwards the two pages look as they did before the pass, earlier uncommitted edits included, their tasks are on the Board with their threads and kept work; the signed-off page is still on screen and on the pass's branch; one card says where the folder is; a new pass can open |
| P18 | a project whose shared area's globs cover a page's directory (set up for the test) | a task holding the shared area tries to write another page's file | the write is denied with the page named; the shared change holds no page file |
| P19 | 10db | close a pass; before its pull request merges, open a second pass on two more views, sign one off, open its pull request; then merge the first | the second opens with no refusal and the first's work still on screen; its pull request shows only its own page; no Move card for the first while the second is open; after the first merges the second's pull request targets `main` and still shows only its own page; closing the second leaves `main` at its tip |
| P20 | any | Close Pass… with two pages working: Cancel once, then confirm | Cancel stops nothing and both turns finish; on confirm both agents stop, neither page goes Ready or notifies, and the close goes on, or shows the lists again if a stopped turn changed them |
| P21 | any | take a page out, wait five minutes, then start its task from the Board | nothing starts by itself in the five minutes; the start puts the saved work back and the session's brief has the thread |
| S1 | ampsio | an ordinary Your-folder UI task, no pass | before and after of its route in the task's drawer, signed in, with no step by the builder |
| S2 | any | 10 turns, 3 of which change nothing visible | at most 7 turn pictures stored; 14 days after done, before and after remain |
| S3 | ampsio | a task writes a compile error into shared code | within one turn the queue shows "Preview broken by" that task with Send to Agent; nothing reaches its session until the builder clicks; no other task's `attempt` moves; the builder restarts nothing |
| K1 | ampsio | the same compile error, with a changed-files check set | the failure is a notice in the pass header and on that task's thread with Send to Agent; with four pages ending turns together, one check runs at a time |

Measured in every pass and kept with it: T and R per turn; the share of time the builder waited; Send to first
edit; turns per page to sign-off; shared-code questions and how long each claim was waited for; minutes the
preview was broken and whether the right task was named; gate failures caused by an open page's files (must
be 0); the memory of each warm session; seconds and bytes per picture.

## 17. Later phases

Not designed here. Each needs its own spec; these are the decisions it must make.

**Phase 2: screenshots for tasks in separate copies.** A copy has nothing running, so its pictures need the
copy to run, at least briefly. Until then such a task's "before" can be the last kept picture of the route
from the base. Decisions: whether the copy is started for a picture alone; what stands in for "before".

**Phase 3: a copy can run.**

- **What a project declares:** a committed `.10db/preview.json` (W20), read at the boundary, proposed by a
  model, approved by the builder on a card, and read from the base on `origin`, never a working tree, as the
  Docker switch is (`decisions/2026-11-08-a-project-turns-docker-on-for-its-gate-and-lanes.md`). Guessing is
  wrong for ampsio: its `package.json` says `next dev`, its rules forbid host tools, and its front door is not
  Next's port. Decision: whether §10's three settings move into this file.
- **Frontend only, against the shared backend,** by default. A second full ampsio stack does not fit on this
  Mac today: Docker's memory and disk are nearly used by one. Measured there, the Next dev server is the larger
  part of the stack, so even a frontend-only copy is costly, and at most one would run at a time, stopped when
  idle. No ampsio copies until that is measured (W20). 10db is first: `pnpm dev:factory` already serves a
  checkout's UI over the installed daemon.
- **Ports or hostnames:** a browser does not separate cookies by port, so a frontend-only copy on another
  port is already signed in, while a copy on its own hostname needs its own sign-in and, for ampsio, its own
  OAuth redirect and issuer. Ports for frontend-only copies; hostnames (`task-123.ampsio.localhost`) when full
  copies come. Decisions: a per-copy proxy in the daemon that sends API paths to the shared backend with an
  origin it trusts; the daemon accepting more than one dev UI origin
  (`decisions/2026-10-29-dev-ui-over-the-factory.md`).
- **Who runs it:** the daemon, in a module of its own, never a lane, whose processes end with its session
  (`decisions/2026-10-30-stop-what-a-lane-session-started.md`). Decisions: the process group, the sandbox
  profile with local binding, a ledger for start-up reaping, readiness by polling a declared path, idle stop.
- **Env files:** not seeded into a worktree today (`docs/open-items.md`). Decision: a declared list, copied
  and recorded so removal can tell 10db's copy from a hand-made file.
- **What it reverses:** the worktree-mode spec's non-goal "port allocation per worktree"
  (`2026-10-27-10db-worktree-mode-design.md` §1), and "Docker or database duplication per worktree" only if
  full copies come. Its anti-goal stands: nothing the repository controls runs outside the sandbox.

**Phase 4: live links.** "Open preview" on a separate-copy task: Phase 3 plus a button and a cap on running
copies. The thread of §6 serves a copy's task unchanged.

**Later, any phase:** the capture button in the app under test; a tool that shows the agent its own page;
undoing a turn from its kept commit; Features.

## 18. Findings outside this design

Read while designing. None is fixed here; each bears on it.

- **The repo lock is in the daemon's memory.** It orders the daemon's own git calls
  (`apps/daemon/src/git/git.ts:844-861`). A `git` the builder types in the folder at the same moment is caught
  by the compare-and-swap, not the lock. In a pass the builder is in the folder, so this is more likely than
  before; the commit is refused as `raced` and retried.
- **The folder's own index can be left stale.** After a commit the daemon updates it for the named paths, and
  "Another git holding index.lock just leaves it stale" (`git.ts:2199-2204`). A bare `git commit` typed by hand
  would then write old content back. The switch back already refuses a stale index
  (`docs/architecture/02-batch-delivery.md:51`); §9.2 step 4 adds the check at each sign-off.
- **A hand-made commit on the pass's branch** is in the pull request. Closing lists commits the daemon did
  not make, with the unowned edits.
- **ampsio's Docker switch read off** in the live settings on 2026-11-09, while its gate and its dev login both
  run `docker compose exec`. Until it is on, ampsio's gate cannot pass in 10db and §10 cannot sign in.
- **ampsio's registered gate checks no frontend code** (it is the backend's gate). A pass of UI work there is
  checked by nothing until the project has a frontend check as its changed-files check or in its gate.
- **ampsio's gate tests its one running stack,** which holds the folder's files, so it cannot test a commit by
  itself. A pass there gates in the folder at close, and its pull request says so (§8.3).
- These three, and `build` being ahead of `origin`, are slice 0 of §14: the builder's to settle per project,
  with Start Pass showing what is missing. They are prerequisites of §16's ampsio scenarios, not defects of
  the design.
- **ampsio's rules expect other sessions in the same folder on `build`.** Opening a pass moves the folder to
  the pass's branch; a session outside 10db that commits there commits to the pass.
- **10db and orgtools have one area each,** so until §7.1's roles exist, two folder tasks there cannot run
  together at all.

## 19. Decision records to write

One file each under `docs/architecture/decisions/`, in the pull request that builds the slice.

| Record | Amends or sits beside |
|---|---|
| The Workbench is a project view; a pass is Your folder with a look-and-reply loop | the scope decision this spec depends on; the task-placement spec |
| A task has a thread, and the builder signs it off: the `feedback` action is outside the fix limit | `decisions/2026-10-28-optional-gate.md` |
| A pass task's session stays open between turns, then resumes; lane sessions take pictures; the end of a turn is not the end of a step; a full context hands off as any lane does, and a session that cannot be resumed starts from the thread's digest | the Plan session's rules; `decisions/2026-11-08-a-handoff-that-names-work-left-stands.md` |
| A builder message is delivered when the SDK lists its uuid as consumed (`user_message_uuids`), a page is not Ready while one is on its way, and a session that ends without consuming one is queued again with it | the Plan session's rules |
| A pass gates what its pull request holds, in a scratch worktree, never per turn; the per-turn check shares the one gate slot, coalesced per pass | `decisions/2026-10-29-gate-with-base.md`; `decisions/2026-10-28-gate-slots.md` |
| **D17:** a shared area is held for one turn and a later task asks the builder; a shared change is kept on the pass's shared chain, with a record of the area's dirt taken at the grant, and lands with its page's sign-off, in chain order; a take-out keeps or drops it | `decisions/2026-10-29-per-copy-hazards-and-waiting-claims.md` |
| **D19:** a failed check, a broken preview and a review finding are offered with Send to Agent and never sent by themselves; every turn starts from a row the builder wrote | `decisions/2026-10-31-notices-not-cards.md` |
| **D21:** a pass runs no plan step, no review step and no gate per turn, on any project; one model review reads the pull request's diff when it opens | `decisions/2026-10-28-optional-gate.md`; the project's flow |
| An area is a page or shared, and a page may name its route; an area with no role is a page in a pass | `decisions/2026-10-29-propose-areas-from-the-repository.md` |
| A pass has a batch of its own kind, whatever the project's delivery: made by the pass, at the folder's HEAD with the dirt recorded, skipped by the scheduler until spoken to and by the ship trigger, shipped with no clean-checkout check, watched from its first pull request; it counts its own lanes and its warm sessions yield | the batch-delivery spec; `decisions/2026-10-29-workspace-per-task.md` |
| **D8:** at close the folder's branch fast-forwards to the pass's tip by compare-and-swap and the folder returns to it, so the work stays on screen; the built switch-back is not used for a pass; after a squash merge the branch realigns when the trees match; on a `local` project the fast-forward is the landing and the pull request a record | `decisions/2026-10-29-shared-checkout-switch-back.md` |
| **D22:** on a pull request project a closed pass is not settled until its work is in the base: ordinary folder work keeps waiting or uses a copy; one card, Move `<branch>` to `origin/<base>`, uses the built switch and refuses on overlap or on a commit of the builder's own; a merge with matching trees settles by itself, drift or a CI fix ends at the card; an open pass's pull request is watched for merged and closed only | `decisions/2026-10-29-shared-checkout-switch-back.md`; the batch-delivery spec's fix path |
| **D23:** Abandon Pass puts unsigned pages back to their state before the pass, keeps their work with their tasks, leaves signed-off pages as landed, and says which is which first; its own recorded sequence, not the built Abandon; it always finishes; where the folder ends | the batch-delivery spec's Abandon |
| **D24:** a pass may open on a closed, unsettled pass and stack on it: the same return branch, its start at the closed pass's tip, its pull request based on the closed pass's branch and retargeted when that merges; the closed pass's Move card and realignment wait; a `local` project just continues | `decisions/2026-10-29-shared-checkout-switch-back.md`; the batch-delivery spec |
| **D25:** Close Pass… stops nothing when it opens; on confirm the agents are stopped and the lists worked out again; a stopped turn's work is kept but it never makes a page Ready or notifies | the Workbench's own records |
| A taken-out task's workstream is cancelled; its kept work is put back by the next start, in a pass or from the Board, or discarded by the builder; a hazard's files ride the kept work of the task that holds it | the task-placement spec; `decisions/2026-10-29-per-copy-hazards-and-waiting-claims.md` |
| In a pass a file under a page area is the page's alone, even when a shared area also matches it: the guard, the hold's record and the shared change all follow that; two page areas may not overlap | the guard's judge; `decisions/2026-10-29-per-copy-hazards-and-waiting-claims.md` |
| A turn's work is kept at a ref; sign-off lands one commit; a take-out stops the session, keeps the work and puts the page back to what it was without the task, in six recorded steps | `decisions/2026-10-29-shared-checkout-switch-back.md` |
| The builder's hand edits ride the owning task; unowned edits are listed at close; the watcher raises no foreign-claim or stray card for a page of an open pass | the watcher's stray and foreign-claim rules |
| A ready page is a new `check` item each time, withdrawn by a message, folded per pass in the Inbox; Ready in a pass is `pass_review`, with a session still attached, and the built Approve and Send Back are refused for it | `decisions/2026-11-08-the-inbox-holds-what-needs-the-builder.md`; `decisions/2026-10-28-optional-gate.md` |
| **D18:** the desktop's opener may open `http` on loopback hosts, and the window opens only the selected project's app address; Open Page opens once, then copies the link | the opener capability's own description (`apps/desktop/src-tauri/capabilities/default.json`) |
| A pass runs on the project's account, Claude or Codex: a Codex turn is seen to take a message by its client uuid, pictures go as local images, an interrupt answers what 10db still holds, and a restart reads the thread back | `decisions/2026-11-11-a-pass-runs-on-the-projects-account-claude-or-codex.md` |
| Task pictures come from a daemon-owned pinned Chromium, signed in by a dev login, and stay on the Mac | `decisions/2026-11-03-plan-sees-the-app-through-screenshots-not-a-browser.md`; `decisions/2026-11-08-10db-runs-pinned-copies-of-codex-and-claude-code.md` |

## 20. Calls to review

Made here without the builder. Each has the alternative that was turned down.

1. **Sidebar order** (§4.1): Board, Plan, Workbench. Decided by the builder (design review D20).
2. **The branch starts at the folder's HEAD and moves no file** (§5.1). Otherwise from the base with a clean
   folder, as a shared cut does today; ampsio's folder is rarely clean. The review found this could not close
   (B1); it now can, because the dirt is recorded at open and a close neither checks for a clean folder nor
   writes a file (§5.4, §5.5).
3. **A pass opens even when HEAD is ahead of the base on `origin`** (§5.1), and says so. Otherwise it refuses.
   The consequence, stated at Start Pass and at Open Pull Request: the pull request lists those commits until
   the builder pushes them; on a `local` project it is a review record anyway (D8).
4. **A turn's page work is kept at a ref and lands at sign-off** (§9). A shared change lands with its page
   (decided by the builder, design review D17, §7.2).
   Otherwise every turn commits on a work branch and sign-off replays it onto a second branch: more git, and a
   rule for conflicts between replays.
5. ~~After a close the folder returns to where it was.~~ Decided by the builder (design review D8): the folder's
   branch fast-forwards to the pass's tip, so the work stays on screen (§5.4).
6. **A pull request that merges early closes the pass** (§5.4).
7. **The gate for a pass runs in a scratch worktree where the project allows copies** (§8.3); a `local`
   project gates in the folder at close and opens its early pull request as an ungated draft. The consequence:
   a `local` project's gate tests the folder and its running stack, not the pushed commit, and the pull
   request says so.
8. ~~The per-turn check has a slot of its own.~~ Withdrawn: it broke the one-runner rule. The check shares the
   gate slot and is coalesced per pass (§8.1).
9. **A broken preview is read from the page load that takes the picture** (§8.2), so it needs slice 9. Before
   that, only the builder's own word says so; the scenario that tests it is S3, not a P scenario.
10. **The sign-off commit's message** (§9.2): the task's title and the turns' first lines. A project with a
    commit convention may need the subject shaped to it; the pull request's title is what a squash keeps.
11. **Pictures are not sent to the model, and go to the pull request only when the project opts in** (§10).
12. **The app address, the dev login and the matrix are project settings** (§10), as the gate command is.
    Phase 3 may move them into `.10db/preview.json`.
13. **A fifth and sixth page run inside the account's lane limit** (§5.2); the limit is not raised by a pass.

Made in the engineering revision, where the review found the spec silent:

14. **Files already changed in a ticked page's area join that page's work, and Start Pass says so first**
    (§4.2, §6.4). Otherwise the pass refuses to start on a dirty page, or leaves the files out, which cannot be
    kept apart once the agent edits the same file. The consequence: those edits are then in two places if the
    page is taken out, on disk again as they were (§5.4 step 4) and inside the task's kept work.
15. **A file that was dirty before a shared hold and that the agent also changed is kept whole,** with a line
    saying so (§7.2). A file cannot be split; the alternative is to refuse a shared grant while the area is
    dirty.
16. **A file changed in a page outside its turns while another page's agent was working is not called the
    builder's** (§6.4); the thread says which lane was working. Sign Off still asks nothing (D11).
17. **A gate that fails at close reopens the pass, and the fast-forward waits for a passing gate** (§5.4).
    Otherwise the folder's branch would move to work that has not passed. The consequence differs by project:
    where the gate runs in a scratch worktree it runs before any take-out, so a failure reopens the pass as
    it was; where it runs in the folder (a `local` project) the take-outs come first, so a failure reopens
    the pass with those pages already out, and the close modal says so.
18. ~~Abandon Pass changes no file.~~ Decided by the builder (D23): it puts unsigned pages back and keeps their
    work with their tasks (§5.4).
19. **A project with no `origin` or no `gh` can still close a pass**, by the fast-forward alone (§5.5).
20. **Warm sessions yield their lane** to a waiting workstream of any project, and to a page of their own pass
    (§5.2). Otherwise four warm pages hold the account's default limit, and the daemon-wide cap of 4 lanes,
    which a pass's lanes also count against.
21. ~~Delivery is marked when the session echoes a message.~~ Withdrawn: an echo is receipt, not consumption.
    Delivery is read from `user_message_uuids` (§6.3), asserted by the live test.
22. **A check's failure is matched to a task by exact path only, and always shown in the header** (§8.1).
    Otherwise it parses each tool's output, which is fragile.
23. **The opener allows `http` on loopback hosts** (§13); the window, not the capability, holds it to the
    project's address, because a capability is a static file.
24. **Turn pictures are pruned 14 days after the task is done** (§10).
25. **Start Pass shows what the project lacks** (§4.2), two or three dimmed lines the design review did not
    see.

Made in the second engineering revision:

26. **If a notification's click cannot be read, focus within 10 seconds of a ready notification selects its
    page** (§4.3), keeping D12's intent; of two shown in that time the later wins. The 10 seconds is a guess.
27. **Where the folder ends after an Abandon** (§5.4) is decided by whether the pass's branch is still at
    `start_sha`: if so the folder returns to the return branch; if anything landed it stays on the pass's
    branch, with one card offering a merge command or a move back. A pass opened from there records that
    branch as its return branch. Otherwise an Abandon fast-forwards the return branch to work no gate has
    passed, or moves back and takes landed pages off the screen.
28. **An Abandon after the push leaves the pull request as it is** (§5.4), and 10db stops watching it, since
    an abandoned batch is not watched. Otherwise 10db closes a pull request the builder may still want.
29. **The Move card refuses when the branch holds a commit that is neither on the base nor on the pass's
    pushed branch** (§5.3), beside the overlap refusal D22 named. Otherwise the move drops the builder's own
    commit from the branch.
30. **Slices 2 to 4 land close to slice 5, or fold into it** (§14), so `main` does not hold code whose only
    caller is a test for long.
31. **Two page areas may not overlap; a page may overlap a shared area** (§7.3), and Start Pass says which
    side such a file is on.
32. **A take-out the builder asks for by itself gives up after three tries** when its files keep changing,
    and leaves the task in the pass (§5.4). Inside a close or an Abandon it does not give up: the files are
    left as they are and named, so both always finish. The three is a guess.

Made in the third revision:

33. **An ordinary Board start of a taken-out task puts its kept work back first** (§5.4), and the drawer
    offers Discard Saved Work. Otherwise the work waits for a pass, or is dropped without a word.
34. **When a stacked pass's base pass merges with matching trees, 10db brings the base into the stacked
    branch by a merge commit that changes no file** (§5.3), so its pull request keeps showing its own work.
    Otherwise it only retargets and the pull request lists both passes' commits.
35. **When the pass a stacked pass was built on closes unmerged, the builder is offered Retarget** (§5.3);
    nothing is retargeted by itself.
36. **A pass turn is never held open for a command it left running, and that command's end starts no turn**
    (§6.2). Otherwise a watcher keeps a page out of Ready for 15 minutes.
37. **A sign-off that would deadlock with a `request_claim` refuses the claim** (§9.2), not the sign-off.

**Where the third check's findings went.** M1: §5.4 step 5 and "What an ordinary start does". M2: D24, in
§5.3, §11, §12. M3: §5.4 step 3 and "An Abandon always finishes". M4: D25, in §5.4. M5: §7.1, §7.3 rule 2,
§9.1. The two revision defects: §7.2 (ordered by number), §9.2 step 0 (a row, and the refused claim). Calls
26, 27, 28 and 32 as above. Minors: a §6.1; b, c §6.3; d §5.4; e §9.1, §11; f §9.2 step 5; g §5.4's modal;
h §18; i §6.2; j §5.5. The missing restart test: §15. Points left to the plan: the end of §14.

**Where the plan review's findings went.** B1: §5.1 step 4, §5.4, §5.5, tests and P1, P10, P17. B2: D8, with
its mechanics in §5.4. B3: D17, with its mechanics in §7.2. M1: §6.4, P7. M2: §5.4's take-out steps, §12. M3: §6.2,
§6.3 (the handoff), §7.1 (areas with no role). M4: §6.3, §12, P14. M5: §6.2 step 1, §6.3, §6.1 (D19's
invariant). M6: §8.1, slice 0. M7: §5.5, §5.1 step 6. M8: §6.1, §9. M9: §13, §19, slice 8. Minor notes: §5.2
(lanes), §14 (order), §15 (rows and value cards), §16 (stages and eleven new or moved scenarios).

**Where the second plan review's findings went.** B-new-1: §7.3, §4.2, P18 (ampsio's live areas do not overlap
today). M-1: §6.1 (`pass_review`), §9.2 step 0. M-2: §6.2. M-3: §6.3 (`user_message_uuids`). M-4: D22, in
§5.3 and §5.4. M-5: §5.5. M-6: D23, in §5.4, §12. M-7: §5.4 (step 0, the order of a close, three tries).
M-8: §5.1 step 4, §7.2, §5.4 step 4. M-9: §7.2, §9.2 step 0. M-10: §8.4, slices 7 and 9. M-11: success
criterion 5, §15. Minors: m1 §4.3; m2 §5.2; m3 §7.2, §9.1, §9.2; m4 §5.1; m5 §6.2; m6 §6.1, slice 5; m7 P13;
m8 P8; m9 §5.5, §9.1; m10 §6.4; m11 the summary below. Tests: §15's last rows. Scenarios: P5, P11, P13, P14
rewritten, P17 for D23, P18 added.

## Design Review Completion Summary

`/plan-design-review` on 2026-11-09, against `DESIGN.md`, decisions D1 to D21 asked one at a time (D1 and D2
chose the review's focus; D3 to D21 are design decisions, applied above where each cites its number). No
mockups: the designer had no image key, so the review ran text-only with ASCII sketches. Three independent plan
reviews on Fable 5.2 found engineering blockers that are not design decisions; all are folded into the spec
above (see Unresolved Decisions), and the builder settled four of their points as D22 to D25.

```
  +====================================================================+
  |         DESIGN PLAN REVIEW — COMPLETION SUMMARY                    |
  +====================================================================+
  | System Audit         | DESIGN.md present; new project view + 3 entries |
  | Step 0               | 5/10; focus: all 7, layout first            |
  | Pass 1  (Info Arch)  | 4/10 → 8/10 after fixes (D3, D4)            |
  | Pass 2  (States)     | 3/10 → 9/10 after fixes (D5–D10)            |
  | Pass 3  (Journey)    | 5/10 → 8/10 after fixes (storyboard, D11, D12) |
  | Pass 4  (AI Slop)    | 8/10 → 8/10 (no issues; Operate mode)       |
  | Pass 5  (Design Sys) | 6/10 → 9/10 after fixes (D13–D15)           |
  | Pass 6  (Responsive) | 4/10 → 8/10 after fixes (D3, D16)           |
  | Pass 7  (Decisions)  | 5 resolved (D17–D21), 0 deferred            |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (6 items)                           |
  | What already exists  | written                                     |
  | TODOS.md updates     | 0 items proposed (no TODOS.md; none deferred) |
  | Approved Mockups     | 0 generated, 0 approved (no image key)      |
  | Decisions made       | 19 added to plan                            |
  | Decisions deferred   | 0                                           |
  | Overall design score | 3/10 → 8/10                                 |
  +====================================================================+
```

**NOT in scope (design):** an embedded view of the app (W3); the in-app capture button (a later task); tab reuse
in the browser (D18 chose open once, then Copy Link; tab reuse belongs to the capture extension); a phone layout
(a desktop app; the narrow layout of D3 starts at about 420 px); mockup images (no image key); Phase 2+ screens
(§17).

**What already exists, to reuse:** `DESIGN.md`'s status colors, Factory's list rows, the form modal, Title Case
copy and one filled primary per group; Plan's composer with picture paste and byte checks
(`apps/daemon/src/shape/dropped-files.ts`); `failureLine` (`apps/desktop/src/views/board/task-state.ts`);
`notifyNewCard` and `openUrl` (`apps/desktop/src/desktop/tauri.ts`); the e2e axe run.

**Implementation tasks from this review** (all in slice 8 unless named; human / CC effort):

- [ ] T1 (P1, ~1d / ~30m) — desktop — the Workbench at two widths: stacked under 900 px, two panes above (D3)
- [ ] T2 (P1, ~3h / ~10m) — desktop — the pass header line, Add Page, Open Pull Request, `⋯` menu, timing hint (D4)
- [ ] T3 (P1, ~4h / ~15m) — desktop — the page list as the empty state, intent field, no-page-area state (D5)
- [ ] T4 (P1, ~1d / ~30m) — daemon + desktop — stream each pass lane's current tool and touched files; the working line (D6)
- [ ] T5 (P1, ~3h / ~10m) — desktop — failed and paused rows, Retry Turn, `failureLine` kinds for pass turns (D7)
- [ ] T6 (P1, ~1d / ~30m) — daemon `delivery/`, `git/` — at close, fast-forward the folder's branch to the pass tip; realign after the squash merge (D8; slice 7)
- [ ] T7 (P1, ~4h / ~15m) — desktop — the Close Pass modal with safe defaults and the summary line (D9)
- [ ] T8 (P2, ~2h / ~10m) — desktop — the thread before the first message: before picture, route, Open Page (D10; picture with slice 9)
- [ ] T9 (P1, ~2h / ~10m) — desktop — sign-off feedback and advance to the next ready page (D11)
- [ ] T10 (P1, ~3h / ~15m) — desktop — notification click and window focus select the right page; J/K, ⌘↩, ⌘L (D12)
- [ ] T11 (P1, ~2h / ~10m) — desktop — queue rows in Factory's style (D13); composer primary that follows the text (D14); Title Case strings (D15)
- [ ] T12 (P1, ~3h / ~15m) — desktop + e2e — labelled queue, polite live region for ready/question/failed, alt text, axe at two widths in both schemes (D16)
- [ ] T13 (P1, ~2d / ~1h) — daemon `mcp/`, `runner/`, `git/` — the shared chain: changes kept per hold with a dirty-path record, landed with their page's sign-off, Keep or Drop at take-out (D17; slice 6)
- [ ] T14 (P1, ~2h / ~10m) — desktop `src-tauri` — the opener capability for the project's loopback app address; Open Page then Copy Link (D18)
- [ ] T15 (P1, ~3h / ~15m) — daemon + desktop — failed checks and broken previews as notices with Send to Agent; nothing sent by itself (D19; slice 10)
- [ ] T16 (P2, ~4h / ~20m) — daemon `runner/`, `delivery/` — one review of the pass's pull request diff at Open Pull Request, findings to the owning threads (D21; slice 7)

**Unresolved Decisions:** none. The first Fable 5.2 plan review's findings (B1, M1 to M9 and its minor notes),
the second's (B-new-1, M-1 to M-11 and m1 to m11) and the third check's (M1 to M5, two revision defects, four
calls and minors a to j) are folded into the spec; B2 and B3 were settled as D8 and D17, the second review's
M-4 and M-6 as D22 and D23, and the third check's M2 and M4 as D24 and D25. §20 says where each finding went.
§20's open calls (2 to 4, 6, 7, 9 to 17, 19, 20 and 22 to 37) are defaults the spec has chosen; the builder
may overturn any of them, and none blocks a plan. The spec is ready for an implementation plan.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | — | Independent 2nd opinion | 0 | skipped (builder declined, D2) | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | issues_open | score: 3/10 → 8/10, 19 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** design outside voices skipped by the builder (D2). Three plan reviews ran on Fable 5.2
  (the repo's plan-reviewer role); all findings are folded in. `/plan-eng-review` is retired in gstack 1.98, and
  these reviews stand in for it.
- **VERDICT:** design review complete; plan reviews resolved; ready to write an implementation plan.

NO UNRESOLVED DECISIONS
