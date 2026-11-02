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
- **Card state:** a card says its task's state once, in one plain line with a dot, such as
  "Checking: make gate" or "Failed: the gate failed". The card's border and the dot take the status color
  (blue running, yellow waiting on you, orange paused, red failed); queued keeps the plain border. No
  fill, no left stripe, no pulsing. A card waiting on the builder is the most prominent: a full 2 px
  yellow border and "Waiting on you: answer in Inbox".
- **Goal strip:** a goal with open tasks is one slim line above the Board's columns, in the same scroll
  area as the batch strips: the goal's title, "6 of 11 tasks" and the status dot. Clicking it opens the goal's
  drawer. A goal is never a card in a column: cards are tasks, and the columns stay about tasks. Each of a
  goal's task cards carries the goal's title as a small dimmed label.
- **Goal status:** a goal says its status once, in a dot and one plain line, and the first match wins:
  failed (red: a goal task failed and isn't retried), waiting on you (yellow: an open Inbox card on one of its
  tasks), waiting on someone (yellow: a card owned by another person; from phase 3), paused (orange), running
  (blue: a goal task's run is active), shipping (blue: every task is done but a pull request isn't merged),
  not started (gray: nothing runs and tasks wait unstarted, such as "Not started · 11 tasks · Start Ready
  Tasks on the Board") and done (green: every task not cancelled is done and merged). Gray is queued, so a
  goal nobody has started is gray, not blue. Green is only for work that has merged: a goal with open pull
  requests is Shipping, in blue, never green.
- **Factory is one list, not cards:** goals are rows of one list separated by hairline dividers, and the open
  goal's area takes the `bg_1` fill. Rows take no borders and no shadows; cards stay the Board's draggable
  things. Each row is a button (`aria-expanded`) over a `role="region"`: title, status dot and one line, collapsed
  until opened, one open at a time. Order: failed, waiting on you, waiting on someone, paused, running,
  shipping, not started, the Ungrouped row, then done goals under one collapsed "Done (n)". News is plain text ("· 3 new since 3h ago"):
  no badge and no color.
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
