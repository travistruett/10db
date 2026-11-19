# 10db Sessions, simplified: one kind of session, and the first change asks where

**Status:** designed on 2026-11-17, not built. Revised after review round 1. §10 says where each finding went.

**Mockups:** `2026-11-17-10db-app-shell-mockups.html` frames 1 (the first change) and 2 (a session on its own
branch).

**Companion:** `2026-11-17-10db-app-shell-design.md` draws the frame: the rail, the panel and the title row. This
spec says what a session is, what its panel row and title row show, and how it changes files.

**Research:** `~/Agents/notes/10db/2026-11-17-session-move-research.md`. Both providers can carry one conversation
into a worktree by stopping the session and resuming it there. This was tested on Claude Code 2.1.326 and
codex-cli 0.167.0.

**Supersedes:** in `2026-11-11-10db-sessions-design.md` and `-sessions-ui.md`, the following: Do It (the hand-off,
the sheet, the brief), the Task kinds (Separate copy, Your folder as a pass of one), sealing a chat, task tabs, and
the four-way held send. Everything else stands: the engine, the adapters, the conversation kit, the judge, Open in
Terminal and the folder hold for 10db's own writers.

## Brief

**What changes for you.**

- **There is one kind of session.** It talks, reads, searches and explains. While it only reads, it holds nothing,
  and nothing waits on it.
- **The first time a session goes to change files** (an edit, a commit, or a command that writes), 10db pauses and
  shows a bar above the composer asking where the work should happen:
  - **Here, on `main`:** the work happens in your checkout, as Claude Code does in your terminal. The bar names
    whatever branch you're on.
  - **On a New Branch:** the same conversation carries on in its own worktree, on a new branch from the commit
    you're on. 10db sets it up as it does for Board tasks, with its dependencies installed. Your checkout is
    untouched, and you can start another session in the meantime.

  The bar asks in every session. Settings can come later.

- **Once a session has changed files, its title row offers the next git step:** **Commit**, then **Open Pull
  Request**, then **Merge**. On a project that lands locally, the last step is **Merge into `main`**. The agent can
  take the same steps when you ask.
- **Changes** opens as a slide-out drawer from the right.
- **Gone from Sessions:** Do It, its sheet and brief, "Separate copy", "a pass of one", Sign Off, Close Pass,
  sealing the chat, task tabs, and "Send Reading Only". Passes stay in the UI Workbench.
- **Words are git's and GitHub's:** branch, commit, pull request, merge, your checkout.
- **For work you want to walk away from,** ⋯ → **Make a Board Task…** opens the New Task form, filled in from the
  session. The session stays.

**What it buys.** It works like Claude Code. Thinking and doing are one conversation, and the only question 10db
asks is the one that matters: here, or on a branch.

**What could go wrong, and how we'd know.**

- _The agent keeps editing your checkout after the move_, because its history names the old paths.
  - After the move, the sandbox only lets it write in the worktree.
  - A write to your checkout is refused with a message naming the new path.
  - A real-sandbox test and a live check on each provider prove it.
- _A shell command tries to write before the bar shows._ Until you choose, the sandbox is read-only, so the write
  fails. A first spike checks, per provider, whether 10db can see that refusal and show the bar.
- _Something interrupts the move:_ a second click, a restart, Stop, Archive, or a message sent mid-move.
  - Every case has a row in §2's state table.
  - Each row has a test on a real store and a real git repo.
- _Losing work on Archive._ Archive keeps the branch. It removes only the worktree, after warning about uncommitted
  or ignored files. Reopening the session rebuilds the worktree from the branch.

**Calls you might disagree with.**

1. **The bar asks in every session.** That was your pick.
2. **A new branch starts from the commit your checkout is on, not from `main`.** That way the agent edits the code
   it just read. Your uncommitted files stay in your checkout, and the bar says so.
3. **The branch is named from the session's title** (`add-the-qa-notes`), with a number added if the name or its
   folder is taken.
4. **A branch session doesn't appear on the Board yet.** It shows in the Sessions panel. A Board card for it is a
   follow-up.
5. **"Here" works as a chat does today.** It shares your checkout with other sessions, and waits while a Board
   task or a pass has it. Once you've chosen Here, the session takes your checkout for each turn.
6. **Open Pull Request from `main`** makes a branch at your commits, switches your checkout to it and pushes it.
   Then it moves your local `main` back to `origin/main`. The commits live on the new branch, so nothing is lost,
   and your `main` matches GitHub again.
7. **Merge into `main` (local projects) needs a clean checkout on `main`.** Otherwise it says why and does nothing.
   A conflict is left for the agent to resolve on the branch.
8. **Push, Open Pull Request and Merge in a session that hasn't changed files** act on your checkout's branch and
   count as choosing Here. They don't show the bar, since there are no files to place.
9. **Open in Terminal** runs a branch session in its worktree. A session that's only reading counts as choosing
   Here.
10. **Old sessions keep what they were.** A chat sealed by Do It stays read-only, with a link to its task. An open
    pass of one stays in the UI Workbench until you close or abandon it.
11. **The title row's git button shows one next step, not all three.** Push happens inside Open Pull Request.

**Needed from you:** nothing to start. It needs one migration, so it waits behind any other open pull request that
adds one. The live checks at the end need your ChatGPT sign-in and `aws sso login`.

---

The rest is for the agents building it.

## 1. The session's life

```
reading ──first change──▶ choosing ──Here──▶ here (your checkout)
                              │
                              └──On a New Branch──▶ moving ──▶ on a branch (own worktree)
```

### 1.1 Reading

- A new session runs with a read-only sandbox on your checkout. It never takes the folder hold, so nothing waits on
  it and it waits on nothing.
- Its strip reads "`<project>`": a session that has changed nothing says only whose it is.

### 1.2 The first change

A first change is any of:

- an edit tool call: Claude's Edit, Write, MultiEdit or NotebookEdit; Codex's apply_patch. A subagent's edit counts
  too.
- one of 10db's git tools that changes files: `make_branch`, `switch_branch`, `pull`, `commit_changes`.
- a shell command the sandbox refuses to let write (§4.3).

When it sees one, 10db:

1. moves the chat to **choosing**;
2. denies that call, and every later edit or writing call in the same turn, with "Waiting for the builder to
   choose where this work happens";
3. interrupts the turn (Claude: interrupt; Codex: `GuardAnswer.interrupt`);
4. shows the bar (§3).

Calls already running when the turn is interrupted end as an interrupt ends them today.

- **Push, Open Pull Request and Merge** (`push_branch`, `open_pull_request`, `merge_pull_request`) change no files.
  In a reading session they record **here** and act on your checkout's branch, with no bar (call 8).

### 1.3 Here

- The chat records `here`. From the next turn, every turn takes the folder hold at its start, as a chat does today
  (`hooks.ts` `turnStarting` → `takeTurn`).
- It shares the checkout with other sessions (`exclusion.ts`: ChatTurn shares with ChatTurn). It waits behind a
  lane or a pass, with "Wait for It", as today.
- 10db sends one message: "The builder chose to work here, on `<branch>`. Carry on."

### 1.4 On a New Branch

The chat records `moving` with the branch name and worktree path (compare-and-set from `choosing`; §2). Then:

1. Make and seed the worktree at the checkout's `HEAD`, as a lane's worktree is cut (§4.1).
2. Close the warm session.
3. Record `branch` with the worktree's base commit.
4. Start the session again with the same provider session id, the worktree as its working directory and a sandbox
   rooted there (§4.2).

The first prompt of every session started in the worktree carries a note, built by `spec()` from the chat's row:
"You work in `<worktree>` on the branch `<branch>`, made from `<base>`. The builder's checkout at `<checkout>` is off
limits." It survives a restart, because it is rebuilt from the row and never sent as a one-off message. On the first
start after the move it adds: "You moved here before your last change. Redo it here."

The conversation shows a line: "Moved to a new branch, `<branch>`, from `<base>`."

## 2. States and interruptions

`chats.work_place` is one of `null` (reading), `choosing`, `here`, `moving` or `branch`. Every change to it is a
compare-and-set on the state it expects. The choice route is `POST /chats/:id/work` with `{ place: 'here' |
'branch' }`, and a repeat of a settled choice answers with the current state.

| State             | Event                                                               | Result                                                                                         |
| ----------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| reading           | first change                                                        | → choosing. Call denied, turn interrupted, bar shown, Inbox card raised                        |
| choosing          | Here (bar or Inbox)                                                 | → here. Card withdrawn. Next turn takes the hold                                               |
| choosing          | On a New Branch                                                     | → moving (CAS). Card withdrawn                                                                 |
| choosing          | a second choice, any source                                         | 409 with the settled state; the UI shows it                                                    |
| choosing          | you send a message                                                  | the turn runs reading only; the bar stays                                                      |
| choosing          | Esc on the bar                                                      | the bar hides; the state stays choosing, and the next first change shows it again              |
| choosing          | daemon restart                                                      | state kept; bar and card shown again from the row                                              |
| choosing          | Open in Terminal                                                    | treated as Here (→ here), then the takeover runs as today                                      |
| choosing          | model or effort change, warm-cap close                              | no change; the next start reads choosing                                                       |
| moving            | you send a message                                                  | it waits (the composer says "Moving to `<branch>`…") and runs once branch is recorded          |
| moving            | Stop                                                                | nothing to stop: no turn runs while moving; the move finishes                                  |
| moving            | Archive                                                             | refused: "Wait for the move to finish"                                                         |
| moving            | worktree can't be made (filter, path, git error)                    | → choosing. The bar shows the error; Here still works                                          |
| moving            | daemon restart                                                      | recovery finishes the move: makes the worktree if missing (idempotent by path), records branch |
| branch            | Archive                                                             | warn (§4.4), remove the worktree, keep the branch                                              |
| branch (archived) | Reopen                                                              | remake the worktree from the branch, re-seed, then start as branch                             |
| choosing          | Archive                                                             | the Inbox card is withdrawn, then Archive runs as for reading                                  |
| moving            | Open in Terminal                                                    | refused: "Wait for the move to finish"                                                         |
| moving            | daemon restart after the cut, before seed and install finish        | recovery reruns the seed and install (both idempotent) before recording branch                 |
| branch (archived) | Reopen while its branch is checked out in another worktree          | reopens read-only, saying where the branch is checked out                                      |
| here              | a title-row git step while a Board task or pass holds your checkout | refused with the holder's words (§4.6)                                                         |
| here              | Open in Terminal                                                    | the takeover holds your checkout, as today                                                     |
| branch            | Open in Terminal                                                    | the takeover runs in the worktree and holds nothing (§4.5)                                     |

The Inbox card is a stored card: raised on entering `choosing` and withdrawn on leaving it. The counts, the rail
badge, ⌘J and the needs-you mirror read it as they read any open card, and it fits the paged Open inbox.

## 3. The bar

- It sits above the composer, in the composer's column:
  - a `bg1` panel with radius 12;
  - a 3 px blue left edge (`inset 3px 0 0`);
  - 10 × 12 px padding.
- **Its text:** "**Claude is about to start changing files.** Where should this work happen?" The bar names the
  agent, Claude or Codex.
- When your checkout has uncommitted files, a dim second line reads: "A new branch starts from your last commit. Your
  2 uncommitted files stay in your checkout."
- **Buttons:**
  - **Here, on `<branch>`** (default variant).
  - **On a New Branch** (primary).
  - If a Board task or a pass holds your checkout, Here still works. The session then waits, and a dim line says so:
    "A Board task is changing files on `<branch>`; this session will wait for it." The line follows
    `FolderHoldChanged` live.
- **Keys:**
  - 1 and 2 choose.
  - The bar takes focus when it appears, unless you're typing.
  - Esc hides it (§2).
- **Shown once per session.** The choice lives on the chat's row.

## 4. How it works

### 4.1 The worktree

- **The cut:** at the checkout's `HEAD`, never including uncommitted files. It uses lanes' cut code
  (`worktree-cut.ts`):
  - the same refusals (filters such as LFS);
  - `seedWorktree` with `project.worktreeSeed`;
  - the install and its cards.
- **Path:** `worktreePathFor(root, project, 'chat-<slug>')`, the lanes' layout under the same root and project
  folder, so the sweep's `underRoot` finds it. The `chat-` prefix keeps it apart from lanes' paths
  (`worktree-path.ts`).
- **Branch:** `<slug>`. The slug comes from the session's title. Add `-2`, `-3`… until neither the branch nor the
  path exists.
- **Ownership.** Every place that knows a batch's worktree learns a chat's:
  - **Lock reason:** `10db chat_<id>`. `worktree-list.ts`'s `LOCK_REASON` accepts both shapes, so `removeWorktree`,
    `lockedWorktree` (and with it `worktreeChanges` and `worktreeIgnoredFiles`) and the sweep's `orphanVerdict` all
    recognise it.
  - **Pins:** `checkout-pins.ts`'s `pinOwner` finds a chat's worktree by `chats.worktree_path` and keys its pin as
    `chatWorktreePinKey(chat.id)`, so the pin is stored and survives a restart. Without this, every git call there
    fails after a restart as `Unpinned`. Archive and the sweep delete the pin with the worktree.
  - **Sandboxes:** `allCheckouts` (`delivery/checkout.ts`) includes chat worktrees, so lanes and other sessions are
    denied writes to them.
  - **The sweep:** `sweepWorktrees` also runs for local projects, for chat worktrees only, with its own branch
    beside `orphanVerdict`'s `BatchId` check (a widened `LOCK_REASON` alone would read a chat's worktree as not
    10db's). It removes a `chat_`-locked worktree when its chat is archived or missing, **or** closed with its branch
    merged. In every case the worktree must have no changes (the sweep's own checks).

### 4.2 Moving the session (both providers)

- **Claude** (plan, Bedrock, API key: one adapter, 10db's pinned Claude Code, `sessions/AGENTS.md`):
  - Close the warm session and start it with the same `resume` id and the worktree as `cwd`.
  - The adapter already passes `cwd` and `resume` on every start, with `settingSources: []`.
  - Don't copy the transcript: a duplicate breaks `--resume`.
  - The pinned Claude Code (≥ 2.1.223) finds the session from any folder.
- **Codex:**
  - End the thread's session.
  - Call `thread/resume` with `cwd` set to the worktree, and `config.permissions` rebuilt from the worktree's sandbox
    (`lanePermissions`).
  - Per-turn `cwd` alone is not enough.
- **Everything that reads the checkout today reads the session's root instead.** The root is the checkout while
  reading or here, and the worktree on a branch. In `chat/hooks.ts`:
  - `cwd`;
  - the trust policy's `checkout`;
  - the fast path's `checkout` and `tmpDir`;
  - `launch.access.checkout` for confinement.

  Elsewhere:
  - `createShapePreparer` (`shape-session-tools.ts`) takes the root, not only the project id.
  - `forSession` gets `projectAtCheckout(project, worktree)` with `writes: true`.
  - `conversation-files.ts` offers @-mentions from the root.

- **The checkout after the move:** the sandbox doesn't let the session write there. Confinement refuses with "This
  session works in `<worktree>` now. The same file is at `<worktree>/<relative path>`."

### 4.3 Seeing the first change

- **Edit tools and 10db's git tools:** the PreToolUse hook (Claude) and the guard hook (Codex, `codex-guard.ts`)
  see every call. `confinement.ts` raises the choice where it now denies an edit without the hold.
- **Shell commands:** the sandbox is read-only until the choice. Step 1's spike decides, **per provider**, whether
  10db can see the sandbox refuse a write (srt's violation reporting on macOS; Codex's sandbox denial events).
  - **Where it can:** the refusal raises the choice.
  - **Where it can't:** the session's instructions say "Until the builder chooses where you work, the sandbox is
    read-only: make your first change with an edit or one of 10db's git tools." A shell-first write then reaches the
    bar at the agent's next edit.
- **The judge** still decides what touches a hard limit, before and after the choice.
- **Why these restrictions** (AGENTS.md asks): the bar, the read-only sandbox before the choice and the closed
  checkout after a move all exist to coordinate 10db's own writers in your checkout. None is a rule about what the
  agent may do. On a branch, it works as freely as a lane does.

### 4.4 Archive and reopen

- **Archive asks first** when the worktree has uncommitted or untracked changes, or ignored files the seed didn't
  put there. It uses the sweep's checks (`worktreeChanges`, `unseededIgnoredFiles`). The prompt names them:
  "Archive removes `chat-add-the-qa-notes`. 2 uncommitted files and `.env.local` will be lost. Your commits stay on
  `add-the-qa-notes`."
- Archive removes the worktree and keeps the branch.
- **Reopen** (unarchive) remakes the worktree from the branch and re-seeds it. If the branch is gone, it reopens
  read-only, with "Its branch `x` was deleted."
- **Closing** (×) keeps the worktree. The sweep's rule (§4.1) removes it once the branch has merged and the
  worktree is clean. Nothing unmerged is ever removed without Archive.

### 4.5 Open in Terminal

- **On a branch:** the takeover is prepared with the worktree as `cwd` (`takeover/prepare.ts`,
  `takeover/render.ts`). It takes no folder hold, because the worktree is the session's own.
- **Here:** as today.
- **Reading or choosing:** it records `here`, then runs as today. A terminal is unconstrained, so it works in your
  checkout.

### 4.6 Git steps and the title row

**The read model.** Route: `GET /chats/:id/work` → `{ place, branch, base, dirtyFiles, ahead, pullRequest: { number,
url, checks, mergeable, merged } | null }`.

- **Working-tree state:** read from the root on demand and after each turn ends.
- **Pull request:** looked up through `pr-watch.ts`'s existing GitHub reads, by branch. It's polled only while the
  session is shown, or has an open pull request, at the pull-request watcher's interval. Nothing new polls `gh`.
- **Changes:** `GET /chats/:id/changes`. It compares the root against the branch's base commit, or `HEAD` plus
  uncommitted changes when here. It returns the same DTO as `workstream-changes.ts`, so `ChangesPanel` (with #651's
  fixes) draws it in the drawer.

**The title row's next step.** It runs a daemon route. It needs no warm session and no turn.

**Holds:** on a **Here** session, every title-row route takes a GitWork reservation on your checkout
(`reserveGitWhenFree`). While a Board task or a pass holds the checkout, the route refuses at once with the
holder's words ("A Board task is changing files on `main`"), and the button shows that reason. A chat turn sharing
the checkout doesn't block it, but the route waits for that turn's end before switching branches (call 6). A
**branch** session's routes act on its own worktree and take no hold.

| State                                         | Button                                                                                   | Daemon                                                                                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| uncommitted changes                           | **Commit**                                                                               | a message (from the title) and a file list, **defaulting to the files the session touched**, then `commit_changes` with those paths                                          |
| commits not on a pull request, remote project | **Open Pull Request**                                                                    | push the branch, open the PR with the session's title                                                                                                                        |
| here on the base branch, remote project       | **Open Pull Request**                                                                    | call 6: branch at `HEAD`, switch to it, push, open the PR, then move local base back to `origin/<base>`. Refused if the checkout is dirty                                    |
| pull request open                             | **Merge** when checks pass and it's mergeable; otherwise disabled "Checks running · 3/9" | `merge_pull_request`                                                                                                                                                         |
| merged                                        | none; the strip reads "merged into `main`"                                               |                                                                                                                                                                              |
| local project, commits on the branch          | **Merge into `main`**                                                                    | needs your checkout clean and on base, with a GitWork reservation. Otherwise it says why. A conflict is refused, and the agent can merge base into the branch and resolve it |

**The git tools** (`chat/git-tools.ts`):

- `holding()` resolves the session's root.
- A branch session needs no folder hold. It does need its own worktree, pinned.
- Here keeps the hold rule.
- The title-row routes call the same functions without a live session. The agent's tools still require one.

## 5. Data

- **One migration:** `chats.work_place`, `chats.worktree_path`, `chats.branch`, `chats.base_head`.
- **Contracts:** `ChatDto` gains `work: { place, branch, base, worktree } | null`. The git state comes from
  `GET /chats/:id/work`.
- **Removed:** the Do It routes and the brief routes. The pass-of-one synthetic page is removed only once no open
  pass uses it (§7 step 8).
- **What stays readable:**
  - Sealed chats and their tasks keep their rows.
  - A sealed chat renders read-only, with "Opened as a task" and a link to the Board task.
  - `finishSeals` stays in recovery until the removal step.

## 6. What the session shows

### 6.1 Panel row (shell spec §1.3)

- **The icon says where it works:**
  - chat bubble: reading
  - laptop: here
  - git-branch: on a branch
  - terminal: in your terminal
- **The state mark sits at the right.** The first match wins:
  - a spinner while a turn runs or while moving (a static dot with reduced motion)
  - a yellow `alert-circle`: needs you (choosing, a permission, an Inbox card)
  - a red `alert-triangle`: stopped by an error
  - a dimmed `git-pull-request`: PR open
  - a green `check`: merged
  - the title in weight 600: a new reply
- Never colour alone.
- Hover shows ×. Right-click offers Rename, Open in Terminal, Make a Board Task…, Archive and Close.

### 6.2 Panel order

- Projects in the project list's order. The selected project is **not** moved up, so ⌘1–9 stay stable.
- Within a project, the builder's order (`tabPosition`, dragged). A new session goes to the top of its project.

### 6.3 A new session (⌘T)

- It opens in the content as today's fresh tab: project and model picker, composer, Start from, and Recent.
- Its panel row reads "New session" (dim, italic) at the top of its project until the first message is sent, which
  makes it a chat, or it's closed.
- It's kept in `tendb.sessions.fresh` as today.

### 6.4 Recently closed

- Up to five, at the panel's foot (`tendb.sessions.closed`).

### 6.5 Title row

The title row is almost all title. From left to right:

- **The title, which is the switcher:** the title and a ⌄, one button that opens every open session by project,
  then Recently closed and New Session ⌘T. It takes the row up to the controls; rename is in ⋯.
- **Then:**
  - the git step (§4.6)
  - the terminal button
  - ⋯

**The strip under the composer** is one dim line: where the session works on the left, and what runs it and what
it changed on the right.

- **The place**, in git's words:
  - reading: "`10db`"
  - here: "`10db` · on `main`"
  - on a branch: "`10db` · on `add-the-qa-notes` · not committed", or "· pull request #652, checks passing"
- **Then:**
  - the agent ("Claude Code", "Codex"), whose tooltip says "Claude Code runs this session"
  - the context ring
  - the change count, "+41 −6" (⌘⇧D), when anything changed; it opens the Changes drawer

The composer lists no keys: Enter, Shift+Enter, Esc, `/` and `@` are every chat's. Its only line under the
frame is a state's ("Sends when the limit resets").

### 6.6 Keys

They keep their meaning on the panel's order:

| Key            | Action                                                                         |
| -------------- | ------------------------------------------------------------------------------ |
| ⌘T             | new session                                                                    |
| ⌘W             | close                                                                          |
| ⌘⇧T            | reopen                                                                         |
| ⌘J             | next session needing you (also the Sessions rail badge's click, from any view) |
| ⌘1–8, ⌘9       | go to a session; ⌘9 is the last                                                |
| ⌘⇧[ ] and ⌃Tab | previous and next                                                              |
| ⌘⇧D            | Changes                                                                        |

⌘⇧↩ is freed.

### 6.7 Links

- `OpenSessionLink` opens the session.
- `OpenTaskLink` and `/sessions?task=` open the Board with that task's drawer (`/board?task=`).

### 6.8 Words

Every message that named "Your folder" or a hold names the branch and who has it. Rewritten in step 7:

- `confinement.ts`
- `git-tools.ts`
- `hooks.ts`
- `holderWords`
- the composer's wait row

They read "A Board task is changing files on `main`. Your message runs once it's done." The branch comes from the
checkout, never a hard-coded `main`.

## 7. Build order

Concurrency, git, the sandbox and recovery go in small red-first steps, one commit per behaviour. The daemon and
the desktop land in **one pull request**, so main never has a bar that no screen can answer. The first time they run
together is step 7's e2e, before any review of the view.

1. **Spike (no commit).** Settle three questions per provider:
   - Can 10db see a shell write the sandbox refused?
   - Does Claude's transcript still write under srt after the move (research risk 3)?
   - Do Edit's read-before-edit state and file checkpointing survive the resume?

   Each answer picks a branch of §4.3, or adds a line to the continuation note.

2. **Schema and migration.** The columns are generated locally as the branch's migration, so `createTestStore`
   includes them. They're regenerated after the final merge of main, before the pull request (AGENTS.md).
3. **Daemon: reading without the hold, and choosing.**
   - the first-change detection per call kind, subagents included;
   - the turn's deny-and-interrupt;
   - the state machine of §2, with CAS and the route;
   - the stored Inbox card.

   Tests: one row per §2 row on a real store, with the fake adapter for turns, plus a restart while choosing.

4. **Daemon: Here.** Tests reuse M6a's hold tests, plus the shared-with-chats and wait-behind-a-lane rows.
5. **Daemon: the worktree and the move.**
   - ownership (lock reason, pins, `allCheckouts`, the sweep for local projects);
   - the cut and seed;
   - the move on both adapters;
   - the continuation note from `spec()`;
   - recovery of `moving`;
   - Archive and Reopen.

   Tests:
   - a real git repo for each ownership place;
   - a real store and a restart mid-move;
   - the Claude options builder (`claude-session.ts`) and Codex's `startThread` tested directly for `cwd` and
     resume;
   - **a real-sandbox test that `forSession(projectAtCheckout(project, worktree), writes)` refuses a write to the
     checkout.**

6. **Daemon: the work read model, Changes, the title-row routes and the git tools' root.**
   - Tests through `app.request` with `test/fake-gh.ts` for push, PR and merge.
   - The reservation rows: each route refused while a lane or a pass holds the checkout, and call 6 waiting for a
     sharing chat turn. These run on a real store and a real repo.
   - **Search:** `GET /chats/search?q=&after=` covers open, closed and archived sessions, keyset-paged by last
     activity, for the panel's search (shell §1.4).
   - A real repo for Commit's default paths, the main-to-branch move (call 6) and Merge into `main`.
7. **Desktop:**
   - the panel rows, the title row, the bar, the git button and the Changes drawer;
   - the words;
   - removing Do It, the task tabs and the strip;
   - the links.

   e2e through the real daemon (WebKit), on a **local** project (no GitHub). The fake adapter gains a script step
   that writes a file relative to the session's working directory, which follows the resumed `cwd`. Today's
   `FakeStep` can't write:
   - read → first change → On a New Branch → the edit lands in the worktree → Commit → Merge into `main`;
   - read → first change → Here.

8. **Removal.**
   - The Do It and brief routes, with their tests.
   - The pass-of-one page and `finishSeals` are **not** removed in this PR. The Workbench keeps showing and closing
     passes of one, and recovery keeps finishing seals. Their removal is a follow-up, made once the builder's
     database has no open pass of one and no unfinished seal.
9. **Live checks**, on the Claude plan, Bedrock and Codex: a session reads, chooses On a New Branch, recalls a word
   from before the move, edits a file, and the checkout is untouched. Commit and Open Pull Request run against a
   real GitHub repository.

## 8. Provider parity

|                        | Claude plan               | Bedrock / API key   | Codex                                            |
| ---------------------- | ------------------------- | ------------------- | ------------------------------------------------ |
| First-change bar       | edit tools via PreToolUse | same adapter        | apply_patch via the guard hook                   |
| Move to a new branch   | resume with new `cwd`     | same                | `thread/resume` with `cwd` + rebuilt permissions |
| Shell-first write seen | per the spike             | same as Claude plan | per the spike                                    |
| Git steps, title row   | 10db's routes             | same                | same                                             |

All three use Claude Code ≥ 2.1.223 where it applies, since the plan and Bedrock run the same system `claude`. The
UI names a provider only in the strip's agent label and the bar's sentence.

## 9. Docs

- **Sessions design spec and UI spec:** a note at the head of each superseded section pointing here.
- **Decisions, one file each:**
  - "A session's first change asks where the work happens"
  - "A session on a new branch is the same conversation in its own worktree"
  - "Sessions use git's words"
- **Notes:** `apps/daemon/src/chat/AGENTS.md`, `apps/desktop/src/views/sessions/AGENTS.md`, and
  `apps/daemon/src/git/AGENTS.md` (chat-owned worktrees).
- **Follow-ups to file:**
  - a Board card for a branch session
  - Move to a New Branch after Here, carrying uncommitted files
  - an "always" setting for the bar
  - renaming a branch before its first push
- **Depends on #651** (Changes keeps its last diff; the Brief card). Merge it first.
- Follow-up: remove the pass-of-one page and `finishSeals` (step 8).

## 10. Review round 1: where each finding went

- B1: §2.
- B2: §4.1.
- B3: §4.5.
- B4: §4.4.
- B5: §4.2, §4.6.
- B6: §5, step 8.
- B7: §1.3, §3, call 5.
- B8: call 6, §4.6.
- B9: call 2, §4.1.
- B10: steps 2 and 7.
- B11: steps 5–7.
- B12–B14: the shell spec, and §6.2.
- N1: §2.
- N2: step 1.
- N3: §4.3.
- N5: the mockup note.
- N6: §6.3.
- N7: §6.5.
- N8: §4.4.
- N9: §4.6.
- N10: §4.3.
- N11: §1.2, call 8.
- N14: §7.
- N15: §6.7.
- N16: §8.
- N17: §4.1.
- N18: §9, §6.8.
- N4, N12 and N13: the shell spec.

**Round 2:**

- Blocking 1 (title-row routes and the hold): §4.6, §2, step 6.
- Blocking 2 (Inbox paging): shell §4.1.
- N-a: step 7. N-b: §4.1. N-c: §2. N-d: §4.1, §4.4. N-e: step 8. N-g: §4.2, §1.2.
- N-f, N-h, N-j: the shell spec. N-i: step 6.
