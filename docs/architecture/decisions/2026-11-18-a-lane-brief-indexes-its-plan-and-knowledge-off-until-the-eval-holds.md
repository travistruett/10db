# A lane's brief indexes its plan and knowledge only once the eval holds

- **Date:** 2026-11-18

## Decision

A lane's brief can carry its task's Plan and knowledge as an index instead of pasting them. The daemon setting
`TENDB_LANE_BRIEF` chooses (`env.ts`; `LaneBrief` in `apps/daemon/src/briefing/lane-brief.ts`), and the runner
passes it to both the session prompt and the re-injection after a compaction, so a compacted session reads what
it started with. Absent or `full` is today's brief. With `index`:

- the Plan block names the task's section, the shared sections and each cited entry by its ref or key, says to
  read the section with `get_plan_section` before starting, and points to `get_plan_entry` and
  `find_plan_entries`. No section text, choice, rationale or quote is pasted;
- each recorded decision is named by its question, id and scope, with one line pointing to `find_knowledge`
  for its choice and rationale. Policies and heuristics stay whole: they are short and binding, and a lane can't
  look up a rule it doesn't know exists;
- a Claude lane's brief leaves out the claims bullet and the commit-tool bullet, whose guard refusals already
  name `request_claim` and the 10db commit tool. The dependency bullet stays, and a Codex lane keeps all three.

The setting ships off. `index` becomes the default only in a later change whose real Careful eval report shows
the keep rule holding (`keepRule` in `apps/daemon/scripts/eval/compare.ts`). If it fails, that change removes
the switch and says why. `make eval BRIEF=index` sets it on the eval daemon, and the report records it.

The refusal of a dependency command that needs the unclaimed `deps` hazard now also names `install_dependencies`
and says never to run `pnpm add` or `pnpm install` itself. `DEPS_HAZARD` in `@10db/contracts` names the stock
hazard everywhere the daemon used the literal.

## Why

Anthropic's guidance for agents is to let the model fetch context through tools instead of having code paste
it in, and to keep a change only if the end-to-end eval scores the same or better. A typical Careful build
brief halves (about 3,531 to 1,755 tokens by the four-characters-a-token estimate;
`apps/daemon/evals/lane-pipeline/reports/2026-11-18-careful-lane-brief-index.md`), but whether lanes still
read what they need can only be measured with a real model. This change can't run that eval: no Careful
baseline is committed, a real run spends usage, and a 10db lane's sandbox can't read the transcripts it needs.
With no measurement, the keep rule says to leave the default where it is.

The dependency bullet stays because the refusal isn't always what the lane meets. A lane that holds the `deps`
hazard and runs `pnpm install` is let through by the guard. If someone is watching the task, the broker then
raises a card that waits for a person and names no tool. The Codex bullets stay because nothing recorded shows
that Codex hands a hook's deny reason to the model.

The setting is daemon-wide rather than a playbook column: the brief is not a per-rigor process choice, a column
needs a migration, a contracts change and a UI, and the eval runs one rigor per daemon, so a daemon switch
measures the same thing.

Per provider: on a Claude plan, Bedrock and an API key, the brief is the same. A ChatGPT/Codex plan gets the
Plan and knowledge index and keeps every rule bullet. The eval runs only on the default Claude account today.

Turned down: making `index` the default without the eval (it breaks the keep rule); dropping the dependency
bullet (an attended lane would meet a card naming no tool); a per-rigor playbook column (well past one pull
request, and measures nothing more).
