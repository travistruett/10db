# apps/daemon/src/takeover

A chat continued in the builder's own terminal (sessions spec §7.5): Open in Terminal, Copy the Command, a second
window, Hand Back.

- `service.ts` runs every call for one chat in order on that chat's chain (open, again, command, Hand Back, archive).
  Messages and Stop go to the engine, which refuses them by state. `stop()` aborts what is preparing or opening and
  waits for the chains; a chat already taken over stays so, for Again or Hand Back. `recover()` at start removes the
  files of every chat that isn't `taken_over`.
- The open takes the folder with `folderHold.takeOver` (blockers re-checked in the same synchronous call as the
  state write, and the chat's archived row re-read there, since an archived chat has no retired flag after a
  restart). Hand Back holds the chat's starts, gives the folder back (waiting git work is handed it first), then
  parks the held messages on the folder.
- `files.ts`: everything lives in `<data dir>/takeovers/<conversation id>/` (outside the chat's own files, which its session may read; mode 700; the script 700, the rest
  600). A link at the takeovers folder, the takeover folder or a file is refused or unlinked, never followed.
  `takeover.json` is display data read through zod (the app, the start time, the temp dirs and the latest launch's notes, each cut on read); nothing runs or is deleted from it. `takeoverOf` merges those notes with the account's, so the banner shows what the open left out.
- Hand Back and archive remove each set in turn and log one that won't go; the folder is always tried, and a folder that won't go is logged, never thrown, since the chat is already given back (the next start sweeps it). `ended()`
  hands the hold back for any chat, since the agent-writable folder says nothing the row doesn't.
- `prepare.ts` writes one set of files per launch and never reads them back: the terminal's agent can write there.
  Earlier sets stay until Hand Back, since an earlier window may use them.
- `render.ts` is the pure script and line; the line is for zsh and bash, not fish.
- `opener.ts` is the only place 10db starts the terminal: `/usr/bin/open -a Terminal|iTerm <script>`.
- With no sandbox runtime (`start.ts`) a terminal still opens, without the chat's servers, plugins or instructions, and a note says so (the preview names it too, through the `setupNotes` dep). Each note is cut at 800 characters without splitting a surrogate pair (`note-cap.ts`), since a long list of skills left out would fill the popover.
