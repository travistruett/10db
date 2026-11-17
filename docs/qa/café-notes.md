# Sessions QA notes

- **Before review:** a sessions UI change gets a click-through and an e2e against the real daemon. The e2e is
  `apps/desktop/e2e/sessions.spec.ts`. The root `AGENTS.md` asks for one or the other; the sessions roadmap asks
  for both (`docs/superpowers/plans/2026-11-12-10db-sessions-roadmap.md`, "How each milestone runs").
- **Click-through:** run it once against the real daemon, in dark and light, on invented data, as the models
  click-throughs did (`docs/superpowers/plans/2026-11-16-10db-sessions-m7.md`;
  `docs/superpowers/plans/2026-11-13-models-page-polish.md`).
- **In the PR:** put the click-through result under "How it was checked" in the pull request
  (`.github/pull_request_template.md`), as the sessions M1 plan's PR body did
  (`docs/superpowers/plans/2026-11-12-10db-sessions-m1-foundations.md`).
