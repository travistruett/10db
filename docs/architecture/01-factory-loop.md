# 01 Factory loop

- **Status:** Locked
- **Scope:** The first slice of 10db (milestones M0–M4) and the repo baseline it is built on.
- **Summary:** The design is the spec at
  `docs/superpowers/specs/2026-10-13-10db-factory-loop-design.md`. Its decisions are rows 1–20 of
  `decisions.md`. Changes to it are new rows in `decisions.md` that name what they supersede; the
  spec text itself is not edited after this section was locked.

## Which model runs a step

One function, `chooseModel` (`apps/daemon/src/routing/choose-model.ts`), decides a step's model and effort from the
persona, the task's own setting, the patterns, the role's setting and then Automatic
(`decisions/2026-11-07-one-function-chooses-a-steps-model.md`, built). Its pool is what the project's account offers,
and a tier is filled by the account's override for it, else by price within the catalogue. The step records the setting
that decided and a reason. At each session start `resolveStep` keeps a planned model the account still offers and
otherwise chooses again, so a changed list or a refused model never strands a step. The catalogue, the tiers and the
account's overrides are `decisions/2026-11-07-models-come-from-a-catalogue.md` (built).

## The builder's check

A project with no gate command has no program to verify finished work, so the builder does
(`decisions/2026-10-28-optional-gate.md`, built).

- **Waiting.** When the last step is done, the workstream goes `RUNNING → VERIFYING → WAITING_HUMAN` with
  `nextAction.kind = 'builder_review'`, no session and no lease, and one `check` card that targets it and shows
  its changes. It holds its claims, and so its areas, while it waits. A second verify
  finds the live card and raises no second one, and brings a card that shows an older head up to the head
  being checked. A restart does not refresh a stale card: recovery raises a card only when none is live.
- **Approve.** In the write that resolves the card the workstream goes `WAITING_HUMAN → VERIFYING → DONE`, its
  claims are released and its lane is freed. Only this completes it.
- **Send back.** A note is required. It is recorded as builder evidence, the card resolves, and the workstream
  is queued as a fix on the step that did the work, one attempt on. The fix prompt carries the note, and the
  finished fix comes back for a check. Past the retry limit the workstream fails with the note kept; Retry
  restarts that step on its own model with the note still outstanding.
- **Recovery.** A restart finds the workstream parked on its card and leaves it, raising the card again only if
  it was closed some other way. It reads git only when the card has to be raised, and never completes or starts
  anything. A send back that was committed is queued as a fix and recovery keeps its note for a fresh session
  until a step that started later has acted on it.

## How review steps are chosen

**Built.** The task's rigor decides up front which reviewing steps its plan runs, and the runner asks no decision about
a step. A judge decision sizes the task's rigor and kinds (`task_rigor` and `task_kinds`, in `sizing/`). The retired
`review_size` decision only labels logged calls
([the decision](decisions/2026-11-13-each-rigor-sets-its-review-rounds-and-fix.md)).

- **The rigor's row.** Each rigor's playbook row names its steps
  (`DEFAULT_ROWS`, `apps/daemon/src/routing/playbook-defaults.ts`): Light runs Implement, Standard adds Review,
  Careful adds a Plan before Implement, and Critical adds Plan Review and QA. A project can override a row. A kind can
  add steps (`addsSteps`; the seeded migration kind adds Plan Review) or set a floor under the rigor (`minimumRigor`).
  `planSteps` (`apps/daemon/src/routing/plan-steps.ts`) turns the steps into the plan, and each reviewing step carries
  the row's review rounds (`rowProcess`).
- **Planned again at each step's end.** The steps still to come are planned again in the write that ends a step, so a
  rigor or playbook change applies at the next step boundary (`withCurrentPlan`). A plan made without a rigor, such as
  a merge resolution's, is fixed: it is never planned again and gets no safety net.
- **Light's safety net.** When an implement step passes its gate, or ends in a project with no gate command, and no
  review follows it in the plan, the runner reads the change (`reviewForcedAfter`, with the rules in
  `apps/daemon/src/runner/forced-review.ts`) and adds a Review when the change forces one:
  - an always-reviewed kind (the seeded security, auth, migration and dependency kinds);
  - more than 15 changed files, or more than 400 changed lines;
  - a binary file;
  - a path a hazard glob matches: the project's hazards, the stock ones (`migrations`, `deps`, `harness`), or the
    review-forcing paths: dependency manifests and lockfiles, `drizzle/**`, `migrations/**`, `.github/**`,
    `.claude/**`, `.codex/**`, `AGENTS.md` and `CLAUDE.md`;
  - a change that cannot be read.

  The added Review is planned like any added step, with Light's review rounds and the model and effort of the lowest
  rigor above Light that runs a review (Standard by default). Its reason begins `review added: <why>`.

- **Docs-only QA.** Where a QA step follows a review (Critical's), a change whose files all end in `.md` skips QA when
  the review approves, or ships at its round limit (`qaSkippedForDocs`). The transition's reason says
  "QA skipped: only docs changed".
