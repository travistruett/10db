# Models are ranked in four rungs, efficient to frontier

- **Date:** 2026-11-13
- **Amends:** `decisions/2026-11-07-models-come-from-a-catalogue.md` (the cut), `decisions/2026-10-28-routing-role-defaults.md` (the defaults)

## Decision

`ModelTier` is Efficient, Balanced, Capable and Frontier, weakest first. They replace Fast, Balanced and Strongest.

- **The names are the makers' own.** Anthropic's line is "lowest latency and price" (Haiku), "best combination of
  speed and intelligence" (Sonnet) and "most capable" (Opus, Fable); OpenAI's is "most efficient" (Luna), "balance
  intelligence and cost" (Terra) and "most capable, flagship" (Sol, Astra). Rungs are price bands of each
  maker's own ladder, so they match the makers' words on today's Claude prices (Haiku Efficient, Sonnet Balanced, Opus
  Capable, Fable Frontier), while on today's models.dev GPT prices Sol is Balanced. "Fast" goes: a tier was always a
  price band, never a speed.
- **The cut is a share of the maker's top live output price** (`catalogue/tiers.ts`):
  - Frontier: at least 0.9 of the maker's top price, so two listings of one model at nearby prices stay together.
    A maker with one model has only a Frontier.
  - Capable: at least 0.3.
  - Efficient: at most 0.1.
  - Balanced: the rest.

  Capable plus Frontier is exactly the old Strongest, and Efficient and Balanced are the old Fast and Balanced.
  Rungs are price bands: a model's rung is what its price says, not a ranking the makers promise.

- **Routing changes nothing except the split.** Every default, floor, Top of tier, override, tier setting and
  escalation picks the model it picked before, on every ladder where one maker's models are ranked together:
  - The role defaults are Capable for Plan, Plan review and Review, Balanced for Implement, Efficient for QA. A
    floored step's rung is Frontier.
  - Frontier is reached by a floor, by Top of tier, by score, by a setting or by escalation, never by a default.
  - A top pick (Top of tier, a floored step) from Capable takes the dearest model of Capable and Frontier
    together, and so does escalation's jump to the top of a tier, which is how the three-tier code behaved.
  - When the account offers nothing on the rung asked for, routing takes the nearest stronger rung that has
    models, else the nearest weaker one. On three tiers that was the old rule, which broke ties toward the
    stronger.
- **Stored values are mapped, not dropped.** Migration 0067 turns `fast` into `efficient` and `strongest` into
  `capable` in every stored `ModelSetting`, in a planned step's tier-named model, and in a profile's tier. An
  account's `tierOverrides.strongest` is copied to both `capable` and `frontier`, so each lands on the model the
  builder chose. The old names are no longer valid input, so `PROTOCOL_VERSION` is 9.
- **One behaviour does change.** A step scored by Intelligence under a Capable setting chooses among Capable
  models only. Under the old Strongest setting a high need could reach a Frontier model; it no longer does until
  the setting is Frontier or Automatic.

## Why

The three tiers were cut from one price ladder and named for a speed they never measured. Both makers now sell four
rungs and say what each is for, so the builder's words match the makers'. Splitting Strongest in two gives the
builder a way to say "Opus, not Fable" without naming a model, and keeping the split out of every default keeps a
plan, a floor or an escalation on the model it ran on yesterday.
