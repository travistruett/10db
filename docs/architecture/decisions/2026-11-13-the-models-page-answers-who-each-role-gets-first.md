# The Models page answers who each role gets first

- **Date:** 2026-11-13
- **Amends:** `decisions/2026-11-12-the-models-page-shows-the-routers-own-picks.md`

## Decision

Settings › Models and benchmarks is one page that opens on "Who each role gets", then one chart of Intelligence
against cost per task, then a calm table of every model. A model's detail is in the drawer.

- **One account drives the page.** A single Account select (the default account, else the first live one) prices
  the rows, asks for the picks and narrows the list to what the account runs. The Available on filter and the
  chart's own account select are gone, and so is "Show every account": with no live account the page says to add
  one.
- **The shaded area and the tier colours are gone.** The "strong enough and cheap" area, the series per tier and
  the legend are removed. Every point is gray, the frontier and its line are blue, and each role's pick is ringed
  violet, the colour of its dot in the roles table and of the Used by column. Violet, not orange, because orange is
  paused in `DESIGN.md`. The Pareto line, the need lines and the rings stay presentation, computed in the desktop
  from the rows and the daemon's picks.
- **The table is calmer.** A status is dimmed text after the name, never a pill; there is no row expansion; Input,
  Output and Speed move to the drawer, so the page has no Columns menu and no stored column layout. A row shows
  which roles use the model.

## Why

The question the builder came with is "which model does each role get, and is that the right size". The roles
table answers it before anything else, one account makes the answer unambiguous, and the chart and list support
it. Tier colours and a legend made the chart read as a ranking of tiers rather than of cost against Intelligence,
and a shaded area claimed more than the router promises. A pill per status turned a dense list into a row of
badges; dimmed text carries the same fact.
