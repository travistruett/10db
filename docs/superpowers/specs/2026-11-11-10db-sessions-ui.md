# 10db Sessions: the UI

**Status:** designed on 2026-11-11, not built. Written overnight while the builder slept, then revised the same
night to match v3 of the design spec.

- No questions could be asked. Every call the builder has not made is marked **(call)** and listed in §19.
- The design spec adopts several of these calls (its §17, item 12). Where this file and the design spec differ,
  the design spec wins.
- Revised after one round of independent design review. §21 says where each finding went.
- Revised again with v4 of the design spec, on top of the trust line
  (`2026-11-12-10db-trust-line-design.md` §13): a Chat writes in Your folder, its calls are judged, and the
  builder's setup and the web come along. §22 says where each change went.

**Companion of:** `2026-11-11-10db-sessions-design.md`. The design spec holds the engine, the adapters, the data,
the states and the rules. This file says how the screen looks, reads and behaves.

**Mockups:** `2026-11-11-10db-sessions-ui-mockups.html`, in this folder. It holds nine framed screens and a states
strip, in Selenized light and dark, with the decisions written beside each frame.

**Extends:**

- `DESIGN.md`: Selenized, Mantine, the status colors, Title Case buttons and the counts rule.
- The UI Workbench's screen (`2026-11-09-10db-workbench-design.md` §4): its composer, buttons, live line and
  sign-off.
- Plan's conversation (`views/shape/`): its transcript, waiting cards and model picker.

## 0. The design in one paragraph

Sessions is a global screen whose **tabs live in the window's title bar**, in the 48 px header that is empty today.
Each tab is one conversation with an agent in one project. Every session starts as a **Chat**, which reads the
project, runs commands, searches the web and changes **Your folder**, as Claude Code does in a terminal. It holds
the folder while a turn runs, and it can commit, branch and open a pull request. At a limit it asks first. For
bigger work, **Do It…** hands the work to a **Task**. A Task in a **Separate copy** is an ordinary Board task that
takes the Chat's place in the strip, and the Chat becomes read-only. Optionally, a Task in **Your folder** is a pass
of one, which opens beside the Chat and lands as a pass does. A tab says three things at a glance: whose project (its tile), what
it is (its title, and a folder or branch glyph when it writes), and whether it needs the builder (a dot, a ring
or a small icon, never color alone). Inside a tab the conversation reads as a
story: the builder's messages on a raised panel, the agent's replies as rendered markdown, and its tool calls as
quiet one-line rows that open on demand. Everything a tab can show comes from what its agent reports it can do,
never from which agent it is.

**The one bold move** is the tabs in the title bar. Everything else is the app that exists: the sidebar, Selenized,
Mantine, the Workbench's composer and buttons, and the Inbox's cards.

## 1. Grounding

What this design extends, read in the checkout at `c4da899`. Each row is **built** unless it says otherwise.

| Fact | Where |
| --- | --- |
| The sidebar reads Inbox and Factory; then a "Project" label over the switcher, with Board, Plan, UI Workbench, Knowledge and Project Settings; then Settings at the foot. | `apps/desktop/src/shell/app-layout.tsx:46-58`, DESIGN.md "Scope follows the question" |
| The header is 48 px and a drag region. The traffic lights sit over its left 72 px and the status icons at its right, with nothing else in it. | `app-layout.tsx:134`, `:149-171` |
| The sidebar is 200 px. It folds behind a burger under 768 px, and under 900 px on the Workbench. | `app-layout.tsx:63`, `:69`, `:136`; `decisions/2026-11-09-the-window-narrows-to-the-workbench.md` |
| Every color is a Selenized value, unmixed, with no contrast floor. | `decisions/2026-10-28-selenized-exactly.md`, `theme.ts` |
| Status colors: blue running, yellow waiting on a human, orange paused, red failed, green done, gray queued. Nothing pulses. | DESIGN.md "Primary color", "Card state" |
| Buttons, menu items and the names of things are Title Case; labels and messages are sentence case. One filled primary per group. | DESIGN.md "Copy", "Buttons" |
| A label never carries its count. A hidden or waiting count is a `CountBadge`. | `decisions/2026-11-11-a-label-never-carries-its-count.md` |
| Plan's transcript is plain text, with "You" and "Claude" labels, and is "never rendered as markup". It follows the tail unless the builder has scrolled up more than 120 px. | `views/shape/transcript.tsx:84`, `:135`, `:212` |
| Plan and the Workbench send with ⌘↩. Plan's ⌘⇧↩ is Propose, and Esc stops. | `views/shape/use-shape-keys.ts:46`, `:65` |
| While a turn works, the Workbench composer says "Add to this turn…". Its buttons follow a phase table: Sign Off is filled on a ready page with nothing typed, Send is filled once there is text, and Stop and Redo shows while a turn works. | `views/workbench/composer.tsx:48-50`, `composer-buttons.ts:50-53` |
| A turn's question or permission is the Inbox's own card, answered in place. | `views/shape/waiting-permissions.tsx`, `views/workbench/page-ask.tsx` |
| The Board says "Your folder" and "Separate copy", never "worktree". | `views/board/placement.ts:13-15` |
| A pass's close shows progress lines: "Running the gate in your folder…", "Pushing…", "Closing the pass…". | `views/workbench/close-progress.tsx` |
| A pass's close fast-forwards the folder's branch. | `decisions/2026-11-09-a-close-fast-forwards-the-folders-branch.md` |
| No `⌘K`, `⌘T`, `⌘W` or `⌘1–9` handler exists in the desktop app. | `grep` over `apps/desktop/src` |

## 2. Words

The builder reads these words and no others.

| Word | Means | Never |
| --- | --- | --- |
| **Sessions** | The screen, and each tab on it ("a session"). In the code a tab is a `chat` (design spec, Words). | "Threads", "Agents" |
| **Chat** | A conversation with an agent in a project. It reads, runs commands and searches the web, and it changes Your folder, holding it while a turn runs. It can commit, branch and open a pull request, through its git tools. Every session starts as one. | "Explore mode" |
| **Task** | Work a Chat hands off with Do It (Hands-on): an ordinary Board task in a Separate copy, or, optionally, a pass of one in Your folder. | "Hands-on", "work mode" |
| **Do It** | Hands a Chat's work to a Task. | "Promote", "Convert" (Plan's word) |
| **Your folder** / **Separate copy** | Where a Chat or a Task works. These are the Board's words. | "worktree", "checkout" |
| **Sign Off**, **Close Pass**, **Abandon Pass** | How a Task in Your folder lands, word for word as a UI Workbench pass does. | "Merge", "Ship" |
| **Read-only** | A Chat that handed its work to a Task in a Separate copy (the `sealed` state). | "Sealed", "locked" |
| **Allow This** | The builder's go-ahead for a call the judge held back at a limit (trust line §5). | "Override", "Bypass" |
| **Open in Terminal** / **Hand Back** | Moving a session to the builder's terminal and back. | "Takeover", "Detach" |

## 3. Where it sits

**Sessions is a global screen, third in the sidebar, after Inbox and Factory** (design spec S1).

```
┌──────────────────────────────────────────────────────────────┐
│ ● ● ●   [tabs live here on Sessions]          status icons   │  header, 48 px
├────────────┬─────────────────────────────────────────────────┤
│ Inbox    3 │                                                 │
│ Factory    │                                                 │
│ Sessions 2 │   ← new                                         │
│            │                                                 │
│ Project    │                                                 │
│ [AM ampsio]│                                                 │
│ Board      │                                                 │
│ Plan       │                                                 │
│ UI Workb…  │                                                 │
│ Knowledge  │                                                 │
│ Project S… │                                                 │
│            │                                                 │
│ Settings   │                                                 │
└────────────┴─────────────────────────────────────────────────┘
```

- **Why global:** a tab that needs the builder must never hide behind the project switcher. That is the bug "Scope
  follows the question" fixed. A session still belongs to one project, as a task does.
- **Icon:** Tabler `messages`, 16 px, stroke 1.5.
- **Badge:** a `CountBadge` of the tabs that need the builder, read aloud as "2 sessions need you". The UI
  Workbench's item counts its waiting pages the same way, though they are Inbox items too.
- **The project switcher never filters the tabs.** A new tab takes the selected project. **Selecting a tab makes
  its project the selected project (call)**, as acting in a project's group does in Factory. Board and Plan then
  open on the project the builder is talking about.
- **⌘T works from any view** and opens Sessions on a new tab **(call)**. ⌘W, ⌘1–9 and ⌘⇧[ ] work only on Sessions.

## 4. The screen and what it shows first

```
┌● ● ●──┬[10 CI gate timeout ●][AM ▭ Retry login on a 401 ●][10 Codex permissions ◉][AM Invoice… ▣][+][⌄]··☾┐
│Inbox 3│ Retry login on a 401   ▭ Task · Your folder · lands on main    Claude Code · opus ⌄  ▮▮▯ 41%  Changes +41 −6  ⋯ │
│Factory│────────────────────────────────────────────────────────────────────────────────────────────────│
│Sess. 2│               ┌──────────────────────────────────────────────┐                                  │
│       │               │ your message, on the raised panel            │                                  │
│Project│               └──────────────────────────────────────────────┘                                  │
│[AM ⇅] │               the reply, rendered markdown                                                       │
│Board  │               ▸ Read 5 files, searched 2 times                                                   │
│Plan   │               ✎ Edited src/api/client.ts               +4 −2                                     │
│…      │               $ pnpm vitest run src/api                exit 1 · 9 s                              │
│       │               ● Working · 3 min · editing api/client.ts                                           │
│       │               ┌ composer ────────────────────────────────────┐                                  │
│       │               │ Add to this turn…                            │                                  │
│       │               │ 📎                                     Stop  │                                  │
│Setting│               └──────────────────────────────────────────────┘                                  │
└───────┴──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**The order the eye should land in:**

1. **The tab strip:** which conversations are open, and which one needs me.
2. **The conversation column:** the latest reply, and the working line under it.
3. **The composer:** the one place to act, with its filled primary (Send, or Sign Off on a ready Task).
4. **The session bar,** quiet and dimmed: what this session is, where it writes, its agent and model, and how full
   its context is.

**The column** is one reading measure, at most **720 px**, centred in the conversation pane, with left-aligned text
**(call)**. At 14 px it holds about 90 characters of prose and a 100-column code block in 13 px mono.

**The session bar** is one 44 px row under the header. At its left, the title sits over the kind line, so the
kind line never competes with the buttons for width. It shows:

- the full title (weight 600; click to rename)
- under it, a dimmed `xs` line saying what the session is:
  - "Chat · Your folder · on `main`"
  - "Chat · reads only: Your folder is in use by the pass ‘Settings pass’" (another writer holds the folder; the
    turn still runs and changes nothing, design spec §7.3)
  - "Chat · read-only: its work moved to a task"
  - "Chat · in your terminal since 12:04"
  - "Task · Your folder · lands on `main`"
  - "Task · Separate copy · `10db/retry-401`"
- at its right:
  - the agent and model control
  - the context meter
  - **Do It…** (a Chat), or **Changes** and the Task's landing button (a Task)
  - the Open in Terminal icon button
  - the `⋯` menu

## 5. The tab strip

### 5.1 Where it sits

**The tabs live in the header, in the 48 px row the window already has (call, the one bold move).**

- On Sessions the strip starts just after the traffic lights, at 84 px, not at the sidebar's edge, so five tabs
  keep readable titles at 1080 px. It runs to the status icons.
- Its empty space keeps `data-tauri-drag-region`, so the window still drags, and a double-click there zooms the
  window, as a macOS title bar does. A double-click on a tab renames it instead (§5.4).
- The shell gains a header slot that only Sessions fills. On every other view the header is as it is today.
- **Why:** the header is empty on every view, and tabs below it would take another 36 px from the conversation.
  Safari, Terminal and iTerm put tabs in or against the title bar, which is the "iTerm-like" the builder asked for.
- **Risk:** a tab must not carry the drag attribute, or a click would move the window. This is a live check (§20).

### 5.2 Anatomy of a tab

A tab is a **pill** 30 px tall, radius `md`, at most 220 px wide, in the sidebar's language. It has no outline. The hovered and the selected tab take the `bg_1` fill, and the selected tab's title is `fg_1` at weight 600
(NavLink's active label).

```
 ┌───────────────────────────────────────┐
 │ [AM] ▭ Retry login on a 401        ●  │   tile 16 · kind glyph 12 · title 13 px · state 8 px
 └───────────────────────────────────────┘
```

Left to right:

1. **Project tile**, 16 px: the project's two-letter mark (`ProjectTile`).
2. **Kind glyph, on a Task only**, 12 px, dimmed: Tabler `folder` for Your folder, `git-branch` for a Separate
   copy. A Chat has none: every Chat works in Your folder, and its session bar says so. Where a Task writes is a
   trust fact, so it shows on the face **(call)**.
3. **Title**, truncated with an ellipsis.
4. **State** at the right: an 8 px dot, or a glyph, or nothing (§5.3).
5. **Close ×**, 14 px. On hover and on the selected tab it takes the state mark's place, so it adds no width. The
   ring stays, and the state is still in the tab's name and tooltip.

**Width.** Every tab takes its title's natural width, up to 220 px. When the strip is full, the other tabs shrink
first, down to 96 px; the selected tab keeps its natural width. Titles are short by design: `set_title` asks the
agent for at most 28 characters (§5.4).

**The agent and model are not on the tab (call).** They do not fit at six tabs, and they rarely change. They are
in the tooltip and the session bar.

**Tooltip** (after 500 ms):

```
Retry login on a 401
ampsio · Task · Your folder · Claude Code opus
Ready: look at the changes and sign off
```

### 5.3 States and their exact visuals

One state shows: the first that holds, in this order. Colors are DESIGN.md's status colors, drawn in Selenized
base. Each row names the design spec state it reads (§6.7 there) or the task's.

| State | When | On the tab | Spoken |
| --- | --- | --- | --- |
| **Needs you** | An open Inbox card came from this session: a permission or a question (`waiting_card`). | yellow dot, **and a 1 px yellow ring around the pill**; title `fg_1` | "needs you: permission to run a command" |
| **Ready** | A Task in Your folder ended a turn, and its `check` card waits, as a Workbench page's does. | yellow dot and ring | "ready: look at the changes" |
| **Stopped by an error** | `ended_error`, or a Task's run or turn failed. It needs the builder, as a failed Workbench page does (`page-status.ts`). | Tabler `alert-triangle`, 12 px, red, **and a 1 px red ring** | "needs you: stopped by an error" |
| **Paused** | `paused_account`: a usage limit or a cap. | Tabler `player-pause`, 12 px, orange | "paused: usage limit, resumes 3:40" |
| **Working** | `starting`, `running` or `stopping`, or a Task's lane runs. | blue dot, static | "working" |
| **In your terminal** | `taken_over`. | Tabler `terminal-2`, 12 px, dimmed; title dimmed | "in your terminal" |
| **In review** | A Task's pull request is open: a Separate copy that finished, or a Your-folder pass that closed. | Tabler `git-pull-request`, 12 px, dimmed | "in review: pull request 212" |
| **Signed off** | A Your-folder pass whose turns are all signed off, with nothing working, that is not closed yet. Nothing has landed, and the folder is still held. | Tabler `check`, 12 px, **dimmed**; the session bar's Close Pass… is its filled primary | "signed off: close the pass to land it" |
| **Done** | Work that landed: a Task whose pull request merged, or a closed pass on a `local` project, where the close moves the branch at once. | Tabler `check`, 12 px, green | "done" |
| **New reply** | A Chat's turn ended since the builder last looked at the tab. | no mark; title `fg_1` at weight 600 | "new reply" |
| **Idle** | Nothing above. | nothing | (title and project only) |

- **Never color alone** (WCAG 1.4.1). Working is the only bare dot. Needs you and Ready add the ring; an error,
  a pause and done are icons with their own shapes, drawn in the status color.
- **The ring mirrors the Board.** A Board card waiting on the builder is "the most prominent: a full 2 px yellow
  border", and a failed one is red. A pill takes a 1 px ring in the same color, because 2 px crowds a 30 px pill
  **(call)**. Needs you, Ready and Stopped by an error count in the Sessions badge, as Asks, Ready and Failed count
  in the UI Workbench's.
- **Green means landed.** A Your-folder pass whose turns are all signed off still holds the folder and has landed
  nothing until Close Pass…, so it is **Signed off**, a dimmed check, not green. In review is a closed pass waiting
  on its pull request; Done is merged work, or a closed pass on a `local` project. **This differs from the UI
  Workbench on purpose:** there a signed-off page is green because it is one row of a pass whose header still shows
  the pass open; here the pass of one is the whole tab, so green would claim the work has landed when it hasn't.
- **No spinner, no pulse (call).** DESIGN.md says nothing pulses, and Factory and the Workbench show running as a
  static blue dot. The working line inside the tab moves; the tab does not.
- **"New reply" is weight, not color (call).** A finished chat is not waiting on anyone, so it takes no status color
  and no Inbox card. It reads like an unread channel.
- **In review is a glyph, not a color (call).** Blue on a tab means an agent is working.
- **A read-only Chat** has no tab: its Task took its place (§8.2). **Archived** sessions never sit in the strip
  (§5.6).
- **Your folder in use is not a tab state.** While another writer holds the folder, a Chat's kind line says so,
  dimmed (§4), and its tab looks as its state says. No new color.
- **A call held back at a limit is not a tab state.** In an attended session it is a dim row with Allow This
  (§7.3). Only an escalated call raises a card, and that card is Needs you.

### 5.4 Titles

- A new tab is **"New session"**. On the first send it shows the message's first line at once, cut to 40
  characters, so a tab is never blank.
- After the first turn the agent names the session through `set_title` (design spec §7.1). The tool's
  description asks for at most 28 characters, in sentence case, with no trailing period, and the daemon cuts
  anything longer at a word. The new title replaces the old with no animation.
- **Rename:** double-click the tab or the session bar's title, or choose Rename in the tab's menu. A title the
  builder set always wins.

### 5.5 Many tabs

- **Order** is the builder's. A new tab opens to the right of the current one. A Task in a Separate copy takes its
  Chat's place, and a pass of one opens to the Chat's right. Drag to reorder (dnd-kit, as the Board uses). Reordering by keyboard comes later.
- **Overflow:** tabs shrink to 96 px, the selected one last. Past that the strip scrolls sideways and fades at the hidden edge, as the
  Board's sides do (`use-hidden-edges.ts`, `edge-fade.tsx`).
- **All Tabs** (`chevron-down`) sits right of `+`. It opens a menu of every open tab (tile, title and state) and the
  last five closed. When hidden tabs need the builder, it carries a `CountBadge` of them **(call)**, so scrolling
  never hides "needs you".
- **The next tab that needs you:** ⌘J selects it, cycling through the tabs with a ring in strip order. A click
  on the Sessions badge in the sidebar does the same from any view.
- **Close Finished Tabs** in a tab's menu closes every tab marked Done, and every In review tab of a Separate copy.
  It **skips any pass that is still open**, Signed off included, and any closed pass whose branch hasn't moved yet,
  so a pass that still needs Close Pass…, or holds the folder, never leaves the strip by this. Nothing closed is lost:
  each stays in Recent and ⌘K.
- **No cap on tabs (call).** A Chat costs nothing while idle. The design spec keeps at most four idle warm explore
  sessions and closes the oldest silently (§6.4 there); it wakes on its next message.

### 5.6 Close, archive, reopen

| Action | What happens | Undo |
| --- | --- | --- |
| **Close** (× or ⌘W) | The tab leaves the strip. Nothing stops: a running turn finishes and keeps its reply, and a Task keeps working on the Board. No confirmation, because nothing is lost **(call)**. | ⌘⇧T reopens the last closed tab; All Tabs lists the last five; ⌘K finds any. |
| **Archive** (a Chat's menu) | Closes the tab, hides it from Recent and removes its folder on disk (design spec §7.1). It is refused while a Task the Chat started is unfinished: "Finish or abandon its task first." Archiving a session that is in your terminal asks "End takeover and archive?" | Opening it from ⌘K unarchives it. |
| **Do It, a Separate copy** | The Chat becomes read-only and its tab closes; the Task takes its place (§8.2). | The Task's "From chat" link, ⌘⇧T and ⌘K open the read-only Chat again. |
| **Do It, Your folder** | The pass opens in a new tab beside the Chat. The Chat stays open (§8.2). | — |
| **A Task** | Has no Archive. It ends as a task ends: by landing, or by Abandon Pass… (Your folder) or Abandon on the Board (a Separate copy). | As the Workbench and the Board do. |

After a close, focus moves to the tab on the right, or to the left one when the closed tab was last.

### 5.7 "Needs you" mirrors the Inbox and is never a second queue

- A tab is yellow **only** when an Inbox item names its conversation (design spec S13). The tab reads the Inbox
  query and stores nothing of its own.
- Answering in the tab answers the Inbox card, through the same endpoint. Answering in the Inbox clears the tab.
- The Inbox card names its session: the project label, the kind badge, the title, and an **Open Session** link that
  selects the tab with the cursor in its composer. **When the tab is closed, Open Session reopens it** where it
  was.
- **A ready Task in Your folder is a `check` card**, as a ready Workbench page is. It counts in the badges and
  raises a notification. Its notification says "Retry login on a 401 is ready", and a click opens the tab. The
  Inbox's pass row lists it with **Open Session**, not Open UI Workbench **(call)**.
- **A Chat's reply is not a card.** While the window is unfocused, it raises one notification, "Compare ACP
  adapters replied", with the reply's first line **(call)**. With the window focused the bold title says it. A
  notification never fires for the tab in view (design spec §8). Settings › General gets "Notify when a chat
  replies", on by default.

### 5.8 Keyboard

| Keys | Does | Where |
| --- | --- | --- |
| ⌘T | New session in the selected project | anywhere; opens Sessions |
| ⌘W | Close the tab | Sessions |
| ⌘⇧T | Reopen the last closed tab | Sessions |
| ⌘1 … ⌘8 | Go to tab 1 to 8 | Sessions |
| ⌘9 | Go to the last tab | Sessions |
| ⌘⇧[ and ⌘⇧], or ⌃⇧Tab and ⌃Tab | Previous and next tab | Sessions |
| ⌘J | The next tab that needs you (a ring) | Sessions; the sidebar badge's click does it from anywhere |
| ⌘K | Spotlight: open tabs, recent sessions, actions (design spec M8) | anywhere |
| ⌘↩ | Send (in the composer) | a tab |
| ⌘⇧↩ | Do It… (opens the modal; never acts by itself) | a Chat |
| ⌘⇧D | Show or hide Changes | a Task |
| Esc | Stop the turn, unless a menu, modal, select or waiting card owns Esc (`escapeIsTaken`) | a tab |
| ← → on a focused tab, then Enter | Move between tabs, then select one | the strip |
| Delete on a focused tab | Close it | the strip |

- **⌘N stays free** for a new window, its macOS meaning.
- **⌘W must beat the window's Close** on Sessions (a live check, §20).
- **Spotlight** (`@mantine/spotlight`) has three groups:
  - **Open Tabs**, with state dots
  - **Recent**, from every project, newest first, with the project tile on each
  - **Actions**: New Session in ampsio, Open in Terminal, Do It…, Go to Inbox

  It searches titles and the first message. An archived match shows under **Archived**.

## 6. A new session

### 6.1 What is asked before the first message

Every session starts as a Chat (design spec S2). A fresh tab asks for two things, and both have defaults, so the
fastest start is ⌘T, type, ⌘↩.

| Control | Choices | Default | After the first send |
| --- | --- | --- | --- |
| **Project** | every project (a combobox like the switcher, with "Find a project"). Changing it changes the selected project. | the selected project | fixed |
| **Model** | any model the project's account offers, grouped by tier, as Plan's picker is | the model the `plan` role resolves to (design spec §7.1) | changes between turns, when `modelSwitch` is `next_turn` |

- **The agent is not a choice.** It is the project's account's harness, shown as `capabilities.label` beside the
  model ("Claude Code · opus"). A different agent means a different project account, which is not offered (design
  spec §6.4).
- Under the controls, one dimmed `xs` line: "Uses ampsio's account. Reads the code, runs commands and searches the
  web. Asks before anything that crosses a limit."

### 6.2 The empty state of a fresh tab

The empty state is the start of the work, not a blank page with a button.

```
                 A chat works in ampsio's folder. For bigger work, Do It hands it to a task.

                 [AM ampsio ⌄]   Claude Code · opus ⌄
                 Uses ampsio's account. Reads the code, runs commands and searches the web.
                 Asks before anything that crosses a limit.
                 ┌──────────────────────────────────────────────────────────┐
                 │ Ask about ampsio…                                        │
                 │ 📎                                                 Send  │
                 └──────────────────────────────────────────────────────────┘
                 ⌘↩ sends · / commands · @ files

                 Start from
                 (!) Why did “Retry export on timeout” fail?
                 (o) What changed on main since yesterday?
                 [ ] How does billing/export work?

                 Recent
                 ● Retry login on a 401           Task · Your folder · 20 min ago · ready
                 ▣ Invoice export             Chat · 2 h ago · in your terminal
                 🔒 Login fails after sleep        Chat · yesterday · read-only, 1 task started
                 Find a Session  ⌘K
```

- **The column sits in the upper third,** not dead centre, so the composer is where the eye lands after the strip.
- **"Start from"** holds at most three suggestions built by rules from the project's state, not by a model
  **(call)**. Each is a `subtle` `xs` button whose Tabler icon names its source:
  - `alert-circle`, a failed task: "Why did … fail?"
  - `git-commit`, new commits on the base: "What changed on main since yesterday?"
  - `folder`, the most recently changed area: "How does … work?"

  A click puts the text in the composer and sends nothing. They are not DESIGN.md's nudges: a nudge is a model's
  suggestion, at most two, with `sparkles` and an ×, and these come from rules, so they carry no sparkles and no ×.
  Nothing shows when no rule has anything.
- **"Recent"** is the chosen project's last six sessions. Each row has a state mark only when there is a state, then
  the title, the kind, when, and what it produced ("2 tasks filed", "landed as a1b2c3d"). One click opens it in this
  tab. It follows the Project control and shows nothing when there are none.
- **With no tabs open,** Sessions opens a fresh tab. The screen is never empty.

## 7. The conversation

### 7.1 Messages

- **The builder's message** sits on a `bg_1` panel the width of the column, radius `md`, padding 10 × 12. Pictures
  show inside it as thumbnails (120 px tall; click for full size), and `@` mentions as mono chips. This is the
  Workbench's message (`thread-message.tsx`).
- **The agent's reply** is plain text on `bg_0`, rendered as markdown (§7.2). It has no bubble.
- **No visible speaker labels (call).** With two speakers, the panel says which is which, and the agent is named
  in the session bar. Plan's "You" and "Claude" labels go, which also removes Plan's hard-coded "Claude". Each
  message is still an `article` with a visually hidden heading, "You" or "{label}", so a screen reader knows who
  speaks (§13.1).
- **The `bg_1` fill is the builder's alone.** Code blocks, command output, the read-only line and the takeover
  banner sit on `bg_0` with a 1 px `bg_2` border, so a raised panel always means "you said this". Queued chips are
  builder messages too, so they keep the fill.
- **Rhythm:**
  - 20 px above each builder message
  - 12 px between reply paragraphs
  - 2 px between consecutive tool rows, and 8 px above and below a group of them
- **Copy:** hovering a reply shows a `copy` icon button at its top right, and every code block has one too.
- **A partial reply** (a turn that ended early, design spec S9) keeps what streamed and ends with one dimmed line:
  "Stopped here."
- **A Task in Your folder** ends each turn with one dimmed `xs` line: "Turn 3 · 2 min · 3 files changed · Check
  passed". A passing check lives only in that line. A failing one adds a notice above it: "Check failed: 2 errors in
  `client.ts`", with **Send to Agent** (Workbench §8.1, advice only). A Chat's turn ends with nothing.
- **A model change** between turns leaves one dimmed divider where the next turn starts: "Now on {label} ·
  {model}".

### 7.2 Markdown

Agent output goes through one `Markdown` component over streamdown, configured as design spec S10 and §11 say: raw
HTML skipped, no remote or data images, `https:` links only, each opened after a confirm.

| Element | Drawn as |
| --- | --- |
| Paragraph | `Text` sm, line height 1.6, `fg_0` |
| h1 / h2 / h3 | 17 / 15 / 14 px, weight 600, `fg_1`, with more space above than below |
| Lists | `List` sm, 4 px between items |
| Inline code | `Code`, mono 13 px |
| Code fence | `CodeHighlight` on `bg_0` with a 1 px `bg_2` border, with a **Selenized Shiki theme** (light and dark, built from the accents, since no stock theme is Selenized), a language label and Copy |
| Link | `Anchor` in blue; a click asks "Open {host} in your browser?" first |
| Table | `Table` sm, hairline `bg_2` rules, no stripes |
| Blockquote | `dim_0` text with a 2 px `bg_2` rule at its left |
| Image | never fetched: a dimmed line, "Image not shown: {alt}" |

### 7.3 Tool calls: rows, not cards

An agent's turn is mostly tool calls. They are **one-line rows** that open on demand, so the reply stays the story
**(call)**. Each row is a `ToolCallView` (design spec §5.2) and is 28 px tall:

```
 [icon 16]  verb  target (mono)                                     meta (dimmed)   ›
```

- **`status`** shows on the icon:
  - `running`: a blue 8 px dot in the icon's place
  - `done`: the kind's icon, dimmed
  - `failed`: the icon in red, and the meta in red
  - `denied`, by `deniedBy` (design spec §5.2):
    - `builder`: dimmed, "You denied this"
    - `10db`: dimmed, "10db stopped this: {reason}", when the guard refused it (a coordination rule, such as "Your
      folder is in use by {holder}", or the `rules` floor)
    - `judge`: dimmed, "Held back: this would {limit}", or "Held back at a limit" when the judge named none. In an attended session (a Chat, Plan, a pass) the row has
      **Allow This**, which sends the builder's go-ahead as their own message, so the judge lets the call through
      on the agent's retry (trust line §5). The row says "You allowed this" once pressed.
- **The row is a button** with `aria-expanded`. Its name says the whole row: "Ran pnpm vitest run src/api, failed,
  exit 1, 9 seconds".
- **Full output and patches** come from disk when a row opens (`GET /conversations/:id/items/:itemId/full`).
- **Nesting:** a call with a `parentId` sits under its subagent's row, 16 px in, with a hairline `bg_2` rule at its
  left.

| Kind | Collapsed row | Opened |
| --- | --- | --- |
| `read`, `search` | grouped (below) | the list, one call per line: `path` (with `range`), or `pattern` with `matchCount` |
| `command` | `$ {command}` · "9 s", or "exit 1 · 9 s" in red from `exitCode` | `outputTail`, mono on `bg_0` with a 1 px `bg_2` border, at most 320 px tall, kept at its tail while it streams. When `outputBytes` is larger: "Showing the last 4 KB of 212 KB · Show All Output". **A failed command opens by itself** to its last 8 lines **(call)**. |
| `edit` | `pencil` "Edited `{path}`" · "+{addedLines} −{removedLines}"; "Created", "Deleted" or "Moved … to {movePath}" by `change`. Consecutive edits fold (below). | **A peek shows** under a lone edit, or under the last edit of a folded group: the first hunk, at most 8 lines **(call)**. Show Full Diff lists every hunk. When `truncated`: "Cut at 1,500 changed lines · Open Full Patch". |
| `mcp` | `plug` "{server} · {tool}" and `argumentsPreview` on one line | `argumentsPreview` and `resultTail`, or `error` in red |
| the chat's builder tools | a **task row** (below) | not expandable |
| `subagent` | `hierarchy` "Subagent: {promptPreview}" · "{n} calls · 1 min", with `model` when set | its rows nested; its final text at the end. While it runs, its latest call is a live line. |
| `web` | `world` "Searched the web for ‘{query}’" or "Fetched {host}" | grouped like reads when consecutive. It shows in every session: the web is on (design spec §7.1). |
| `other` | `tool` "Used {name}" and `inputPreview` | `inputPreview` |

**Diffs, per hunk** (design spec S12, §8). Each hunk is one Mantine `Diff` of its `before` and `after`, with
`withLineNumbers={false}`, because `Diff` numbers every hunk from 1. 10db draws its own one-column gutter:

- context and added lines are numbered from `newStart`
- removed lines are numbered from `oldStart`
- a dimmed hunk line, "@@ −{oldStart},{oldLines} +{newStart},{newLines} @@", heads each hunk after the first

**Diff colors are Selenized exactly (call).** Tinted backgrounds are out, since the decision forbids mixing. An added
line is green text on `bg_1` with a green "+", a removed line is red text on `bg_1` with a red "−", context is `fg_0`
on `bg_0`, and a changed word sits on `bg_2`. It reads as `git diff` in a Selenized terminal. `Diff`'s `--diff-*`
variables take these values.

**Grouping small reads (call).** Consecutive `read` and `search` calls fold into one row while nothing else comes
between them: "Read 5 files, searched 2 times". While the group is live it reads "Reading `src/router.tsx`" and
counts up. Reply text, an edit or a command ends the group. A group of one is a plain row.

**Folding edits.** Consecutive `edit` calls fold the same way: "Edited 5 files · +40 −12". Opened, the group lists
each file with its counts. Only the last edit of the group keeps its peek, so a turn that touches many files stays a
few lines long. Reply text, a read or a command ends the group.

**Task rows: the chat's builder tools** (design spec S14, §6.6). Every builder tool is present, and none raises a
card unless the judge holds it back.

- `create_task`, `edit_task`, `set_title` and `write_brief` run. Each shows as a row with **Undo**:
  - a task: a gray dot, its title, "Added to Ready", Open on Board, Undo
  - an edit: its title, "Changed {fields}", Open on Board, Undo
  - a title: "Renamed this session to ‘…’", Undo
- Undo removes an unstarted task through the existing route, puts back an edit's old values, or restores the title.
- `start_task`, `run_next`, `move_task`, `start_shape`, `save_decision` and `save_principle` run. Each row links what
  it started or changed: "Started {task}" with Open on Board.
- `remove_task` runs on a task this Chat made. On any other task, and for `retire_knowledge`, `withdraw_knowledge`
  and `supersede_knowledge` every time, the tool asks with a card (§7.7): removing or retiring work the Chat didn't
  make is a limit (design spec §6.6).
- **Git** goes through the Chat's git tools (design spec §7.3): `make_branch`, `switch_branch`, `pull`,
  `commit_changes`, `push_branch`, `open_pull_request` and `merge_pull_request`. Each is a row: "Made branch
  `{branch}`", "Switched to `{branch}`", "Pulled {n} commits", "Committed `{sha}` · {n} files", "Pushed
  `{branch}`", "Opened pull request #{n}" with Open Pull Request, "Merged #{n}". A push is judged, and a merge is a
  limit, so either can be held back with Allow This. Any git write in the Chat's shell shows as "10db stopped this:
  use the git tools (make_branch, switch_branch, pull, commit_changes, push_branch, open_pull_request,
  merge_pull_request)". The project's own git hooks don't run on these commits and pushes (design spec §7.3).
- Reads and lists (knowledge search, `list_tasks`, `list_flows` and the rest) are plain `mcp` rows.

**Before M9** (design spec §6.9, M4c). A Task's thread goes through the shared stores, so its replies stream and
render as markdown. Its tool rows show the calls the runner stores as `tool_call` items. Where it stores none, the
live line and Show Log carry the turn, as in the UI Workbench today.

### 7.4 Streaming

- Reply text appears as it streams (design spec S9). Streamdown re-renders only the last block.
- **No caret, no blinking cursor.** The working line says "Writing…".
- The list follows the tail unless the builder has scrolled up by more than 120 px (Plan's rule). Then a **Jump to
  Latest** button floats at the foot of the transcript, with an `arrow-down` icon.
- The transcript is `aria-busy` while a reply streams. The announcer speaks the finished reply's first sentence,
  never tokens (§13).
- **A background tab** keeps its buffer and renders nothing until it is shown (design spec §6.5).

### 7.5 The working line

One line pinned under the transcript, outside the windowed list, so it never scrolls away. It is the Workbench's
line, made shared: a static blue dot, then what the turn is doing.

| Situation | Line |
| --- | --- |
| A turn runs | "Working · 12 s" (seconds under a minute, then minutes) |
| …using a tool | "Working · 3 min · editing `api/client.ts`" (the verb table in `live-line.ts`) |
| …thinking | "Thinking…" |
| …writing the reply | "Writing…" |
| A Task's turn | a second line: "2 files changed so far · Show Log" |
| Waiting on a card | "Waiting for your answer" (no dot; the card sits just below the line) |
| Starting from cold (`idle_cold` to `starting`) | "Waking up the session…" |
| The agent's pinned copy is downloading | "Waiting for Codex 0.167.0 to download" |
| A Task in a Separate copy | its run's step, as Factory says it: "Implement 2/4 · sonnet" |
| Paused (`paused_account`) | the orange pause icon and "Paused: usage limit, resumes 3:40". No card is raised (design spec §6.4). |

It is not a live region and is never announced as it ticks (Workbench spec §4.6).

**The agent's plan** (capability `plan`; the `plan_update` event) sits in one collapsed row just above the working
line: "Plan · 3 of 7 done · Now: update the tests". Opened, it is a checklist. The transcript gets one row the first
time a plan appears ("Made a plan · 7 steps"), not one per update **(call)**.

### 7.6 Thinking

With capability `reasoning`, a `reasoning` item is a collapsed row in the flow: `brain` "Thought for 12 s",
dimmed. Opened, it shows the summary in `dim_0` text, with a 2 px `bg_2` rule at its left. **It stays collapsed even
while it streams (call):** the working line already says "Thinking…", and reasoning that unfolds and refolds would
make the column jump.

### 7.7 Cards: permissions and questions

They are the Inbox's own cards, answered in place: the same objects the Inbox shows (design spec S13), drawn by
`InboxCard` through `PageAsk`.

**What raises a card** (trust line §5): a call the judge escalates, a call 10db's judge asks about, and the agent's
own question. Nothing else does: a call that crosses no limit runs, and one auto mode holds back is a dim row with
Allow This (§7.3).

- **Where:** pinned between the working line and the composer, outside the windowed list, at most half the pane's
  height, scrolling inside (Plan's `WaitingPermissions`). They never scroll away, and they sit next to where the
  builder types.
- **What a card holds:**
  - the yellow kind badge ("Permission", "Question")
  - the title, in the daemon's words ("Run a command")
  - the body (a command in a `Code` block)
  - the options, with the recommended one picked
  - "Note for the agent (optional)"
  - **Send Answer**, the card's filled primary
  - one dimmed `xs` line at its foot: "Also in your Inbox."
- **A session's permission options** are the trust line's three (§5 there): "Allow once", "Always in this project"
  and "Deny". Always in this project stores a grant keyed on the limit and its target in prose ("deploys to staging
  with vercel"), which every judge on the project then gets as an allow line. The trust line's T5 builds the grants
  store and this option, and gives the grants to every judge (design spec §6.6).
- **A question** shows its options with their descriptions, and a free answer goes in the note. A multi-select
  question shows checkboxes.
- **Focus never jumps (call).** ⇧Tab from the composer reaches the card, which sits just above it in the DOM.
  Inside the card, 1–5 pick an option and ⌘↩ sends, as in the Inbox. **Esc inside a card** (its note, an option)
  never stops the turn: `escapeIsTaken` counts focus inside a waiting card as taken, as it counts an open menu. The announcer says "Codex asks to run a
  command. Answer it above the message box."
- **History:** once answered, the transcript gets one dimmed row where the call was: "You allowed this once", "You
  allowed this in the project", "You answered: Retry once, then sign out".
- **The composer stays open** while a card waits. What the builder types goes in with the turn, as §7.8 says.

### 7.8 Messages while a turn runs, and after a restart

The composer says what ⌘↩ will do before Send (design spec §6.3), read from `steer`.

**`steer: 'inject'`** (Claude and Codex): ⌘↩ adds the message to the running turn **(call)**.

- The placeholder says "Add to this turn…", the Workbench's words, and the hint line says "⌘↩ adds to this turn".
- The message shows in the transcript at once, on its panel, with one dimmed line under it: "Waiting for {label} to
  read it". The line clears when the receipt arrives (`receipts`).
- Until then the message stays at the end of the transcript, below whatever still streams. Once it is read, it stays
  where it was read, and the agent's output continues under it.

**`steer: 'queue'`** (a future ACP agent, §11): ⌘↩ queues the message for the next turn.

- The placeholder says "Queue for the next turn…".
- Queued messages wait as chips stacked above the composer, not in the transcript. Each chip has **Edit** (back into
  the composer) and **Remove**. When the turn ends, the first one sends.

**Stop and Redo** (the Workbench's table, `composer-buttons.ts`). While a turn works and the composer is empty, the
`default` button is **Stop**. Once there is text it reads **Stop and Redo**, which stops the turn and sends the text
as the next one. Esc is Stop.

**After a daemon restart** (design spec §6.4). Nothing spends tokens unattended, so messages that were queued, or
pushed and never seen taken, wait in the transcript under one line: "These waited through a restart. Nothing was
sent." with **Send Now** (`POST /conversations/:id/send-now`). A turn that was running shows its partial text,
"Stopped here." The same line appears when an account was paused across a restart.

**Departure from T5.** Zed and Cursor queue by default and send at once on a double Enter. 10db injects by default:
the Workbench already does it, both native adapters carry receipts, and a double Enter fights ⌘↩ and IME.

### 7.9 Pictures, `@` and `/`

- **Pictures** (capability `images`: png, jpeg, webp): paste, drop, or **Attach**. Bytes are checked as Plan
  checks them. Pictures wait as 56 px thumbnails above the input, each with Remove. A type outside `images` is
  refused under the input, in words.
- **`@` mentions** (Mantine `Mentions`, design spec S11). The list is the files of the session's checkout, from
  `GET /projects/:id/files` (`git ls-files`), fuzzy, showing 8 of the daemon's 50, with an 80 ms debounce.
  - A suggestion shows the `file` icon, the name in `fg_1` with the match underlined, and the folder in dimmed mono.
  - Enter or Tab picks one. The send key never fires while the list is open.
  - A picked file becomes a mono chip and reaches the agent as a path. The session's judge decides each read
    (design spec §11).
- **`/` commands** (capability `slashCommands`; the `commands` event). Typed at the start of the input, a menu
  lists what the session's agent reports:
  - Claude: `supportedCommands()`
  - Codex: the mapped list, `/compact`, `/review` and `/model`

  Each row is `/name` in mono, its description dimmed, and its `argumentHint`. Picking one inserts it, and ⌘↩ sends.
  An unknown `/x` goes as text. The builder's setup comes along (design spec §7.1, trust line §6), so the list
  holds the builder's skills and plugins' commands and the project's own `.claude/skills` and `commands`, as Claude
  Code lists them. Codex lists the skills in the roots `skills/extraRoots/set` names.
- **10db's own actions are never slash commands (call).** Do It, File as Tasks, Open in Terminal and New Session are
  buttons and ⌘K, so typing `/` never starts work by surprise.

### 7.10 Context meter and model

- **Context meter** (`ConversationDto.contextPct`): Factory's `ContextGauge`, 40 px wide, with the percent in `xs`
  mono.
  - The tooltip: "41% of the context used. Past 70%, the next turn continues in a fresh session with a summary."
  - With `costUsd`, the tooltip adds the session's cost: "$0.42 so far".
  - **The bar stays blue (call):** a full context is not a status.
- **The fresh session** is a divider across the column: "Continued in a fresh session. Nothing is lost." (design
  spec §6.4), with Show Summary under it, which opens the `digest` item.
- **Model control:** a `subtle` button, "Claude Code · opus ⌄".
  - It opens Plan's `ModelPicker`, grouped by tier.
  - While a turn runs, it is disabled with "Change the model between turns".
  - With `modelSwitch: 'none'` it is plain text with no chevron.
  - A model the account no longer offers stays in the list as "(not offered)".

### 7.11 The composer

One frame, `bg_1`, radius `md`. The textarea is on top, and a bar inside the same frame sits below it: Attach at its
left; Stop or Stop and Redo, then Send or Sign Off, at its right. A hint line under the frame says "⌘↩ sends · Esc
stops · / commands · @ files"; it is hidden under 640 px.

- **⌘↩ sends, and Enter is a new line,** in Sessions, Plan and the UI Workbench alike (design spec §8; the call is
  adopted).
- The textarea autosizes from 2 to 10 rows. The draft survives a tab switch and a restart (the Workbench's
  `drafts.ts`).

## 8. Do It: from a Chat to a Task

A Chat does small work itself, in Your folder (§0). Do It is for work that wants its own copy, a brief and the
project's delivery, or the pass's ceremony.

### 8.1 The modal

**Do It…** sits in the session bar as a `SplitButton`, whose menu holds **File as Tasks**. ⌘⇧↩ opens it too. It
opens a centred form modal (DESIGN.md "Modals"), 560 px wide:

```
┌ Do It ───────────────────────────────────────────────────────┐
│ Title                                                        │
│ [Retry login once on a 401 after the token refresh        ]  │
│ Brief · written by Claude Code from this chat; edit freely    │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ When the laptop wakes, the first API call returns 401…   │ │
│ └──────────────────────────────────────────────────────────┘ │
│ Where   [ Separate copy | Your folder, as a pass ]           │
│         An ordinary task in its own copy, on a new branch.   │
│         It lands by ampsio's delivery: the gate, a review,   │
│         and a pull request.                                  │
│         7 files already changed in your folder:              │
│           M src/api/client.ts            M src/api/refresh.ts │
│           ? docs/notes.md   … Show 4 More                    │
│         These stay in your folder. The task starts without   │
│         them.                                                │
│                                                              │
│ The task takes this chat's place. The chat becomes read-only.│
│                                              Cancel  [Do It] │
└──────────────────────────────────────────────────────────────┘
```

- **The brief** is written by the chat's agent when the modal opens (design spec §7.3; the call is adopted). A short
  turn calls `write_brief`, and the brief streams into the field under "Writing the brief…". Typing in the
  field stops it. If the agent is unavailable or takes more than 60 seconds, the brief is the chat's digest plus the
  builder's last message, and a dimmed line says so.
- **Where** is the Board's `PlacementChoice`, in the Board's words, with **Separate copy** picked by default
  **(call)**. Your folder, as a pass, is the option for work that wants the pass's ceremony. Each choice's line says
  where it works and **how it lands, before it starts**:
  - **Separate copy:** "An ordinary task in its own copy, on a new branch. It lands by ampsio's delivery: the gate,
    a review, and a pull request."
  - **Your folder, as a pass:** "A pass of one on its own branch from `main`. Sign Off lands each turn's work; Close
    Pass… opens one pull request, and `main` fast-forwards to it when it merges. Your folder is held until then." On
    a `local` project the last sentence reads "`main` fast-forwards to it when the pass closes."
  - **Uncommitted files** (design spec §7.4). The sheet **lists them**: "7 files already changed in your folder:",
    then each path in mono with its git status letter, then what happens to them, by place:
    - Separate copy: "These stay in your folder. The task starts without them."
    - Your folder: "These will be part of this task's work."

    The list shows five paths and folds the rest behind **Show 4 More**. The builder can cancel and commit them
    first; nothing from before joins or stays behind unseen.
  - **Refused** (Your folder): the choice stays in the list, disabled, with its reason and a link (DESIGN.md), and
    Separate copy stays picked:
    - "Your folder is in use by the UI Workbench pass ‘Settings pass’." with Open UI Workbench
    - "A merge is in progress in your folder.", and the same for a rebase or a bisect
    - any other reason the folder refuses a pass today, in the daemon's words
- **The agent and model** are the chat's, shown as one dimmed line. The account cannot change (design spec §6.4).
- **A running turn** stops when the task starts, and keeps what it streamed. The modal says so above the buttons:
  "The turn that's running stops first."
- **The footer line** says what happens to this Chat, by place:
  - Separate copy: "The task takes this chat's place. The chat becomes read-only."
  - Your folder: "The pass opens in its own tab. This chat stays open, and changes nothing while the pass holds
    your folder."
- **Do It** is the filled primary, and ⌘↩ in the modal presses it. It is enabled once the brief has text, so it
  can be pressed while the brief still streams.
- **A refusal at submit** (the folder changed since the modal opened) shows beside the button, in red, in the
  daemon's words, as DESIGN.md's Forms rule puts a submit's error. The modal stays open with its brief.
- **While the Chat is in your terminal,** Do It… is disabled, with the tooltip "Hand back first" (design spec
  §6.7).

### 8.2 Where the Task opens

**A Separate copy takes the Chat's place.** Adopted in design spec §7.3, from the design review.

- **The Task takes the Chat's place in the strip** and takes focus. Its transcript opens with a dimmed link row,
  "From chat: Login fails after sleep", and then the brief as the builder's first message.
- **The Chat becomes read-only** (`sealed`), and its tab closes. The strip doesn't fill twice as fast.
- **The read-only Chat stays reachable** from the Task's "From chat" link, ⌘⇧T and ⌘K. Opened, it shows:
  - its transcript, with one row at its end: "Started a task: Retry login on a 401 · Separate copy · Open"
  - in the composer's place, one line on `bg_0` with a 1 px `bg_2` border: "This chat handed its work to **Retry
    login on a 401**. It's read-only now.", with **Open Task** and **New Chat From This**
  - a session bar without Open in Terminal or Do It…; its `⋯` menu keeps Rename and Archive, and Archive is refused
    until the task is finished (§5.6)
- **New Chat From This** opens a fresh Chat in the read-only one's place, seeded with its digest as the first
  message's context. It never resumes the sealed session, so the design spec's §6.7 holds: one writer per agent
  session.
- **Why the Chat doesn't stay as a tab:** the Task is a different agent session with its own memory, place and end,
  and the builder can keep talking through New Chat From This.

**A pass of one opens beside the Chat** (design spec S15). The Chat is not sealed.

- The pass opens in a new tab to the Chat's right and takes focus. Its transcript opens with the "From chat" link
  row and the brief, as above.
- The Chat keeps its tab and its composer. Its transcript gets one row: "Started a pass: Retry login on a 401 · Your
  folder · Open".
- While the pass holds the folder, the Chat's kind line reads "Chat · reads only: Your folder is in use by the pass
  ‘Retry login on a 401’". Its turns still run and answer, and change nothing (design spec §7.3).
- When the pass closes or is abandoned, the Chat writes in Your folder again.

### 8.3 File as Tasks

The split button's menu item is a prompt shortcut (design spec §7.2). It sends a fixed message, visible in the
transcript as the builder's turn: "File the work we agreed on as tasks on the Board." The agent calls `create_task`
on the chat's builder server, and each call renders as a task row with Open on Board and Undo (§7.3). The chat stays
a Chat.

### 8.4 What the builder sees of a Task

| | Your folder (a pass of one, optional, design spec S15) | Separate copy (a Board task, design spec S16) |
| --- | --- | --- |
| Tab glyph | `folder` | `git-branch` |
| Session bar | "Task · Your folder · lands on `main`" | "Task · Separate copy · `10db/retry-401`" |
| While it works | the working line with "2 files changed so far · Show Log" | the run's step: "Implement 2/4 · sonnet", and Show Log |
| Messages | reach the running turn, or start the next one: the pass stays warm between turns | reach the lane while it runs. Between runs the composer is disabled: "Messages reach this task while it runs." It does not stay warm between turns until M9. |
| Each turn's check | in the turn's footer when it passes ("… · Check passed"); a notice when it fails: "Check failed: 2 errors in `client.ts`", with **Send to Agent** (Workbench §8.1, advice only) | none per turn; the gate runs at delivery |
| Ready | a yellow ring and a `check` card (§5.7) | not used: the Board's own cards, such as a review that needs the builder, show as "needs you" |
| Failed | a red ring and the alert icon; Retry Turn under the failure line, in `failureLine`'s words | a red ring and the alert icon; the failure line, with **Open on Board**, where Retry lives |
| Changes | the Changes panel (§9) | the Changes panel (§9) |
| Its other home | the UI Workbench lists it with the other passes, and its one page reads "Whole project" (design spec §7.3) | the Board: In progress, with "Open Session" in its drawer |
| Its Chat | stays open beside it, and changes nothing while the pass holds the folder | read-only, reached from "From chat" |
| In your terminal | the banner adds "Your folder stays held." | the banner adds "Its claims stay held." |

### 8.5 Landing

**A Task in Your folder lands as a pass lands** (design spec §7.3, the fast-forward decision), word for word:

- **Ready, nothing typed:** **Sign Off** is the composer's filled primary, and Send is hidden (Workbench D14). Its
  tooltip carries the hint line's words, "Sign Off lands this turn on the pass's branch. Close Pass… opens the pull
  request.", since the hint hides under 640 px.
- **Ready, something typed:** **Send** is filled, and Sign Off turns `default`.
- **Sign Off** lands the turn's work as one commit on the pass's branch: "Signed off · landed as `a1b2c3d` · 3
  files". A message afterwards reopens the page and starts another turn.
- **Close Pass…** shows in the session bar once something is signed off. It opens the pass's own close modal. The
  close then shows its progress lines at the foot of the transcript:
  - "Running the gate in your folder…"
  - "Pushing…"
  - "Closing the pass…"
- **Signed off, nothing working:** the tab shows the dimmed check, spoken "signed off: close the pass to land it".
  **Close Pass…** becomes the session bar's filled primary, since nothing lands and the folder stays held until it
  runs (§5.3).
- **After the close:** "Closed · pull request #212 opened. `main` fast-forwards to it when it merges." The tab shows
  the In review glyph. Once the branch has moved: "Done · `main` is at `a1b2c3d`.", with the green check. A move that
  cannot be a fast-forward is never forced; its card gives the command (the decision).
- **Abandon Pass…** sits in the `⋯` menu, with the pass's confirm.
- **Keeping going:** a message after a sign-off reopens the page and starts another turn, as in a pass (design spec
  §7.3).

**A Task in a Separate copy lands by the project's delivery** (design spec S16). It has no Sign Off.

- While the run goes on, the session bar shows its Board state: In progress, In review, or Failed.
- **When it finishes,** the composer gives way to one line, "Finished · in review: pull request #212 · CI running",
  with **Open on Board** and **Open Pull Request**. The tab shows the In review glyph.
- When the pull request merges: "Done · merged as `a1b2c3d`.", with the green check.
- A failed run says what happened in `failureLine`'s words, with **Open on Board**, where Retry lives.

## 9. The Changes panel (a Task only)

- **When it shows:** never on a Chat. A Chat's edits show as edit rows with their diffs (§7.3), and Your folder's
  uncommitted work is git's, as in a terminal. On a Task, **Changes** in the session bar reads "Changes +41 −6" once anything
  has changed, and ⌘⇧D toggles it. It **opens by itself once,** the first time a turn ends with changes, and only
  when the window is at least 1100 px wide **(call)**. After that the builder's choice holds for the tab.
- **What it reads:**
  - Your folder: the pass's branch and its kept work against the pass's start.
  - A Separate copy: the task's branch against its base.

  It reads `GET /workstreams/:id/changes`, the route the builder's check card already uses (design spec §7.3).
- **Layout:** a pane on the right of the conversation, 44% of the width by default, resizable between 360 px and 60%.
  The conversation's column re-centres in what is left.

```
┌ Changes ─────────────────────────────── 3 files  +41 −6   × ┐
│ against main at 4e1a9c2          [ All Turns | Last Turn ]  │
│ ✓ Check passed · typecheck, vitest · 41 s                    │
│ M  src/api/client.ts                              +14 −3     │
│ M  src/api/client.test.ts                         +25 −0     │
│ M  src/api/refresh.ts                              +2 −3     │
├──────────────────────────────────────────────────────────────┤
│ src/api/client.ts                                            │
│  42 − if (res.status === 401) {                              │
│  42 + if (res.status === 401 && req.retried) {               │
│  …                                                           │
└──────────────────────────────────────────────────────────────┘
```

- **Header:** "Changes", the file count and +/−, and the base: "against `main` at `4e1a9c2`".
  - A pass of one adds **All Turns · Last Turn**, read from each turn's kept commit (Workbench §9.1).
  - The latest check line sits under it, with Send to Agent when the check failed.
- **The file list** is a jump index. Each row has a status letter (M, A, D, R) in dimmed mono, the path truncated
  from the start, and +/− at the right. The list folds to one line once the diffs are scrolled.
- **The diffs** are one scrolling list of every file, each under a sticky file header, as a pull request's "Files
  changed" reads. Each hunk is drawn as §7.3 says: `Diff` with `withLineNumbers={false}`, and 10db's gutter from
  `oldStart` and `newStart`. They are unified, or split once the panel is 720 px or wider.
- **Quote a line (call):** clicking a line number puts `@src/api/client.ts:42` and the line, as a quote, into the
  composer. It is the cheap half of "line comments go back to the agent", without review threads.
- **Empty:** "No changes yet."

## 10. Open in Terminal and Hand Back

### 10.1 Opening

Open in Terminal is the `terminal-2` icon button in the session bar, with the tooltip "Open in Terminal". It is also
in the tab's menu and the `⋯` menu. It shows only with `takeover` (§11) and never on a read-only Chat.

It opens a **popover anchored to the button**, not a modal:

> **Open in Terminal**
> Continues this session in Terminal with Claude Code's own resume, in ~/Projects/ampsio. It runs outside 10db's
> sandbox, with this session's instructions, plugins and MCP servers, and without your settings file. 10db won't
> touch this session until you hand it back.
> **[Open in Terminal]** Cancel

- **It warns every time (call),** in one short popover. The sandbox is why 10db exists, and Enter confirms, so the
  warning costs one key.
- **Refused,** with the button disabled and the reason as its tooltip (design spec §6.7):
  - no agent session yet: "Send a message first"
  - a turn running: "Stop first"
  - starting, waiting on a card, or stopping: "Wait for the turn to settle"
  - a Chat while another writer holds Your folder: "Your folder is in use by {holder}"
- **A Chat** adds a line: "Your folder is held until you hand back." Its turns in the terminal can write, so the
  Chat takes the hold for the whole takeover (design spec §7.5).
- **A Task** adds a line: "Your folder stays held." or "Its claims stay held."
- When the agent changed project setting files, it also says "These project files changed and won't be loaded:
  `.claude/settings.json`." A project hook loads only when the builder approved its hash.
- **The terminal app** is a setting, Settings › General: "Open sessions in Terminal / iTerm". Terminal is the
  default (design spec §7.5).

### 10.2 While it is in the terminal

The tab shows the `terminal-2` glyph and a dimmed title, and the transcript stays readable. A banner on `bg_0`, with
a 1 px `bg_2` border and the design spec's words, sits above the composer. The composer stays, because the design
spec's §6.7 stores a message sent now and holds it until Hand Back:

```
┌───────────────────────────────────────────────────────────────┐
│ ▣  In your terminal                                           │
│    This runs outside 10db's sandbox. 10db won't touch this    │
│    session until you hand it back.                            │
│    [Hand Back]  Copy Command                                  │
└───────────────────────────────────────────────────────────────┘
┌ composer ─────────────────────────────────────────────────────┐
│ Held until you hand back…                                     │
│ 📎                                                      Send  │
└───────────────────────────────────────────────────────────────┘
⌘↩ holds it
```

- **A held message** shows in the transcript on its panel, with one dimmed line under it: "Held until you hand back".
  Hand Back sends the held messages in order.

- **Hand Back** is the banner's filled primary. 10db does not watch the terminal process (design spec §7.5), so
  Hand Back trusts the builder. It asks first, in a popover: "Is Claude Code closed in your terminal?" (with
  `capabilities.label`), with **Hand Back** and Cancel.
- **Copy Command** copies the launch line for a second terminal. The script file deletes itself once it runs, so
  the copy is the way back in.
- **The banner is neutral, not orange (call).** Orange means a usage limit in this app, and nothing here is wrong.
- Do It… is disabled while the session is here: "Hand back first".
- **Switching to this tab** puts focus on Hand Back, the likely next act; Tab reaches the composer.

### 10.3 Handing back

The conversation goes to `idle_cold`, and any messages held meanwhile run. One notice joins the transcript: "Turns
from your terminal are in the agent's memory; they aren't shown here." 10db imports no history (design spec §7.5).
The next turn resumes the agent's own session, so the agent remembers the terminal's turns.

## 11. Capability-driven affordances

Each session's `ConversationDto` carries `AgentCapabilities` (design spec §5.3). **The UI reads only this, and the
`commands` and `plan_update` events.** No label names a provider except one that shows `capabilities.label`. A test
renders every kit component with a full capability set and with an empty one, and a lint rule in `views/sessions/`
and `conversation/` forbids comparing a harness id.

| Capability | Shows | Without it |
| --- | --- | --- |
| `label` | the agent's name: the model control, the read receipt, Hand Back's question, the announcer | — |
| `steer: 'inject'` | ⌘↩ mid-turn adds to the turn; "Add to this turn…" | `'queue'`: queue chips; "Queue for the next turn…" |
| `receipts` | "Waiting for {label} to read it" under an injected message | no receipt line |
| `readBack` | nothing in the UI. After a restart, fewer messages wait under Send Now. | all unseen messages wait under Send Now |
| `images` | Attach, paste and drop of the listed types | Attach hidden; a pasted picture is refused in words |
| `slashCommands` | the `/` menu from the `commands` event | `/` types a slash |
| `plan` | the plan row above the working line | hidden |
| `reasoning` | "Thought for 12 s" rows; "Thinking…" | neither |
| `subagents` | nested subagent rows; in Plan, the researchers and reviewers | flat rows; Plan's header notice (below) |
| `modelSwitch: 'next_turn'` | the model picker, between turns | `'none'`: the model as plain text |
| `takeover` | Open in Terminal | hidden |
| `costUsd` | the session's cost in the context meter's tooltip | no cost |
| `judge` | `native` and `tendb`: nothing beyond the rows and cards of §7.3 and §7.7 | `rules`: one dimmed `xs` line under the session bar, with the `info` icon: "Judged by 10db's rules. Add an OpenRouter key in Settings › Decisions for 10db's judge." (trust line §4, §10) |

**Plan on Codex** (`subagents: false`, design spec S8). Plan's header shows one dimmed `xs` line with the `info`
icon, the DESIGN.md form for a condition that affects a view:

> Research and review agents need a Claude account. This conversation runs without them.

**Per agent** (design spec §5.3). OpenCode is a future column only: the ACP spec decides it (design spec §5.6).

| Capability | Claude Code | Codex | OpenCode over ACP (future) |
| --- | --- | --- | --- |
| steer | inject | inject (`turn/steer`) | **queue** |
| receipts | yes | yes | no |
| readBack | no | yes | decided in the ACP spec |
| images | png, jpeg, webp | png, jpeg, webp | per model |
| slashCommands | yes | yes (mapped) | ACP's available commands |
| plan | yes | yes | ACP plan entries |
| reasoning | yes | yes (summaries) | per model |
| subagents | yes | no | no |
| modelSwitch | next_turn | next_turn | decided in the ACP spec |
| takeover | yes | yes | decided in the ACP spec |
| costUsd | metered kinds only | no | decided in the ACP spec |
| judge | `native` (auto mode), or `tendb` on a gateway or an unsupported model | `tendb` (10db's judge, after T5) | `tendb` |

The mockups' frame (c) shows the inject composer with its read receipt, beside an inset of the queue composer.

## 12. Every state

| State | What the builder sees |
| --- | --- |
| **No tabs** | Sessions opens a fresh tab. The screen is never blank. |
| **Fresh tab** | §6.2. |
| **Loading a transcript** | Plan's `Loader` (xs) in the session bar. Past 300 ms, three static dimmed lines in the column, with no shimmer. Pages of 200 items load as the builder scrolls up. |
| **Waking up** (`idle_cold` → `starting`) | The builder's message shows at once, and the working line says "Waking up the session…". When the resume fails, the next start is fresh from the digest, with the divider "Continued in a fresh session. Nothing is lost." |
| **Context past 70%** | The same divider, at the end of the turn. |
| **Usage limit** (`paused_account`) | The orange pause icon on the tab, and an orange working line: "Paused: usage limit, resumes 3:40". No card is raised. The composer still takes messages ("Sends when the limit resets"). A move to the fallback account shows as a dimmed notice: "Moved to your backup account. This continues in a fresh session." |
| **After a daemon restart** | §7.8: the waiting messages sit under "These waited through a restart. Nothing was sent." with **Send Now**. A running turn's text shows, ending "Stopped here." |
| **Model refused** | A red `Alert` above the composer: the title "Not available on this account", the daemon's words, and **Choose Another Model**. The draft stays. |
| **The agent is downloading** | The header's existing download line. The working line says "Waiting for Codex 0.167.0 to download", and the message sends once the copy is ready. |
| **Daemon reconnecting** | The app's banner above the view. Transcripts stay readable, and Send is disabled with "Reconnecting… your message stays here." |
| **An error ended the session** (`ended_error`) | The red alert icon and a red ring on the tab; it counts as needs-you. The transcript ends with one line: "The session stopped: Claude Code exited with code 1. Send a message to start it again." with **Show Details**. |
| **A turn the model refused** | A dimmed notice: "{label} declined to continue this turn." |
| **Read-only Chat** (`sealed`) | §8.2: no tab of its own; opened from "From chat", ⌘⇧T or ⌘K, it shows the line with Open Task and New Chat From This, and no composer. |
| **Your folder in use** | Another holder has the folder: a pass, another Chat's turn, a Chat in your terminal, or a task running in Your folder. {holder} names it: "the pass ‘Settings pass’", "the chat ‘Retry login’ in your terminal", "the task ‘Bump vite’". The kind line, dimmed: "Chat · reads only: Your folder is in use by {holder}". The Chat's turns run and change nothing; an edit shows as "10db stopped this: Your folder is in use by {holder}". No new color, and no tab state. |
| **A call held back at a limit** | A dimmed row, "Held back: this would {limit}", with **Allow This** (§7.3). An escalated call is a card instead (§7.7). |
| **Judged by 10db's rules** (`judge: 'rules'`) | The dimmed `info` line under the session bar (§11). |
| **A model change** | The divider "Now on {label} · {model}" where the next turn starts (§7.1). |
| **A Your-folder check failed** | A notice above the turn's footer: "Check failed: 2 errors in `client.ts`", with **Send to Agent**. The tab stays Ready. |
| **In your terminal** (`taken_over`) | §10.2: the banner over a composer that holds messages. |
| **A Task in a Separate copy, between runs** | The composer is disabled: "Messages reach this task while it runs." |
| **A Task finished** | §8.5. |
| **Signed out** | A red `Alert`: "Sign in to {account} to continue", with **Open Accounts**. |
| **The project was removed** | The transcript, read-only, with one line: "This project was removed from 10db." |
| **Archived, opened from ⌘K** | It unarchives and opens. |

## 13. Accessibility and narrow windows

### 13.1 Keyboard, focus and screen readers

- **The strip** is a `tablist`.
  - Each tab is a `tab` with `aria-selected` and `aria-controls`.
  - Arrows move focus and Enter selects (manual activation, since a switch loads a conversation).
  - The × is a pointer affordance, hidden from assistive tech; Delete and ⌘W close.
  - A tab's name is "{title}, {project}, {state words}" (§5.3).
- **Focus order:** sidebar, tab strip, session bar, then:
  - the transcript, a focusable scroll region (`role="group"`, "Messages"). Each message in it is an `article`
    whose first child is a visually hidden heading, "You" or "{label}" (`capabilities.label`), so a screen reader's
    heading and landmark keys move by message and always say who spoke. Tool rows, notices and dividers sit inside
    the agent's article for that turn.
  - the plan row, the waiting cards and the queued chips
  - the composer and its buttons
  - the Changes panel
- **Switching tabs** puts the cursor in that tab's composer (the Workbench's rule). A tab with no composer puts
  focus on its line's first button: **Open Task** on a read-only Chat, **Open on Board** on a finished Task. A tab in
  your terminal focuses **Hand Back**.
- **Esc** stops the turn only when focus is in the composer, the transcript or the page itself. Focus inside a
  waiting card, a menu, a modal or an open select takes it (`escapeIsTaken`).
- **One polite announcer** (`Announcer`) says only what the builder acts on:
  - "Claude Code replied: {first sentence}"
  - "Codex asks to run a command. Answer it above the message box."
  - "Retry login on a 401 is ready"
  - "The session stopped"
  - "Paused: usage limit, resumes 3:40"
  - for another tab: "{title} in {project} needs you"

  The transcript is not `role="log"`, which would read streaming text aloud.
- **Tool rows** are buttons with `aria-expanded` and a full name. Diff lines carry `aria-label`s ("added line 42:
  …").
- **Reduced motion:** the only motion is 150–200 ms of opacity (DESIGN.md). Under `prefers-reduced-motion` it is
  off, and scrolling to the tail jumps.
- **Contrast** is Selenized's (the decision). axe runs every other rule, in both schemes, at 480 and 1280 px.

### 13.2 Narrow windows

Sessions folds the sidebar under 900 px, as the UI Workbench does **(call)**: a chat beside a browser is the same
posture.

| Width | Tab strip | Session bar | Conversation | Changes |
| --- | --- | --- | --- | --- |
| ≥ 1100 | full tabs | everything | 720 px column | side pane; may open by itself |
| 900–1099 | full tabs | everything | the column fills | side pane, only when asked |
| 640–899 | unselected tabs show only their tile and state; the selected one keeps its title | the model and the meter move into `⋯` | 16 px gutters | covers the conversation, with Back |
| 420–639 | **one tab switcher** in the header: the tile, the glyph, the title, its state, a `CountBadge` of the other tabs that need you, and a chevron that opens All Tabs. `+` stays. | the title, then Do It… or Changes, then `⋯` | tool rows drop their durations; diffs are unified only; the hint line hides | full width, with Back |

## 14. Copy

Buttons, menu items and names are Title Case; everything else is sentence case (DESIGN.md). "{x}" is filled in, and
"{label}" is `capabilities.label`.

| Where | String |
| --- | --- |
| Sidebar | Sessions |
| Sidebar badge (spoken) | {n} sessions need you |
| New tab | New session |
| New tab button (tooltip) | New Session ⌘T |
| Overflow button | All Tabs |
| Tab menu | Rename · Open in Terminal · Archive · Close Tab · Close Other Tabs · Close Finished Tabs |
| Fresh tab line | A chat works in {project}'s folder. For bigger work, Do It hands it to a task. |
| Fresh tab account line | Uses {project}'s account. Reads the code, runs commands and searches the web. Asks before anything that crosses a limit. |
| Section labels | Start from · Recent |
| Keys | ⌘J goes to the next tab that needs you |
| Find link | Find a Session ⌘K |
| Session bar lines | Chat · Your folder · on `{branch}` · Chat · reads only: Your folder is in use by {holder} · Chat · read-only: its work moved to a task · Chat · in your terminal since {time} · Task · Your folder · lands on `{branch}` · Task · Separate copy · `{branch}` |
| Placeholders | Ask about {project}… · Reply… · Add to this turn… · Queue for the next turn… · Reply, or paste a screenshot… · Held until you hand back… |
| Hint line | ⌘↩ sends · Esc stops · / commands · @ files · ⌘↩ adds to this turn · ⌘↩ holds it |
| Composer buttons | Attach · Send · Stop · Stop and Redo · Sign Off |
| Queue chip | Queued · Edit · Remove |
| Read receipt | Waiting for {label} to read it · Held until you hand back |
| After a restart | These waited through a restart. Nothing was sent. · Send Now |
| Partial reply | Stopped here. |
| Working line | Working · {t} · Working · {t} · {verb} `{target}` · Thinking… · Writing… · Waking up the session… · Waiting for your answer · Waiting for {agent} {release} to download · Paused: usage limit, resumes {time} |
| Task working line | {n} files changed so far · Show Log |
| Plan row | Plan · {done} of {n} done · Now: {step} |
| Tool rows | Read {n} files, searched {m} times · Reading `{path}` · Edited `{path}` · Edited {n} files · Created `{path}` · Deleted `{path}` · Moved `{a}` to `{b}` · Subagent: {preview} · Searched the web for ‘{q}’ · Fetched {host} · Used {name} · 10db stopped this: {reason} · You denied this · Held back: this would {limit} · Allow This · You allowed this · Thought for {t} · Made a plan · {n} steps |
| Row actions | Show Full Diff · Open in Changes · Show All Output · Open Full Patch · Open on Board · Undo |
| Output and diff limits | Showing the last 4 KB of {size} · Cut at 1,500 changed lines |
| Task rows | Added to {column} · Changed {fields} · Renamed this session to ‘{title}’ · Started {task} |
| Cards | Send Answer · Note for the agent (optional) · Also in your Inbox. · Allow once · Always in this project · Deny |
| Answered rows | You allowed this once · You allowed this in the project · You denied this · You answered: {choice} |
| Judge line | Judged by 10db's rules. Add an OpenRouter key in Settings › Decisions for 10db's judge. |
| Links in markdown | Open {host} in your browser? · Open · Cancel |
| Do It | Do It… · Do It · File as Tasks · Title · Brief · Where · Writing the brief… · The turn that's running stops first. · The task takes this chat's place. The chat becomes read-only. · The pass opens in its own tab. This chat stays open, and changes nothing while the pass holds your folder. · Cancel · Hand back first · {n} files already changed in your folder: · These will be part of this task's work. · These stay in your folder. The task starts without them. · Show {n} More · A merge is in progress in your folder. · A rebase is in progress in your folder. · A bisect is in progress in your folder. |
| Do It place lines | §8.1 |
| Links between tabs | From chat: {title} · Started a task: {title} · {place} · Started a pass: {title} · Your folder · Open |
| Read-only Chat | This chat handed its work to {task}. It's read-only now. · Open Task · New Chat From This · Finish or abandon its task first. |
| File as Tasks message | File the work we agreed on as tasks on the Board. |
| Check notice | Check passed · {checks} · {t} · Check failed: {n} errors in `{file}` · Send to Agent |
| Turn footer | Turn {n} · {t} · {n} files changed · Check passed |
| Your folder landing | Signed off · landed as `{sha}` · {n} files · Close Pass… · Abandon Pass… · Running the gate in your folder… · Pushing… · Closing the pass… · Closed · pull request #{n} opened. `{branch}` fast-forwards to it when it merges. · Done · `{branch}` is at `{sha}`. |
| Separate copy landing | Finished · in review: pull request #{n} · Open on Board · Open Pull Request · Done · merged as `{sha}`. · Messages reach this task while it runs. |
| Changes | Changes · {n} files · against `{base}` at `{sha}` · All Turns · Last Turn · No changes yet. |
| Terminal popover | Open in Terminal · Continues this session in {app} with {label}'s own resume, in {path}. It runs outside 10db's sandbox, with this session's instructions, plugins and MCP servers, and without your settings file. 10db won't touch this session until you hand it back. · Your folder is held until you hand back. · Your folder stays held. · Its claims stay held. · Cancel |
| Terminal refusals | Send a message first · Stop first · Wait for the turn to settle · Your folder is in use by {holder} |
| Takeover banner | In your terminal · This runs outside 10db's sandbox. 10db won't touch this session until you hand it back. · Hand Back · Copy Command |
| Hand Back confirm | Is {label} closed in your terminal? · Hand Back · Cancel |
| Hand Back notice | Turns from your terminal are in the agent's memory; they aren't shown here. |
| Fresh session | Continued in a fresh session. Nothing is lost. · Show Summary |
| Context tooltip | {p}% of the context used. Past 70%, the next turn continues in a fresh session with a summary. · ${cost} so far |
| Model control | Change the model between turns · (not offered) · Now on {label} · {model} |
| Plan on Codex | Research and review agents need a Claude account. This conversation runs without them. |
| States | §12 |
| Notifications | {title} is ready · {title} replied · {title} needs you |
| Spotlight | Find a session or an action… · Open Tabs · Recent · Actions · Archived · New Session in {project} |
| Inbox card link | Open Session |
| Board | Waiting on you in Sessions · Open Session |

## 15. Left out of v1

| Left out | Why |
| --- | --- |
| Two tabs side by side, or a tab in its own window | One conversation at a time is the iTerm model; split panes double every layout. |
| Rewind, fork, "branch from here" | The design spec leaves them out (§15 there). |
| Showing the terminal's turns after Hand Back | The design spec leaves it for later (§7.5 there). |
| A Task in a Separate copy that stays warm between turns | M9 (design spec §6.9). |
| Agent modes, such as Claude's plan mode, and an effort control | Not in `AgentCapabilities`; a later field each. |
| Folders in `@`, and a file's content sent with a mention | `git ls-files` lists files, and a mention is a path (design spec §11). |
| Tab groups and pinned tabs | Order and the project tile are enough at 2 to 10 projects. |
| Threaded review comments on diff lines | Quoting a line into the message covers the loop. |
| A file path that opens the builder's editor | It needs an opener capability and an editor setting. |
| A terminal pane inside 10db | The design spec leaves it out (§15 there). |
| The agent suggesting Do It (a nudge under a reply) | It needs a judgment of "a plan was agreed"; wait for real use. |
| Opening any Board task's thread as a tab | A next step; v1 tabs are sessions made here. |
| Transcript search in ⌘K | Search across conversations is later (design spec §15). |
| Per-hunk accept and reject | Sign Off and delivery land the whole task; a hunk is undone by asking. |

## 16. The shared `conversation/` kit

The design spec's kit (§8 there): `apps/desktop/src/conversation/` holds Markdown, ConversationList, ToolCallCard,
Composer, WorkingLine, PermissionRequest and Announcer. Sessions builds it. Plan moves onto it in M4b, and the
Workbench thread in M4c. Their behaviour and tests move with them unchanged.

| Kit component | Draws here | Sessions | Plan | UI Workbench |
| --- | --- | --- | --- | --- |
| `ConversationList` | the windowed, tail-following column of `article`s with hidden speaker headings, the builder's panel, notices and dividers, Jump to Latest, Send Now | yes | replaces `transcript.tsx`. **New look:** the panel replaces "You" | replaces the plain `ol` in `thread.tsx` |
| `Markdown` | replies (§7.2) | yes | **new:** replies render markdown | **new:** replies render markdown |
| `ToolCallCard` | the rows of §7.3, grouping, the peek, nesting, task rows | yes | **new:** rows replace the dimmed mono lines; reads group | the rows its runner stores (§7.3, before M9) |
| `WorkingLine` | §7.5, with the plan row | yes | **new look:** the blue dot and the turn's doing replace "Claude is working…" with dots | already this |
| `PermissionRequest` | the Inbox's cards in place (§7.7) | yes | replaces `waiting-permissions.tsx` | replaces `page-ask.tsx` |
| `Composer` | the frame, Mentions, ⌘↩, pictures, the phase table, queue chips | yes | **new look:** the bar moves inside the frame; Propose stays its filled primary and Send `default` | **new look:** the same frame, with Open Page at its left |
| `Announcer` | §13.1 | yes | replaces `round-announcer.tsx` | replaces `announcer.tsx` |

**What stays each screen's own:**

- **Plan:** proposals, review notes, undo, screens, the preview, its split, `late`, Propose and ⌘⇧↩, and the Codex
  notice (§11).
- **The Workbench:** the pass header, the queue, pictures per page, Sign Off's pass rules, Open Page and Retry Turn.
- **Sessions:** the tab strip, the session bar, Do It, Changes, Open in Terminal and Spotlight.

The kit's `Composer` ends the cross-view import of `isSendKey` from `shape` into `workbench`.

## 17. Review against gstack's `plan-design-review`

The review ran without questions, and each finding is a **(call)**.

**Skipped steps:**

- the question gates, since nobody could answer
- the gstack designer's generated images, which call a paid image API; the mockups replace them
- the outside voices, since a Codex run bills an account
- the review log and telemetry writes

The mockups were rendered with macOS Quick Look (no browser, no network) and checked by eye.

**Classifier:** OPERATE (app UI), with DESIGN.md as the system.

| Pass | Before | After | What moved it, and what is left |
| --- | --- | --- | --- |
| 1 Information architecture | 6 | 9 | The hierarchy (§4), the placement (§3) and the title-bar strip. Left: Spotlight's ranking. |
| 2 States | 3 | 9 | §5.3 and §12 give every state of design spec §6.7 its look and words. Left: the slow-transcript lines are unmocked. |
| 3 Journey | 5 | 9 | The storyboard below. Left: "Start from" needs real project state to judge. |
| 4 AI slop | 7 | 9 | Rows, not cards; no bubbles; one bold move. Left: nothing found. |
| 5 Design system | 8 | 9 | Every color is a Selenized value, the diff included. Left: the Selenized Shiki theme must be built. |
| 6 Responsive and a11y | 4 | 9 | §13. Left: the 420 px switcher needs a real-window check. |
| 7 Unresolved decisions | — | 41 calls, 0 deferred | §19. Round 1 of the independent review is in §21. |

**Litmus checks, all passed:**

- The product is unmistakable in the first screen: the sidebar and Selenized are 10db's own.
- There is one strong visual anchor: the tab strip and its states.
- The screen is scannable by headlines: the session bar's title and kind line.
- Each section has one job.
- Cards earn their place: only the Inbox's cards, because answering is the interaction.
- There is almost no motion.
- The screen holds up with shadows removed: depth is Selenized tone, as on the Board.

**The journey:**

| Step | The builder does | Feels | What carries it |
| --- | --- | --- | --- |
| 1 | ⌘T from the Board | "a fresh terminal tab" | ⌘T anywhere, with the selected project as the default |
| 2 | Types "why does login fail after sleep", ⌘↩ | heard at once | the first line titles the tab; the working line names what it reads |
| 3 | Watches it read, run a command and search the web | trust: it asks only at a limit | quiet rows; Allow This only where a call would cross a limit |
| 4 | Agrees the fix. A small one, the chat just makes; for this one, presses Do It… | in control | a brief written for them; where and how it lands, and which files come along or stay, said before it starts |
| 5 | Goes to the browser while the Task works | free | the yellow ring and the notification when ready |
| 6 | Opens the tab and reads Changes | oriented in seconds | Changes opens by itself once; the check line |
| 7 | Quotes a line, "use the existing helper", ⌘↩ | precise | the line quote |
| 8 | Signs off, then Close Pass… | done | "Closed · pull request #212 opened. `main` fast-forwards to it when it merges." |

## 18. Departures from the patterns other products use

T5's research covered Claude desktop's Code tab, Zed, Cursor, VS Code and Superset.

| Their pattern | This design | Why |
| --- | --- | --- |
| A sessions sidebar or list (Claude desktop, Zed, Cursor, Superset) | Tabs in the title bar | The builder asked for iTerm-like tabs, and 10db's sidebar is navigation. |
| Queue mid-turn; a double Enter sends at once (Zed, Cursor) | Inject by default; queue only with `steer: 'queue'` | The Workbench already injects, with receipts. |
| ⌘N for a new session (Claude desktop) | ⌘T | iTerm and Safari use it; ⌘N is a new window on macOS. |
| An embedded terminal pane (Claude desktop) | Open in Terminal | One writer, the builder's own terminal, no PTY to maintain. |
| A mode chosen at creation, such as local or worktree | Every session starts as a Chat; Do It chooses the place | A Chat writes in Your folder itself (design spec S2); Do It is for bigger work, so no toggle is asked up front. |
| Archive warns on a dirty worktree (Claude desktop) | A Task has no Archive; it ends as a task ends | A Task is a pass or a Board task, each with its own end. |
| Inline line comments sent to the agent (Claude, Superset) | Quote a line into the message | The same loop, with no review threads. |
| Colored diff backgrounds | Colored text on `bg_1` | Selenized exactly forbids mixed tints. |

## 19. Calls for the builder

Each call was made overnight, and each takes one line to overturn. "Adopted" means the design spec holds it too
(its §17, item 12, or the section named).

**Placement and the strip**

1. Sessions is global, third in the sidebar (adopted: S1).
2. Selecting a tab makes its project the selected project (§3).
3. ⌘T works from every view and opens Sessions (§3).
4. The tabs live in the title bar, starting just after the traffic lights (adopted; §5.1).
5. A tab takes its title's width up to 220 px; the selected one shrinks last; the × takes the state mark's place;
   `set_title` asks for 28 characters at most (§5.2, §5.4).
6. A Task tab shows a folder or branch glyph; a Chat shows none, since every Chat works in Your folder (§5.2).
7. The agent and model are not on the tab's face (§5.2).
8. A tab's state is never color alone: a dot for Working, a dot and ring for Needs you and Ready, an icon for the
   rest; an error gets a red ring and counts as needs-you, as in the UI Workbench (§5.3).
9. A working tab has a static dot, never a spinner (§5.3).
10. A new reply is a bold title, with no color and no card (§5.3).
11. Green means landed: merged, or a closed pass on a `local` project. A signed-off pass that isn't closed is a dimmed
    check, unlike the Workbench's green page; In review is a pull-request glyph (§5.3).
12. All Tabs and the narrow switcher carry a `CountBadge` of the hidden tabs that need you (§5.5).
13. ⌘J and a click on the Sessions badge go to the next tab that needs you; Close Finished Tabs closes the done ones
    and skips any open pass (§5.5).
14. No cap on tabs (§5.5).
15. Close never asks; ⌘⇧T reopens (§5.6).
16. A Chat's reply notifies only while the window is unfocused (§5.7).
17. The Inbox's Open Session opens a session's tab, and reopens it when closed (adopted: §7.3, for a pass of one;
    §5.7).

**Starting**

18. The UI says Chat and Task (adopted: the design spec's Words; §2 here).
19. "Start from" suggestions come from rules, not a model, and so are not nudges: each shows its source's icon
    (§6.2).

**The conversation**

20. One 720 px reading column, centred, with left-aligned text (§4).
21. No visible speaker labels; each message is an `article` with a hidden "You" or "{label}" heading (§7.1, §13.1).
22. The `bg_1` fill is the builder's messages alone (§7.1).
23. Tool calls are one-line rows; consecutive reads fold, and so do consecutive edits (§7.3).
24. A peek shows under a lone edit or a folded group's last edit; a failed command opens itself (§7.3).
25. Diffs are colored text on `bg_1`, never tinted rows (§7.3).
26. The agent's plan is one row above the working line (§7.5).
27. Thinking stays collapsed, even while it streams (§7.6).
28. Focus never jumps to a waiting card, and Esc inside one never stops the turn (§7.7).
29. ⌘↩ during a turn injects where `steer` allows, and queues otherwise (§7.8).
30. 10db's own actions are never slash commands (§7.9).
31. The context bar stays blue at any level (§7.10).
32. ⌘↩ sends, and Enter is a new line, in Sessions, Plan and the UI Workbench (adopted: §8).

**Do It and landing**

33. The chat's agent writes the Do It brief, with the digest as the fallback; Do It is enabled once the brief has
    text (adopted: §7.3; §8.1).
34. A Task in a Separate copy takes the Chat's place in the strip, and the read-only Chat offers New Chat From This
    (adopted from the design review: §7.3). A pass of one opens beside the Chat, which stays open (§8.2).
35. Changes opens by itself once, at 1100 px and wider (§9).
36. Clicking a diff line quotes it into the message, with no review threads (§9).

**The terminal and narrow windows**

37. Open in Terminal warns every time, in a popover; the takeover banner is neutral, not orange (§10).
38. Sessions folds the sidebar under 900 px, as the UI Workbench does (§13.2).

**The trust line**

39. Do It picks Separate copy by default; Your folder, as a pass, is the option (§8.1).
40. A call held back at a limit is a dim row with Allow This, not a card and not a tab state (§7.3, §5.3).
41. "Your folder in use" is a dimmed kind line, not a tab state or a color (§4, §12).

## 20. Live checks, open points, and DESIGN.md for M5a

**Live checks** (design spec §16):

- A tab in the title bar does not start a window drag, and a double-click on empty strip space zooms the window
  (§5.1).
- ⌘W reaches the web view before the menu's Close on the Tauri window (§5.8).
- The streamdown spike, which the design spec runs, must also render a 20k-token reply while the composer stays
  responsive.

**Open points:**

- **Tool rows in a Task before M9** depend on the runner storing `tool_call` items (design spec §7.3, M4c).

**DESIGN.md updates that M5a makes.** Not edited now.

1. **Scope follows the question:** the sidebar's global group reads Inbox, Factory, Sessions.
2. **Navigation:** on Sessions only, the header holds the tab strip from 84 px, keeps its empty space as a drag
   region, and zooms the window on a double-click there.
3. **Status:** a status is never told by color alone. A bare dot means running; a dot with a ring means waiting on
   the builder, the ring yellow, or red for a failure; failed, paused and done are icons in their colors. This
   extends Card state to tabs.
4. **Green** on a tab means landed: merged, or a closed pass on a `local` project. A signed-off pass that isn't
   closed is a dimmed check, and the page says why it differs from the Workbench's green row.
5. **Fills:** the `bg_1` raised panel is the builder's own message. Code, command output, banners and read-only
   lines sit on `bg_0` with a 1 px `bg_2` border.
6. **Diffs:** colored text on `bg_1`, changed words on `bg_2`, no tinted rows, and 10db's own gutter per hunk.
7. **Nudges:** a suggestion built by rules is not a nudge. It shows its source's icon and has no sparkles and no ×.
8. **Agent output** renders as markdown through one component, which amends "never markup" by the decision the
   design spec names (§11 there), with a Selenized Shiki theme for code.
9. **Tool calls** are rows, not cards; cards stay for what the builder answers.
10. **Keys:** ⌘↩ sends in every composer; ⌘T, ⌘W, ⌘1–9, ⌘⇧[ ], ⌘J and ⌘K on Sessions.
11. **Counts:** the Sessions badge counts the tabs that need the builder: Needs you, Ready and Stopped by an error.

## 21. Review round 1: where each finding went

The coordinator's condensed list of the independent design review's first round. Findings 14 and 25 were not in
the condensed list.

| # | Finding | Where it went |
| --- | --- | --- |
| 1 | Tab titles unreadable at 1080 px with five tabs | §5.1 (the strip starts at 84 px), §5.2 (× in the state mark's place; the selected tab keeps its width; others shrink first), §5.4 (`set_title` at most 28 characters); mockup frame a redrawn |
| 2 | Tab state by color alone (WCAG 1.4.1) | §5.3: dot for Working, dot and ring for Needs you and Ready, icons for Error, Paused and Done; legend in frame a |
| 3 | Who speaks is invisible to a screen reader | §7.1 and §13.1: each message an `article` with a hidden "You" or "{label}" heading |
| 4 | Takeover says messages wait, with no composer | §10.2: the composer stays under the banner, "Held until you hand back…", "⌘↩ holds it"; frame g |
| 5 | "Waiting for your answer above" points the wrong way | §7.5, §14: "Waiting for your answer"; frame d |
| 6 | "Start from" broke the Nudges rule | §6.2: not nudges, no sparkles, a source icon each, three kept; frame b |
| 7 | Do It must list the uncommitted paths | §8.1: the list, folded after five, "These will be part of this task's work."; the §20 question removed; frame e, with the refused Your folder choice |
| 8 | Done could never show | §5.3: Done above New reply and Idle; a closed Your-folder pass is In review |
| 9 | Changes route | §9: `GET /workstreams/:id/changes`; `GET /tasks/:id/changes` removed |
| 10 | `bg_1` used beyond the builder's messages | §7.1, §7.2, §7.3, §8.2, §10.2; mockups' code, output, banners and read-only line on `bg_0` with a `bg_2` border |
| 11 | Do It: the Task takes the Chat's place | §8.2, §5.5, §5.6; New Chat From This; frame e |
| 12 | Fold consecutive edits | §7.3 "Folding edits"; the peek only under a lone or last edit |
| 13 | Esc in a waiting card stopped the turn | §7.7, §13.1: `escapeIsTaken` counts focus inside a card |
| 15 | Do It sheet states | §8.1: enabled once the brief has text, "Writing the brief…", a submit refusal beside the button, merge, rebase and bisect; frame e's inset |
| 16 | Failed and green differ from the Workbench | §5.3: failed is needs-you with a red ring and a count; green means nothing left to do, in both screens |
| 17, 18 | Missing states and mockup drifts | Frame j adds Ready with text typed and Check failed. Fixed: frame i's ring, frame d's "1–5", frame g's kind line (now in §4 and §14), frame f's doubled check line and its footer (§7.1: a passing check lives in the footer) |
| 19 | Sign Off's hint hides under 640 px | §8.5: the tooltip carries it |
| 20 | Focus on a tab with no composer | §13.1: Open Task, Open on Board, Hand Back |
| 21 | Open Session on a closed tab | §5.7: it reopens the tab |
| 22 | Next tab that needs you; Close Finished Tabs | §5.5, §5.8: ⌘J and the badge's click; the tab menu; keyboard reordering later |
| 23 | Model change unmarked | §7.1: the divider "Now on {label} · {model}" |
| 24 | Double-click on the strip | §5.1: zooms the window; a tab's double-click renames |
| 26 | DESIGN.md updates for M5a | §20 |

**Round 2.** 23 of 24 findings resolved; one new blocking finding and two nits.

| # | Finding | Where it went |
| --- | --- | --- |
| 27 | Done covered a signed-off pass that isn't closed, so Close Finished Tabs could hide a pass that still holds the folder | §5.3: the new **Signed off** state, a dimmed check, spoken "signed off: close the pass to land it"; green Done only for merged work or a closed pass on a `local` project; why this differs from the Workbench. §5.5: Close Finished Tabs skips any open pass. §8.5: Close Pass… becomes the session bar's filled primary. Frame a's legend and the states strip |
| Nit 1 | The Esc rule in §5.8 left out waiting cards | §5.8: "a menu, modal, select or waiting card" |
| Nit 2 | Frame e's footer ran into Cancel | Mockups: the modal footer has a gap and wraps |

## 22. The trust line's changes

Design spec v4 (§19 there) applies the trust line's §13. Here:

| Change | Where |
| --- | --- |
| A Chat writes in Your folder, holding it while a turn runs, and commits, branches and opens a pull request through its git tools | §0, §2, §4, §5.2, §6.1, §6.2, §7.3, §8 intro, §14 |
| Another writer holds the folder: the Chat reads only | §4, §5.3, §8.2, §10.1, §12, §14 |
| Do It: Separate copy by default, sealing the Chat; Your folder, as a pass, optional and not sealing | §5.5, §5.6, §8.1, §8.2, §8.4, §14, §19 call 39 |
| Uncommitted files stay in Your folder for a Separate copy | §8.1, §14 |
| Every builder tool present; removing or retiring the builder's work asks; `start_task` raises no card | §7.3, §7.7, §5.3, §14 |
| Cards only for escalations and 10db's judge; Allow once, Always in this project, Deny | §7.7, §14 |
| A judged denial is a dim row with Allow This | §2, §7.3, §12, §14, §19 call 40 |
| The web in every session | §6.1, §7.3 (`web` row) |
| The builder's setup: skills and commands in `/`; the terminal carries the session's setup | §7.9, §10.1, §14, §15 |
| `capabilities.judge`, and the `rules` line | §11, §12, §14 |
