# One function chooses a step's model, from the persona, settings, patterns and tier

- **Date:** 2026-11-07
- **Amends:** `decisions/2026-10-28-routing-role-defaults.md` (its tiers, its choice inside a tier and its escalation order)

## Decision

`chooseModel` (`apps/daemon/src/routing/choose-model.ts`) is the one place that decides a step's model and effort.
The first of these decides what the step asks for: a persona's pin, the task's setting, a pattern (the project's
before the global ones, each by position), the role's setting (the project's before the global one), then Automatic.
A setting is a tier, a specific model, Top of tier or Automatic. A setting that names a model the account does not
offer, or one its maker has retired, takes the automatic choice of the role's tier, and the step's reason says so.

- **Pool.** Routing works on the profiles the project's account offers (`offeredProfiles`: the models its list names,
  at the efforts it names, minus those marked unusable; an account with no list yet is assumed to offer every profile
  of its provider). The account decides, not the project's `provider` column. Automatic routing picks only a profile
  that is enabled and ranked into a tier, so an Unknown, Superseded or Retired model is never picked unasked; a
  setting that names an Unknown model by hand is honoured while the account offers it.
- **Inside the pool.** Profiles with scores are routed as before: the cheapest that clears the step's need and
  floors, within the budget ceiling. A pool a setting narrowed that nothing in reaches the minimum takes its highest
  scoring profile. Profiles with no score are chosen by the tier: the cheapest model of the role's tier at the role's
  effort (ordered by output price), where the old table named the strongest model of a tier. A floor with no score
  to measure it by takes the tier's most expensive model, one effort up.
- **Top of tier** takes the most expensive model of the tier the step would otherwise land in, then the cheapest effort
  of it that clears the need (or the role's effort without scores). The seeded pattern for security, auth and
  migration work therefore moves a step from Opus to Fable and leaves a Fast or Balanced step where it was.
- **A tier override** an account sets swaps the tier's automatic choice only: it does not apply to Top of tier or to a
  model named by a setting.
- **Escalation** climbs by output price, then effort: the next dearer model at the nearest effort, then the next effort
  on the dearest. On a retry a pattern that applies only to retries is tried first.
- **Nothing to choose from.** An account with no routable model does not stop planning. The step holds the tier's name as
  its model (`strongest`, `balanced`, `fast`), no profile, the setting that decided and the reason `no model offered for
the <tier> tier`. A tier name is never a model to launch: the launcher must refuse it, and a later list re-resolves
  the step from its setting.

## Why

Naming Claude Code's four aliases in routing made every other model, and every other account, a special case; a
new model could not be reached without editing source. Tiers and prices come from the catalogue, so a model that joins
a tier is chosen by the same rules as the rest, and the builder's settings and patterns say when Fable or any other
model runs. Planning that throws when an account lists nothing could not tell the builder why, and it blocked the
board; a step that records its setting can be chosen again once a list arrives. The cheapest model of a tier is the
default because Strongest used to mean one model and now means two, and the builder asked for the dearer one by
setting, not by default.
