# Stakeholder questions run on the Inbox card, in Slack, until a recipient answers

- **Date:** 2026-11-12
- **Amends:** `decisions/2026-11-08-the-inbox-holds-what-needs-the-builder.md`, and the goals spec
  (`docs/superpowers/specs/2026-10-29-10db-goals-design.md`) §9 and §12

## Decision

- **The loop runs on the card (S1).** A lane's `ask_human` card whose route names someone other than the
  builder is sent to them in Slack and answered from there. It needs neither the goal engine nor doors, so it
  is built now, not in goals phase 3. The goals spec's §12 phase 3 stakeholder loop is this.
- **Triage by the judge (S12).** Explicit routes (task, goal, area, category) choose the recipients when the
  card is made. When none matches, the judge's `question_route` chooses among the project's category and topic
  routes (floor 0.8); with no answer, the lane's topic and category are the fallback.
- **A conversation is approved by a recipient (S13).** Anyone a participant brings in can take part. The judge's
  `thread_answer` reads where the conversation landed and posts "Sounds like B"; a recipient's ✅, or a reply
  `approval_read` reads as approval, answers the card as theirs. Only a recipient's pick or approval is recorded
  in their name.
- **Ties are asked together (S14).** Every person matched at the winning scope is a recipient in one group DM;
  the first recipient's pick or approval decides, and a disagreement returns the card to the builder.
- **Replies count wherever people type.** A top-level message joins the conversation of that person's open
  send; with several open, `reply_match` picks one, or 10db asks "Which one is this for?".
- **Escalation is a 4-hour reminder and an 8-hour return,** both changeable in Settings › People, in place of
  the goals spec's §9 `humanWaitMinutes` for a routed question. A routed question parks its session at once.
- **The Inbox has two tabs.** Open holds what needs the builder, which keeps the promise of
  `decisions/2026-11-08-the-inbox-holds-what-needs-the-builder.md`; Waiting holds what the builder waits on
  someone else for. A card returns to Open when its timer returns it, a recipient disagrees, or Slack is
  disconnected.
- **The send lifecycle** follows `docs/superpowers/plans/2026-11-11-10db-stakeholder-questions-state-table.md`.
  Crash recovery finds a post by its `tendb_send` metadata, not a text hash.
- **The builder's name** comes from their own Slack member, picked in "Which one is you?" when Slack connects.
- **Per provider:** routing, sending, reading and agreeing run on the card and the send after the lane has
  asked, so they behave the same on a Claude plan, Claude through Bedrock or an API key, and a ChatGPT/Codex
  plan. The judge's four decisions read only the card and Slack; with no key each falls back to its rule.

## Why

The builder's stakeholders answer questions in Slack, not in 10db, and a lane blocked on a product or business
question waits on them anyway. The card already carries the question, its options and the parked session, so
the loop needs no new planning layer. A first live check showed a stakeholder replying at the top level despite
being asked to use the thread, so the thread instruction was dropped and top-level replies were made equal.
Reading approval by the judge rather than a fixed word list lets "Yes sir" approve. Waiting on someone else is
not the builder's work, so it gets its own tab rather than sitting in Open. A design that waited for goals
phase 3 was turned down: it would delay the loop behind the engine and doors, which it doesn't use.
