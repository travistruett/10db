# 10db answers simple stakeholder questions and routes the rest to the builder

- **Date:** 2026-11-24
- **Amends:** `decisions/2026-11-12-stakeholder-questions-run-on-the-inbox-card.md`, and spec S8 and S9 in
  `docs/superpowers/specs/2026-11-11-10db-stakeholder-questions-design.md` (§8.8)

## Decision

- **A reply is one of four kinds:** an answer, a simple question, a deeper question, or chatter. The judge's
  `reply_kind` sorts; with no judge a rule fallback does, and a lone recipient's questions still go to the writer.
  Groups are sorted only by the judge.
- **The judge sorts and the project's account writes.** The writer is the project's own account (Claude plan, API
  key, Bedrock or Codex plan). On Codex it runs through `completeWithCodex`, a tool-locked, network-off one-shot
  turn; `CodexAdapter.complete` still refuses for other callers. Where the lock or an account is missing the
  writer declines and the question goes to the builder.
- **Every question goes to the writer first.** Only a judge `builder_question` at or above its floor skips it.
  The writer leans toward answering and declines only for a call only the builder can make or facts it lacks. When
  a question goes to the builder, 10db says so once in the thread.
- **The writer's context is bounded:** the card, the task, the goal's title and description, and the lane agent's
  last six messages (never the builder's own). The answer is at most 700 characters and passes the outbound
  secret scan.
- **There is no cap on automated answers.** The runaway guard is that only a human's message is sorted or answered
  and each question message gets one answer. Only 10db's own bot's tagged lines count as 10db's or the
  builder's; forged metadata is ignored.
- **Automated answers skip review,** and are marked as automated and unreviewed.
- **The builder's reply from the Open card is held only for a secret.**
- **Provider parity:** the same on every account; where a provider cannot write, the question comes to the
  builder and Settings says so.
- **Protocol 15.** `StakeholderSendDto.returnedReason` gained `'asked'`, a value an older
  desktop cannot read, so `PROTOCOL_VERSION` goes from 14 to 15.

## Why

The builder's words: talk to 10db, and route to me what it cannot answer. Before this, any reply that was not a
letter answered the card as "In Mark's words", so "what is this for?" resumed the lane on a non-answer (the bug
that escaped). Relaying every clarification through the builder costs more than 10db answering from what it holds.

Turned down:

- **A judge that writes:** the judge only classifies; writing belongs to the project's account.
- **The Linear reporter's session:** a full agent session, far more than a one-shot answer needs.
- **Holding every automated answer for review:** it brings back the relay this removes.
