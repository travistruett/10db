# The 10db window narrows to 420 px, the Workbench's narrow layout

- **Date:** 2026-11-09

## Decision

The main window's `minWidth` in `apps/desktop/src-tauri/tauri.conf.json` is 420 px (it was 900). The
height floor stays at 600 px. Under 768 px every view folds the sidebar behind the header's burger. `tests/repo/src/desktop-opener.test.ts` checks the value.

## Why

The Workbench is used as a narrow window beside the builder's browser, about 420 to 520 px wide (Workbench
spec §4.3, W3, D3); its narrow layout (the queue as a strip over the thread, the sidebar folded behind a
header button under 900 px) exists for that width. A 900 px floor kept the window from ever reaching it, so
the narrow layout could be seen only in a browser tab. 420 px is where the spec says the narrow layout
starts; the rendered tests draw the Workbench at 480.

Under the app shell's `sm` breakpoint (768 px) the shell's sidebar would cover the whole window, so every
view folds it behind the header's burger there, as the Workbench does under 900 px
(`apps/desktop/src/shell/app-layout.tsx`); between 768 and 900 px only the Workbench folds. Other views are
not otherwise laid out for 420 px. Keeping 900 px for every view but the Workbench would need the window's
floor to change with the route, which the Tauri window cannot do without a resize the builder did not ask
for; turned down.
