# A standing approval is a precedent the judge weighs, and it never clears a limit

- **Date:** 2026-11-25
- **Amends:** `decisions/2026-11-24-the-limits-judge-asks-a-question-per-limit.md` (one more question and one more
  step in reading the answers) and `decisions/2026-11-12-10db-trusts-the-developer-and-contains-the-agent.md`
  (what the builder's answer to a skipped call becomes). The design is
  `docs/superpowers/specs/2026-11-25-failures-reach-you-only-when-you-can-act-design.md`. Designed, not built.

## Decision

1. **The builder's answer to a kind of skipped call is kept as a precedent.** A row of `trust_precedents` holds the
   project, the program the kind runs (its program key), a scope (`copy` or `project`), one line naming the kind
   and up to five calls the builder saw. One row per project, key and scope. A `project` row covers every
   session of the project, copies included; a `copy` row covers sessions in a separate copy only, and a copy
   session reads it ahead of the `project` row.
2. **A precedent is evidence, read by a judge.** 10db's judge sees the one precedent whose key and scope match
   the call, as the state's `builder_precedent`, and is asked `precedent_applies`: is the call that kind of
   command and nothing more. Claude's auto mode reads each active precedent as an environment line, on every
   surface, and never as an allow line: an allow line there is an exception to a soft deny, which the four limits
   are in a chat and Claude's own defaults are in a lane. No call is allowed by matching text, so nothing is
   stored as a quoted-call grant either.
3. **It never clears a limit.** `readLimitAnswers` reads `builder_allowed`, then the limits, as before. Only after
   them: `precedent_applies` at or above the floor allows a call whose likeliest limit is under one half. A call
   at or over the floor on any limit is that limit, whatever the precedent says. A call between one half and the
   floor goes to the second opinion as it does today.
4. **Only a doubt becomes a candidate.** A kind is proposed only from 10db's own judge's rows: its skips that
   name no limit and the calls it left unclear. A denial by auto mode is never a candidate, since it names a
   limit only when its reason holds the label. A skip at a named limit stays a limit card, where Always in this project stores a
   grant in the builder's words; a grant can still allow a call over a limit.
5. **10db withholds a precedent, and judges the call as before, when** the call has no program key (a second
   command, a substitution, a here-document), or a file the call runs is not the base's: changed in the checkout, or created
   there. For a package runner's key that file is the `package.json` naming the script. These are rules for the judge's integrity; they allow nothing.
6. **A precedent that proves wrong stops itself.** Each freshly judged call where it applies and a limit is named
   counts a conflict; a verdict answered from the session's memory counts nothing, so one call repeated is one
   conflict. Three since it was approved or last kept pause it and raise one card. Paused, declined and removed precedents are shown to
   no judge.
7. **A change to what the kind runs is told, not blocked.** The judge reads the new committed text and is told the
   kind changed since it was approved; the builder gets a notice with Remove.
8. **The builder sees and removes them** in Settings › This Project › Trust, each with its uses and the last calls
   it allowed. A declined or removed kind is listed there and can be approved again. 10db's judge reads the rows
   on every call; a running auto mode session drops a removed line at its next start.
9. **Parity.** Steps 3 and 6 are 10db's judge's. Where auto mode judges, its own hard denies hold the four limits.
   With no Decisions account there are no rows of 10db's judge to propose from: no card is raised, and Settings
   says standing approvals need a Decisions account. A follow-up closes that gap.

## Why

- **Approvals didn't carry over.** Run these now approves a call "as written" for one follow-up session
  (`approvedLine`). On 2026-11-25 the same kinds were skipped again on the next task: 106 skips with no limit
  named in 25 hours, 64 of them two programs across 10 runs each.
- **The doubt is structural, not about the command.** Of 1,487 calls the judge allowed after the floor went to
  0.65, 77 scored 0.65–0.8. In each one read, the likeliest limit was Reading Secrets at 0.21–0.30: the judge's
  doubt about any program it can't see inside. At 0.8 those calls are unclear by a few points. Wording can't
  remove that; the builder saying "this kind is routine here" can.
- **Why a question of its own.** `builder_allowed` at the floor allows a call even over a limit, which is right
  for the builder's own words about a call they read. A kind is wider than any call the builder read, and its
  line starts as 10db's template. Read through `builder_allowed`, a broad kind could carry a destructive call past
  a limit. Read after the limits and under one half, the worst a bad precedent does is run a call the judge
  already thought more likely safe than not, inside the sandbox.
- **Why one half.** Under it the judge thinks the call is more likely safe than not; the floor's extra margin is
  what the builder's answer buys. `readLimitAnswers` already refuses to read a floor under one half.
- **Turned down:**
  - _An allowlist of commands_ (`make t *` runs). A rule can't bound what the program then runs
    (`decisions/2026-10-29-sandbox-is-the-boundary.md`), and the trust decision keeps rules for integrity and
    coordination only.
  - _Lowering the floor_, per project or for everyone. It widens every call, the ones nobody approved included.
    The 0.65 stopgap did this.
  - _Writing the kind as a grant line._ See "a question of its own".
  - _Storing the examples as quoted-call grants where no model can weigh a kind._ A quoted-call grant is matched
    in the hook ahead of every judge. That is the text match this decision refuses, and Remove would leave it
    live.
  - _Auto mode allow lines._ Plan review found an allow line clears a soft deny, so an approved kind would lift
    a limit in a chat and one of Claude's own default denies in a lane.
  - _Pausing a precedent whenever its script changes._ Each merge to a Makefile would stall unattended work
    until the builder answered, which the trust decision calls a bug.
  - _A model writing each kind's description._ The card shows the committed text the kind runs instead, which is
    what the builder would check a summary against.
