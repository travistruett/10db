# The desktop UI paints Selenized exactly, with no contrast floor

- **Date:** 2026-10-28
- **Supersedes:** the M1b plan's WCAG AA theme step
  (`docs/superpowers/plans/2026-10-13-10db-03-m1b-sessions-and-ui.md`, "Make the theme meet WCAG AA in
  both color schemes")

## Decision

Every color the desktop UI paints is a value from [Selenized](https://github.com/jan-warchol/selenized)
as its `the-values.md` gives it: Selenized dark in the dark scheme, Selenized light in the light one
(`apps/desktop/src/selenized.ts`, `apps/desktop/src/theme.ts`). No value is mixed, lightened or darkened,
and none is moved to reach a contrast ratio. `apps/desktop/src/theme.test.ts` checks that every color
variable Mantine renders resolves to a value from the scheme's variant.

There is no contrast floor. The theme has no WCAG AA check, and the E2E's axe run disables its
`color-contrast` rule while keeping every other `wcag2a` and `wcag2aa` rule.

## Why

The builder chose Selenized for how it looks and wants it followed exactly. Holding text to 4.5:1
moved Selenized's accents away from their values: Selenized dark's bright green reaches about 4.2:1 on
its own tinted background, so a light-variant check icon had to be lightened to a pale green, and its
background mixed toward olive. Selenized sets its own contrast, by choosing its lightness values in CIELAB.

Turned down: keeping the 4.5:1 floor for text only and 3:1 for icons. That still moves Selenized's
values for text.
