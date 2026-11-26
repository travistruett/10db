# apps/desktop/src/picker

The picker that runs inside a project's Preview window (Pick on Page spec
`docs/superpowers/specs/2026-11-25-10db-pick-on-page-design.md` §3), not in 10db's own window.

- `picker-source.ts` (beside `vite.config.ts`) bundles `main.ts` with esbuild into one IIFE, served as
  `virtual:picker-source`. `desktop/preview.ts` imports it on the first Mark Up Page and hands it to the
  shell's `open_preview`, which wraps it in a check of `location.origin` and adds it as the window's
  initialization script. It runs in the page's own JavaScript world, so the page can see and forge anything it
  does: the shell and the UI check every pick again (`decisions/2026-11-25-a-preview-window-reaches-10db-only-through-five-checked-commands.md`).
  It hands Vite absolute watch paths: in dev Vite resolves each watched file as an import of the virtual
  module, and esbuild's relative paths don't resolve from one. It reads its own folder only inside `load`,
  because a config read under jsdom has no file URL. Keep `new URL('./src/picker/main.ts', import.meta.url)`
  as the entry: it is how knip finds the picker's files.
- It imports only types from `@10db/contracts`. Its values would bundle zod into every page (81 KB without,
  746 KB with), so the few limits it needs are written in `picker.ts` and checked again by the shell and the
  UI.
- `react-grab/primitives` (MIT) finds the element at a point and its component and source. Importing it
  installs React's devtools hook, so `main.ts` imports it at once and starts the overlay only once the document
  has loaded. `pick.ts` makes a dev server's path relative to the project and drops one that names the Mac's
  own folders. On WebKit a Next server component's frame resolves into Next's runtime, which the shell's
  source rule drops.
- `overlay.ts` draws in a closed shadow root with fixed Selenized colors, since the page has none of 10db's
  theme. Page text only ever goes in through `textContent`.
- The crop is the shell's WebKit snapshot of what is painted, so `send` hides the whole layer (badges, boxes,
  any open note) from the frame before `add_pick` until it answers; `shooting` counts the crops in flight.
- The note is moved by its header, never faded: a ⇧ held to type a capital must not hide it. Reopening the
  pick whose note is already open (a ⇧-click growing the group) keeps what is typed and where it was dragged.
- Its calls into the shell are `channel.ts`. The shell's calls into it are `window.__tendbPicker.drop(ids,
notice)` and `.flash(id)`, through `eval`.
