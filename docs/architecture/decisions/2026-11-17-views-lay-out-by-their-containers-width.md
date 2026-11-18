# Views lay out by their container's width

- **Date:** 2026-11-17

## Decision

A view that changes layout with width (the Workbench's queue and thread, a session's composer, the Changes
drawer) measures its own root with `useElementSize`, not the window with `useViewportSize` or a media query. Only
the frame decides by the window's width (`useShellBand`), because the frame decides what its content gets.

## Why

The rail and panel take 52 to 312 px of the window, so a rule tuned to the window switches at the wrong width.
Plan already measured its container (`split-pane.tsx`).

Tests draw a view at a chosen width with `observeWidthsOf` (`src/test/sized-observer.ts`), since jsdom does no
layout.
