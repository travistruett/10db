# Every OpenRouter decision model, TypeSafe's included, is asked on one endpoint

- **Date:** 2026-11-25
- **Amends:** `decisions/2026-11-13-a-decisions-model-is-picked-from-openrouters-list.md` (which endpoint TypeSafe's
  models are called on)

## Decision

- The judge asks every OpenRouter decision model on `/api/alpha/decisions` (`DECISIONS_PATH` in
  `apps/daemon/src/judge/openrouter.ts`). `/api/v1/systemone` and `ModelApi.SystemOne` are gone. `ModelApi` is
  `decisions` or `chat`.
- A TypeSafe model (`typesafe/*`, `~typesafe/*`, `isTypeSafeModel`) is a decision model whether or not the list has
  been read, so one the list leaves out, such as `typesafe/jev-2`, still never goes to chat completions, which
  refuses decision models.
- Yes/no questions (`type: 'noul'`) go to the decisions endpoint for a TypeSafe model, or for any model the list
  names once it has been read. While the list is unread, any other model gets them as a chat model, as before. So
  the limits judge on Jev keeps working at daemon start, before the first read finishes.
- Every option of a choice question carries a string criterion, its own description or else its name. TypeSafe's
  null criterion is no longer sent.
- Chat completions, the model list, the picker and `PATCH /judge`'s test call are unchanged.

## Why

The split dated from when Jev was the only decision model. A live probe on 2026-11-23 asked all 40 models in
OpenRouter's decision list the same question on the builder's key. `typesafe/jev-1.13` and `typesafe/jev-1.14`
answered identically on both endpoints: the same choice, probabilities and confidence, at the same cost. So the
System One path is not needed for any model 10db offers, and one endpoint means one request shape, one parser and
one place to look when a call fails.

**The endpoint is still labelled alpha.** The check whether OpenRouter has moved it out of alpha could not run from
the implementing session: the sandbox refused openrouter.ai, and no fetch tool answered. The path stays the one
OpenRouter's model list names for every decision model, Jev's included. The risk is that the default model now
depends on an endpoint labelled alpha. If OpenRouter moves or changes it, every decision falls back to today's
rules. That shows in three places: the judge's outage card, `PATCH /judge`'s test call refusing to save a model,
and the model list's `endpoints` no longer naming `DECISIONS_PATH`, which marks every model `cantCall` in the
picker. The fix is then one constant. Keeping `systemone` as a hedge for one maker was turned down: a second path
for one maker costs every change to the judge, and failing over to it would hide the move instead of showing it.

The same probe found Respan's `span-01`, `span-01-lite` and `span-01-lite:free` refuse 10db's question shape (400:
they want plain-string instructions and criteria), while `span-02` answers. `PATCH /judge` already refuses saving
them with a visible 400, so nothing fails silently. Making them answer, or having the picker say why not, is a
follow-up task.

Provider parity: this is the OpenRouter path only. Decisions on an Anthropic or Bedrock account use the Messages
body and are unchanged, and a ChatGPT/Codex project's decisions run on whichever decisions account the builder set.
