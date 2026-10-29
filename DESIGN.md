# 10db design system

The UI is a dense operations console: many workstreams, one inbox, quick keyboard answers. It
favors legibility and calm over decoration.

- **Library:** Mantine 9 components and theme tokens only. Icons: Tabler, stroke 1.5, size 16
  in dense lists and 20 elsewhere.
- **Color scheme:** dark by default; light is a toggle and must be equally usable. Never hard-code
  colors; use theme tokens (`var(--mantine-color-…)`) so both schemes work.
- **Palette:** [Selenized](https://github.com/jan-warchol/selenized): Selenized dark paints the
  dark scheme and Selenized light the light one (`apps/desktop/src/theme.ts`), with every value
  exactly as Selenized defines it: never mixed, lightened or darkened, and never adjusted to reach a
  contrast ratio. Text is fg_0, bright text fg_1 and dimmed text dim_0, on bg_0; controls and
  light-variant backgrounds are bg_1, hovering on bg_2. An accent is drawn in its base value and
  hovers in its bright one; text on a filled accent is bg_0, as in reverse video. Every Mantine hue
  maps to a Selenized accent (teal is cyan, pink and grape are magenta, indigo is violet, lime is
  green), so no stock Mantine color appears.
- **Primary color:** blue. Status colors: blue = running, yellow = waiting on a human, orange =
  paused (limits), red = failed, green = done or ready, gray = queued or cancelled. Green is the only
  "OK" color; don't use cyan or teal for success. Every Inbox card waits on the builder, so its kind
  is yellow, a flag's too: red there would read as an error.
- **Type:** system font stack; monospace for IDs, paths, commands and logs.
- **Density:** `size="sm"` controls in lists and tables; `md` in forms and dialogs.
- **Board cards:** compact `Paper`s that drag from anywhere on the card, with no handle: a pointer drag
  starts after a few pixels of movement, so a click still opens the card, and Space picks a focused card
  up. A card that can't move (In progress, Blocked, Done) says why in a tooltip. The card's actions menu
  sits in its corner and keeps its own clicks and keys. Human columns sit left of the system columns;
  columns scroll horizontally on narrow windows.
- **Radius:** `md` everywhere.
- **Motion:** short eases, 150–200 ms, of opacity, color or shadow, for what appears as a side effect
  (an edge fade, a hint, a scroll shadow) and for drag feedback (the column a card would land in).
  Nothing moves for decoration.
- **Alerts:** an `Alert` is for something the builder must act on, such as a missing tool or a
  refused key. A condition that clears on its own, such as a rate-limited sync, is a dimmed
  `xs` line with an icon in the header of the view it affects.
- **Copy:** Title Case for buttons, menu items and the names of things, such as flows and columns
  ("Create Task", "Start Ready Tasks…", "Quick"); sentence case for labels, descriptions and messages.
  Say what happened and what to do next.
- **Buttons:** one filled primary per group. A standalone secondary action is `variant="default"`
  (bordered, neutral); `subtle` only inside dense rows and menus; never `outline` beside a filled
  primary, where its colored border competes with it.
- **Checks** mark the chosen row on the right, in `Select`, `MultiSelect`, `Combobox` and `Menu` alike.
- **Forms:** textareas autosize and start small (one or two rows). The actions sit `xl` below the last
  field. A field's error goes on the field; a submit's error goes beside its submit button, never
  above the form where it can be scrolled away.
- **Modals:** a form modal is centered, with a header and a footer of actions that stay put while its
  body scrolls.
- **Navigation:** nav links take the `md` radius, so their hover and active fills are rounded pills
  inset from the sidebar's edge. The fill marks where you are; no outline on each item.
- **Tables:** the identifying column (a name, a title) takes the spare width; numeric columns are
  right-aligned.
- **Accessibility:** jsx-a11y strict passes; every interactive control is reachable by keyboard and
  has a visible focus ring; axe runs in Playwright tests (M1b) with every rule but `color-contrast`,
  since contrast is whatever Selenized gives.
