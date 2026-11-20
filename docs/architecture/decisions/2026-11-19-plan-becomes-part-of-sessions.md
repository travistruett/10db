# A plan is part of a session, and the chat owns the conversation

- **Date:** 2026-11-19
- **Supersedes:** `decisions/2026-11-13-one-explore-engine-runs-sessions-and-plan.md`, where it gives Plan its own
  `ExploreOwnerHooks` owner beside Sessions' (the engine and its state table stand). Plan's rules from
  `decisions/2026-11-02-shape-session-and-convert.md` stand, except that a draft is no longer proposed by a press.

## Decision

- **One owner.** A plan points at its chat (`shapes.chat_id`, unique). The chat's hooks (`chat/hooks.ts`) own the
  conversation, and for a chat with a plan compose `PlanParts` (`shape/plan-parts.ts`): Plan's prompt, its digest,
  its intake, its read budget, its tools and its agents. Plan has no owner of its own and no second conversation
  UI; New Plan, `start_shape` and an import each make a session with its plan.
- **The session's profile wins.** A plan session runs with the builder's setup, its sandbox and the judge, as any
  session does. Plan's reviewers and researchers come along as 10db's own agents, named `tendb-scope`,
  `tendb-engineering`, `tendb-rehearsal`, `tendb-researcher` and `tendb-code-researcher`, left out where the
  account has no subagents and, for the researcher, no web.
- **The reviewer stamp is bookkeeping, not a limit.** `report_finding` is taken only from a subagent of one of
  those reviewer types, and `judgePlanTool` stamps the stored reviewer by dropping the prefix. A builder's own
  agent cannot report a finding, but nothing a reviewer says changes what a session may do.
- **No Propose press.** The agent files rows as things are decided; `propose_plan` has no gate. An imported row
  carries `PIN_IMPORTED`, which rounds keep as a whole and a re-import may replace; Unpin or Restore clears it.
  The "imported, re-import to change it" refusals go.
- **Accept never interrupts.** Accept is Convert; it works while a turn runs, never stops it, and starts nothing.
- **Jev's ShapeReady shadow is retired** (`JudgeDecision.ShapeReady`). It predicted a Propose press, which no
  longer happens.
- **Rehearse leaves the panel until slice 4.** Its engine, the `rehearse` route and the stored marks stay.
- **The forward migration** (0096) keeps a plan that fed the Board (a task's context, a landing group, or a link to
  a goal or task) as an archived session with its plan intact, its conversation re-owned by the chat and its effort
  copied across. It deletes every other plan with its rows and conversation. A deleted plan's `sessions` rows
  stay, naming no conversation and ended if one was open, so usage and cost totals do not move; the `sessions`
  check allows that. A plan's folder on disk is never swept.

## Why

- Two conversation UIs and two owners meant every setup, sandbox and judge change was made twice, and a plan
  session ran on a thinner profile than a session. A plan is a panel on the chat, so the chat is the one place to
  talk.
- A Propose press was a second way to start a turn beside the message; with rows filed as decided, the press, its
  lock and the shadow that predicted it have nothing left to do.
- Keeping plans that made tasks preserves every link from the Board, Factory and Knowledge; a plan that made
  nothing holds nothing a link needs. Keeping the sessions' rows keeps what the builder spent.
- Turned down: keeping a plan owner for imported plans (two code paths again), and sweeping deleted plans' folders
  in the migration (a migration should not touch disk; a later cleanup can).
