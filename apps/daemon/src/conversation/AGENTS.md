# apps/daemon/src/conversation

- `conversation/` (sessions spec §6.1) is what every conversation shares, whoever owns it (a chat, a Plan or a task's
  thread): the picture limits of each account (`picture-limits.ts`), the image budget a live session holds
  (`inline-budget.ts`, `picture-budget.ts`, `block-pictures.ts`), the checks a dropped file or pasted picture must
  pass (`file-check.ts`, `image-check.ts`, `pictures.ts`, which also keeps a picture under its hash), the delivery
  rules a builder message reaches a session by (`delivery-rules.ts`: the uuid it goes under, what an interrupt
  pushes again) and the library that applies them to one session over any conversation (`delivery.ts`, which
  `runner/lane-messages.ts` builds over the task's thread with the thread's words), and the builder-message intake
  (`intake.ts`: limits, pictures on disk first, the rows in one write). It holds the explore engine (sessions spec
  §6.3–§6.8, decision `decisions/2026-11-13-one-explore-engine-runs-sessions-and-plan.md`): `explore-state.ts` is
  §6.7's table as a pure reducer; `explore-engine.ts` keeps one runtime per conversation and applies the effects one
  at a time on its chain; `explore-session.ts` turns one open handle's events into live frames (`live-buffers.ts`,
  sent on `events/live-frames.ts`, never stored) and stored items, capped by `full-output.ts`, which keeps what an
  item leaves out on disk; `explore-recovery.ts` is what a start does for each conversation before the restart row;
  `explore-hooks.ts` is what an owner gives it. It imports none of `pass`, `pictures`, `mcp`, `screens`, `thread`,
  `shape` or `runner`.
