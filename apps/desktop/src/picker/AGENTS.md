# apps/desktop/src/picker

The picker that runs inside a project's Preview window (Pick on Page spec
`docs/superpowers/specs/2026-11-25-10db-pick-on-page-design.md` §3), not in 10db's own window.

- `picker-source.ts` (beside `vite.config.ts`) bundles `main.ts` with esbuild into one IIFE, served as
  `virtual:picker-source`. `desktop/preview.ts` imports it on the first Open Preview and hands it to the
  shell's `open_preview`, which wraps it in a check of `location.origin` and adds it as the window's
  initialization script. It runs in the page's own JavaScript world, so the page can see and forge anything it
  does: the shell and the UI check every pick again (`decisions/2026-11-25-a-preview-window-reaches-10db-only-through-five-checked-commands.md`).
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
- Its calls into the shell are `channel.ts`. The shell's calls into it are `window.__tendbPicker.drop(ids,
notice)` and `.flash(id)`, through `eval`.
