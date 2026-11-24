# Send on Its Own sends the first message too

- **Date:** 2026-11-24
- **Amends:** `docs/superpowers/specs/2026-11-11-10db-stakeholder-questions-design.md` (the `first_send` hold)

## Decision

A routed question is no longer held because it is the first message to a person. A person's send mode alone
decides: Send on Its Own sends every message to them, the first included, and Show Me Each Message First holds
each one for review. The scan hold and the daily limit stay. `heldBy` loses `first_send`; a stored row that
carries it reads as `review`. The person modal no longer says "The first message is always shown to you."

## Why

A question routed at 01:09 to a person on Send on Its Own waited seven hours for a first-send review while the
builder slept, and the person never saw it. Choosing Send on Its Own for a person is the builder's approval to
message them; a second, hidden gate on the first message made the setting mean something else. A builder who
wants to see messages to someone first chooses Show Me Each Message First.
