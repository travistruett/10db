# 10db design system

The UI is a dense operations console: many workstreams, one inbox, quick keyboard answers. It
favors legibility and calm over decoration.

- **Library:** Mantine 9 components and theme tokens only. Icons: Tabler, stroke 1.5, size 16
  in dense lists and 20 elsewhere.
- **Color scheme:** dark by default; light is a toggle and must be equally usable. Never hard-code
  colors; use theme tokens (`var(--mantine-color-…)`) so both schemes work.
- **Primary color:** teal. Status colors: blue = running, yellow = waiting on a human, orange =
  paused (limits), red = failed or flagged, green = done, gray = queued or cancelled.
- **Type:** system font stack; monospace for IDs, paths, commands and logs.
- **Density:** `size="sm"` controls in lists and tables; `md` in forms and dialogs.
- **Radius:** `md` everywhere.
- **Motion:** none beyond Mantine defaults.
- **Copy:** sentence case; say what happened and what to do next.
- **Accessibility:** jsx-a11y strict passes; every interactive control is reachable by keyboard and
  has a visible focus ring; axe runs in Playwright tests (M1b).
