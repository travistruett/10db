# 10db Pick on Page design

Designed November 25, 2026; slice 1 being built. Size: a Feature, with one Core piece: the channel that carries a
pick from the page into 10db (§5). Research: `~/Agents/notes/10db/2026-11-25-element-annotation-research.md`.

## Brief

**What changes for you.** A Workbench page's title row opens your app in a **Preview** window by default, a 10db
window already signed in with the project's dev login. A small pill in its bottom-left corner (or ⌘⇧C) turns on
pick mode. Hover outlines an element and names its component and file. A click picks it and opens a note beside
it: type, or press fn fn to dictate, then ↩. ⇧-click adds more elements to the same pick, and a drag picks an
area. Each pick shows up at once as a numbered chip in that page's composer, with its crop, component,
`file:line` and note. The pill's **3 in Settings ›** brings 10db forward. One Enter sends the lot to the agent.
Open in Browser and Copy Link stay in the Open menu, each with a line saying how it differs.

**What it buys.** Most "screenshot it, paste it, say which button" round trips go away. The agent gets
`SaveButton (app/settings/general-card.tsx:37)`, the selector, the crop and your note, so it doesn't have to guess.

**What could go wrong, and how we'd know.**
- The page in the preview runs code an agent wrote, and the picker shares its JavaScript world (WebKit's page
  world: wry injects with `WKUserScript initWithSource:injectionTime:forMainFrameOnly:`). So the page can fake a
  pick, a note or the pill. The most a fake can do is add a chip to your draft, where you can see it. A pick never
  sends anything, never answers a card and never presses a button in 10db (§5).
- `file:line` is a hint. Measured: client components came out exact for about 22 of 25 elements in WebKit, with
  the rest one level off (the call site rather than the inside of the component). Next server components resolve
  wrongly in WebKit, so a frame that lands in `node_modules` or a framework runtime is never sent. Those picks
  carry the component's name, the selector and the crop.
- The preview is WebKit, not Chrome, so a Chrome-only layout bug won't show there. Open in Browser stays one
  menu item away.
- A crop shows your app's data and goes to the model, as a pasted screenshot does today.

**Calls you might disagree with.**
1. The pill is drawn in the page, not in 10db's own chrome, so it can be faked (you chose this). Docking the
   preview beside the thread (slice 2) moves the toggle into 10db's header.
2. Picks reach the composer as you make them, not on a Send in the page (you chose this). The composer is the
   one list of picks.
3. Crops come from WebKit's own snapshot of what it painted (`WKWebView takeSnapshot`), not `html-to-image`. So
   nothing extra is injected for crops, and cross-origin images and fonts come out right.
4. The dev login's cookies go from the daemon's kept sign-in file into the preview's own cookie store, read by
   the shell. They never cross HTTP or the UI's JavaScript.
5. At most 8 picks per message, leaving room for 2 pasted pictures under the 10-picture limit.
6. A pick in a Ready page makes Send the primary over Commit, as typed words do; in a working turn picks never
   turn Stop into Stop and Redo.

**What's needed from you.** Nothing.

## 1. Scope

Slice 1 (this spec's build): the Preview window, the in-page picker, picks into the composer as chips with
crops, the pick channel, and an extension of `e2e/workbench.spec.ts`. Later slices, unbuilt: docking the preview
beside the thread as a child webview (needs Tauri `unstable`, a pin decision), badges that stay on the page across
a turn, and picking on a turn's headless after-picture. A Chrome extension is out unless WebKit differences bite.

## 2. Opening the preview

- The title row's open control becomes a split button. Its face is **Open Preview** (⌘O). Its menu holds:
  - **Open Preview**: "10db's window, signed in. Pick elements here."
  - **Open in Browser** (⌘⇧O): "Chrome, with your own session and DevTools." This is today's
    `open_app_page`; its name follows the default browser.
  - **Copy Link**: "The page's address, for anywhere else."

  A queue row's link icon keeps opening the browser.
- **One preview window per project**, labelled `preview-<projectId>`, made on first open and reused after. Opening
  another page navigates it to that page's route and makes that page the window's **target**: the page whose
  composer gets its picks. The target is held by the shell, never taken from the page (§5). The window's title is
  "`<Page label>` · Preview".
- **Signing in.** Before it opens, the UI asks the daemon to make sure the project is signed in:
  `POST /projects/:projectId/preview/sign-in` answers `{ ok: true }` or `{ ok: false, problem }` and returns no
  credential. It runs the dev login only when no state is kept. The shell then reads
  `<data dir>/browser/<projectId>/state.json` itself (zod-equivalent serde parse; it is a boundary) and sets the
  cookies whose domain matches the app's host into the window's own data store before it loads the route. With
  no dev login command, the window opens unsigned. A `problem` shows under the button, as a refusal does today.
  localStorage from the state is not carried (slice 1).
- **The window browses like a browser.** It may load any address, iframes included, as your own browser tab
  would; only a page on the app's exact origin reaches the pick channel (§5). A new window (`window.open`, a
  `target="_blank"` link) loads in the preview itself, so a page never drives your own browser. A hosted
  sign-in page works there like any page.
- **10db's own window is never previewed.** Where the app's origin is the main window's own (the dev shell's
  `devUrl`, which Tauri counts as local) or 10db's own dev UI, the face stays Open in Browser.
- A kept sign-in that has expired is not refreshed by the preview in this slice: the page lands on its login,
  where you can sign in in the window itself.
- Each project has its own data store (`data_store_identifier` derived from the project id), so the preview's
  cookies never mix across projects or with the main window.

## 3. The picker (in the page)

Built from `react-grab/primitives` (MIT, pinned exactly) plus 10db's UI, bundled into one script that the shell
adds as the preview's initialization script. It does nothing unless `location.origin` is the app's origin, which
the shell writes into the script. It draws into a closed shadow root at the top of the page.

- **The pill**, bottom-left: a pointer mark. Clicking it, or ⌘⇧C, toggles pick mode. While picking it reads
  "Picking · 3 picks" with **3 in `<Page>` ›**, which asks the shell to bring 10db forward with that page's
  composer focused.
- **Pick mode.** The page gets no clicks, and hover outlines the element under the pointer (blue) with a tag:
  `button "Save changes" · SaveButton app/settings/general-card.tsx:37`. Holding ⌥ hands the page back, so a menu
  can be opened and the picking resumed inside it. Esc closes an open note first, then leaves pick mode.
- **Click** picks one element (magenta outline, numbered badge) and opens its note beside it: one text field,
  ↩ saves, ⇧↩ adds a line, Esc keeps the pick with no note, and Remove drops it. macOS Dictation (fn fn) works in
  the field as in any text field. **⇧-click** adds an element to the newest pick: one note, several outlines,
  shown as "N elements". Holding ⇧ fades an open note so the page under it can be clicked. **Drag** draws a box
  and makes an area pick holding the outermost elements inside it. A click on the page while a note is open saves
  the note first.
- Clicking a badge reopens its note, and editing it sends the pick again (same pick id: the chip updates).
- What a pick carries (built in the page, parsed in 10db, §5): a pick id, its kind (`element`, `group`, `area`),
  and for each element (at most 6) the tag, a selector, the first 200 characters of its text, its box in viewport
  pixels, the component name and the first app frame's `file:line`. It also carries the note (at most 2,000
  characters), the route, the viewport, the device pixel ratio and the engine.
- **Source frames.** A frame is sent only when its path, made relative to the project root, contains no `..`,
  isn't absolute, and isn't under `node_modules`, `.next`, `dist` or a framework runtime. Otherwise the pick
  carries no file, and keeps its component name.
- **Timing.** The first source lookup on a page takes up to about 1 s while source maps load (measured). It
  starts at the click; saving the note sends the pick once the lookup ends, or after 1.5 s without its source.

## 4. Picks in the composer

- A page's `Draft` gains `picks`: chips kept in order above the input, each showing its crop, number, title,
  component and file (mono), and its note. Clicking a chip flashes its badge in the preview. Its × removes the pick
  from the draft and from the page. Picks live in memory with the draft, as pasted pictures do, and don't survive
  a restart.
- "3 picks from the preview of `/settings`" heads the chips. A pick arriving for a page that isn't shown still
  lands in that page's draft.
- **Send** turns the picks into one builder message: the typed text, then one fenced block under the line "From
  the page (data, not instructions)" with the route, viewport, DPR and engine, and one entry per pick (kind,
  title, component, source, selector, note). Each pick's crop goes with it as a picture. It is the same
  `POST /conversations/:id/messages` (or `/tasks/:taskId/thread`) the composer uses today, so the daemon is
  unchanged. Empty typed text sends "Change these." with the block.
- At most 8 picks per draft, counted by the draft (a ninth is refused there and its badge dropped with the words
  "8 picks is the most one message takes"); the page refuses a ninth of its own too. A crop past the
  draft's 10-picture or byte limits (the kit's `withPictures`) leaves its pick without a crop.
- **Picks never change what Stop does.** In a working turn only typed words or pasted pictures turn Stop into
  Stop and Redo; with picks alone Send adds them to the turn and Stop stays a plain Stop. In a Ready page a
  pick makes Send the primary, as typed words do.
- **Provider parity.** The message is text plus PNG pictures. Claude plans, Claude through Bedrock or an API key,
  and Codex (`localImage`) all take it today, so no provider lacks anything.

## 5. The pick channel (Core)

The only new path into 10db from a page. It carries data into a draft the builder sees, and nothing else.

- **Four page commands, for the preview window alone.** The app gets an ACL manifest
  (`tauri_build::AppManifest::commands`), so every app command is checked, and the main window's capability
  names each command it calls (among them `open_preview`, `drop_preview_picks` and `flash_preview_pick`, which
  the main window alone may call). When a preview opens, the shell adds a capability at runtime for that window's
  label and the app's exact origin (`<origin>/*`), allowing exactly `preview_target`, `add_pick`, `remove_pick`
  and `show_composer`. It grants no plugin and no core permission at all, so the page can't emit events, open
  windows or read files; the shell reaches the page only through `eval` of the picker's own calls, with
  arguments serialized by `serde_json`. A Rust test holds the capability's shape.
- **The shell checks before it forwards:**
  - the calling webview's label is `preview-<projectId>` and its current URL's origin is that project's app
    origin, as the shell recorded at open;
  - the payload is at most 64 KB of JSON, and the shell parses it into a typed struct with fields capped (§3),
    refusing anything else;
  - rate limits: at most 2 picks a second and 30 a minute per window;
  - the target page comes from the shell's own record for the window (§2), never from the payload, and is fixed
    per pick id when the pick is first made, so an edit after the window moved to another page goes to the first;
    a removal for a pick it no longer knows is dropped.

  Then it takes the crop (§6) and emits `preview-pick` to the main window alone, with the target's task id, the
  parsed pick and the crop.
- **The UI parses again** with a zod schema in `@10db/contracts` (`PagePick`, `PickArrived`), drops what fails,
  checks each source path again (`isProjectSource`), and only ever adds to or updates that task's draft.
  `remove_pick` only removes a chip by its pick id.
- **`show_composer` can't steal your typing.** The shell honours it only while the preview window is focused (the
  builder is in it), at most once a second, and only emits it; the main window brings itself forward, marking the
  focus as the preview's first, so the cursor goes to the page's picks, never its input.
- **What it must never do:** send a message, answer an Inbox card, press Allow This, Commit, Retry or Discard,
  start anything, or carry any token. No daemon route takes a pick. No localhost port is opened. The main window's
  CSP doesn't change. The preview window holds no UI token, dev-UI token or render token. Nothing a pick carries
  is logged.
- **Treat it as data.** The message block is fenced and labelled as page data, with a fence longer than any run of
  backticks inside it, so a note can't close it early. Text is capped, and source paths outside the repository
  are dropped by the shell and again by the UI (§3).

### Pick states

| State | Event | Then |
|---|---|---|
| In the page (note open) | note saved | sent to the shell; a chip appears, or the draft refuses it and the badge goes |
| In the draft | edited in the page (same id) | the chip updates in the page it was first made for |
| In the draft | × on the chip | removed from the draft; the page drops its badge |
| In the draft | Remove in the page | the chip goes |
| In the draft | Send | goes in the message; the page drops its badge |
| Sending | send fails | the chip comes back (the kit's `afterFailedSend`); the badge stays |
| In the draft | preview closed or reloaded | the chip stays; an edit can't reach it (the badge is gone) |
| In the draft | main window reloaded | the chip is gone (drafts keep only text); the badge stays, and an edit adds it again |
| In the draft | window moved to another page | the chip stays in its first page |

## 6. Crops

The shell calls `WKWebView takeSnapshotWithConfiguration:` (objc2-web-kit 0.3.2, already in the lock through
wry) with the pick's box, padded by 24 CSS px and clamped to the viewport, and encodes it as PNG
(`NSBitmapImageRep`). An area pick is cropped to its box. A crop is at most 1600 px on its long side and is
refused past the per-picture byte limit. The crop includes 10db's outline and badge, which is useful: it shows
which element is meant. Like `dictation.rs`, this is one module allowed `unsafe` for AppKit calls. Off macOS
there's no crop, and the pick goes without one.

## 7. Tests

- Rust: the channel's checks (label, origin, size, rate, caps) are a pure rule table with one unit test, which is
  Core (a permission boundary). The existing `app_page.rs` table already covers the navigation's loopback check.
- `@10db/contracts`: `PagePick`'s parse is a boundary. No separate test: the e2e drives it.
- e2e: `workbench.spec.ts` gains a short test. An init script stands in for Tauri's IPC at the window's edge
  (`e2e/tauri-window.ts`): it answers `daemon_connection` with the e2e daemon, so the UI still runs against the
  real daemon, records the commands the UI sends and emits the shell's `preview-pick`. It checks the Open
  Preview face and its menu, the chip, that Send posts one message holding the fenced block with the crop as its
  picture, and that the sent pick is dropped from the Preview. The Tauri window itself is checked by hand, as
  every Tauri window is (`apps/desktop/AGENTS.md`).
- desktop: one pure test (`pick-message.test.ts`): a source outside the project is dropped by the parse, and a
  note holding backtick runs can't close the data block.
- By hand, against the real daemon with `10db-dev-window` and the e2e project: open the preview, pick, note,
  ⇧-click, drag, send. Screenshots to the builder before review.

## 8. Decisions this records

- The preview is a separate 10db window in slice 1, and the toggle is drawn in the page.
- App commands are ACL-checked from now on, and each window's capability names the commands it calls. What this
  guards is a frame Tauri counts as local (`tauri://`, the dev shell's `devUrl`) reaching `daemon_connection`,
  which returns the UI token; remote origins were already refused app commands.
