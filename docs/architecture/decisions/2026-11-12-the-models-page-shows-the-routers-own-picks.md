# The Models page shows the router's own picks

- **Date:** 2026-11-12
- **Amends:** `decisions/2026-11-12-every-role-routes-on-intelligence.md`

## Decision

Settings › Models and benchmarks draws Intelligence against cost per task, ringing for each role the model the
router itself chooses.

- **The picks are the daemon's.** `GET /models/picks?account=<id>` runs `chooseModel` for each role at its
  starting need (`ROLE_NEED`) on that account, Automatic, for a task with no risk tags and a project with no
  settings of its own: the global role settings and patterns, the role's default persona and the account's tier
  overrides apply. Role settings and patterns of a project, risk floors and budget ceilings are left out, and
  the panel says so. The desktop never routes.
- **Cost on an account is the router's own rule.** `costOnAccount` is the cost per task scaled by the account's
  output price over the maker's, and the maker's figure where the account has no per-token price. The router's
  budget ceiling and `GET /models?account=<id>` both call it, so a row, a pick and a ceiling agree.
- **The Pareto line, the need lines and the shaded area are presentation.** They are computed in the desktop
  from the rows and the picks (`views/settings/pareto.ts`, `rightsizing-series.ts`), and a ring is drawn only
  on a point the chart draws.

## Why

A chart that recomputed routing in the desktop would drift from what routing does the next time a rule changes,
and show a pick no task would get. Asking the daemon for the choice keeps the chart honest, and naming what the
choice leaves out keeps it from being read as a promise about any one task. The frontier and the area change
nothing a task does, so they stay with the view that draws them.
