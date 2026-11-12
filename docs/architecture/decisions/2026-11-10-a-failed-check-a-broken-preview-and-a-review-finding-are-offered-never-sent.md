# A failed check, a broken preview and a review finding are offered, never sent

- **Date:** 2026-11-10
- **Amends:** `decisions/2026-10-31-notices-not-cards.md`

## Decision

What 10db finds about a Workbench page's work (the check after a turn, a preview the turn broke, a finding of
the pass's one review) is a notice with Send to Agent: a thread notice on the page it names and, for a check,
a header notice in the pass. 10db never sends one to the agent by itself, never starts a turn for it and never
moves an `attempt`. The builder's click sends the offered text as the builder's own message
(`POST /tasks/:taskId/thread/:messageId/send-to-agent`), which starts the turn; a thread notice is sent once.
An offer is at most one message long (`TASK_MESSAGE_MAX_CHARS`): the end of a long output is kept.

## Why

Workbench spec D19, §8.1, §8.2: the builder is in the loop on every page. An automatic fix turn would race the
builder's own message, spend a turn on a failure the builder may already be fixing by hand, and, for a check
that names a neighbour's file, set a task to work outside its page. A notice is what
`decisions/2026-10-31-notices-not-cards.md` chose for news that needs no answer; Send to Agent makes acting on
it one click.
