# The context pack fills a token budget shelf by shelf, and every injection is an event

- **Date:** 2026-11-03
- **Amends:** decision 17 (what the context pack holds and how a session is briefed with it)

## Decision

**What is packed (K4).** A session's context pack carries, in order, the confirmed current **policies** in scope,
then the **heuristics** in scope, then the current **decisions** relevant to the task. They are filled greedily
into `CONTEXT_PACK_BUDGET_TOKENS` = 1500 estimated tokens, one constant with no per-project setting. An item's
cost is the line a session reads (`ceil(characters / 4)` of its rendered bullet, id and scope included), so the
budget counts what the prompt spends. An item that doesn't fit is skipped and the next one tried; the pack counts
what each shelf dropped.

- **In scope** means `you` (the builder's own, in every project), `project`, or `area` for an area the task lists or
  the workstream holds a live claim on. A record of another project, or of an area the task neither lists nor
  claims, is never packed.
- **Beliefs are not packed** (open decision 2). They are set aside before the most specific record per key is
  chosen, so a belief never hides a rule. `find_knowledge` still returns them.
- **One topic key at several scopes** (open decision 4): only the most specific enters (area, then project, then
  `you`); all of them stay listed in the Knowledge view.
- **Relevant decisions** are, in order: area-matched search hits, other hits by rank, area-matched decisions with no
  hit, newest first. When no hit applies, the area-matched decisions come first and the newest other current
  decisions in scope follow (`PACK_RECENT_LIMIT` = 5), so an area decision never crowds out the newest ones.
- **A broken decision index never stops a briefing.** `buildContextPack` catches the full-text error itself, with
  no flag and no card (the startup check has already logged and flagged it), and packs the policies, the
  heuristics, any area-matched decisions and the newest decisions. Only current records are listed, so a
  superseded, retired, withdrawn or proposed record cannot appear.

**How it reads.** `renderRules` and `renderDecisions` in `apps/daemon/src/knowledge/render.ts` turn the pack into
one bullet per record: `- [topic.key] statement {pri_…, scope}` for a policy or heuristic and
`- question -> choice (rationale) {dec_…, scope}` for a decision, where scope is `you`, `project` or `area:<name>`
so an agent can cite the id. Agent-written text is collapsed to one line so a statement cannot start a line of the
prompt's own. When something was left out, the prompt says how many of each shelf (`N records exceeded the budget
(policies: p, heuristics: h, decisions: d); call find_knowledge for them.`); with nothing to show and nothing
dropped it says no recorded decisions or principles apply. The bootstrap prompt, the post-compaction
re-injection and the Plan sessions' principles brief all render through the same functions, so every session
reads a rule the same way.

**Every injection is an event (K5, open decision 11).** Each time a pack goes into a session, a `context.packed`
event (entity `session`) records the workstream, the reason, the budget, the tokens used, the dropped counts and
the ids packed. Every session's bootstrap prompt carries the pack, so every session start is an injection: reason
`start` for a new conversation, `resume` for one that continues an earlier conversation (a resume or a delivered
answer), `compaction` for the re-injection after an emergency compaction. The event is written in the same
transaction as the row that makes the injection (the session row, or the compaction's deviation). No new column.

## Why

The budget stays small because an always-loaded core memory that grew failed a held-out eval (spec §9), and a
policy is shorter than a decision. Counting the rendered line, rather than the bare fields, keeps the ceiling
honest now that each line carries a 40-character id. Filling shelf by shelf, with counts, is what lets the prompt
say that something was left out instead of claiming nothing applies, and the event log is the record of what each
session was told: it needs no table of its own. A record that a briefing cannot read must not stop the lane, so
the search failure falls back to what needs no index. The alternatives turned down were a third shelf for beliefs,
a per-project budget (a `ProjectDto` field and a Settings control), packing every scope for a shared key, and
recording only `start` and `compaction` (a session continuing from a handoff is exactly one whose prompt carries
the pack).
