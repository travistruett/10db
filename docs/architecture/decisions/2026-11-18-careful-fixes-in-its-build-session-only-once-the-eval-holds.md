# Careful fixes a send-back in its Build session only once the eval holds

- **Date:** 2026-11-18
- **Amends:** `decisions/2026-11-13-each-rigor-sets-its-review-rounds-and-fix.md` (what decides Careful's `fixBy` default)

## Decision

Careful's default `fixBy` stays `fresh`; Critical's stays `fresh` too. A Careful task whose row says `resumed`
(a project or global playbook row, set in Settings) already continues in the build session that made the change
when its reviewer sends it back: the session resumes on its own model and effort, with the rejection's findings
in its prompt ("Its findings are below."), and falls back to a fresh session one profile up, once, when the
resume fails. `runner.test.ts` covers it for a Careful task with a Plan step before the Build.

The default turns to `resumed` only in a later change whose real eval report shows the keep rule holding
(`keepRule` in `apps/daemon/scripts/eval/compare.ts`: criteria met the same or better over the shared cases, and
no case met in the baseline met in neither run now). The eval runner takes `FIX_BY=resumed|fresh` to set the
rigor's `fixBy` on its own daemon's playbook for the run, and the report records and names it.

## Why

The change is wanted only if it scores the same or better, and this change could not carry the eval that says so:
no Careful baseline is committed, a real run spends usage, and a 10db lane's sandbox cannot read the transcripts
a real run needs. The fake agent cannot stand in: its reviewers always approve, so a fake run never sends work
back and shows nothing of `fixBy`. With no measurement, the rule says to leave the default where it is.

The trade the eval will weigh: a resumed fix keeps the build's context and reasoning, so it should repeat less
work; a fresh fix sees only the reviewer's notes, which keeps a second pair of eyes on the code and was the
reason Careful and Critical chose it.

Per provider: `fixBy` behaves the same on a Claude plan, Bedrock, an API key and a ChatGPT/Codex plan; a resume
uses the provider's own session id. The eval itself runs only on the default Claude account today.

Turned down: flipping the default without the eval (it breaks the keep rule this change is bound by); a fake-agent
report as evidence (it never sends work back).
