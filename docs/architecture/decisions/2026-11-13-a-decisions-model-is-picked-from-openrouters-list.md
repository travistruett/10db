# A decision's model is picked from OpenRouter's decision models, and saved only once it answers a test decision

- **Date:** 2026-11-13
- **Amends:** `decisions/2026-10-31-openrouter-makes-routine-decisions.md` (which endpoint a model is called on, and
  how a decision's model is set)

## Decision

- **Every decision model OpenRouter lists is callable.** OpenRouter's model list asked for
  `output_modalities=decisions` names `/api/alpha/decisions` as the endpoint for every decision model, TypeSafe's
  included. That endpoint takes System One's request (`{ model, state, questions }` with a `choice` question) and
  answers the same shape, except that a choice answer's `confidence` and `probabilities` are optional. The judge
  keeps TypeSafe's models (`typesafe/*`, `~typesafe/*`) on `/api/v1/systemone`, sends every other model the list
  names to `/api/alpha/decisions`, and sends a model the list leaves out to chat completions as before. With the list
  unreadable, a model is taken to be a decision model. An answer with neither a probability for its choice nor a
  confidence can't be held to a floor, so it is a fallback.
- **The daemon reads the list.** `GET /judge/models` answers the decision models (id, maker, name, whether it is a
  `~...-latest` router, price per million input and output tokens, and why 10db can't call it, if it can't), read
  without a key from OpenRouter and kept for 6 hours; an old copy outlives a failed read. The UI never calls
  openrouter.ai. With `TENDB_JUDGE=off` the route answers 409 and nothing is read.
- **A model 10db can't call is listed, disabled, with the reason**: one OpenRouter serves only for extractions, or
  one that reads no text. The handoff allowed leaving them out; listing them says why a known model is missing.
- **A model is saved only once it answers.** `PATCH /judge` that changes a decision's model first asks that model
  the connection test's decision with the key of the account decisions will run on. A failed call, an answer 10db
  can't use, or no key refuses the whole patch (400, naming the model and why) and saves nothing.
- Settings › Decisions picks the review decision's model from this list in a select grouped by maker, with each
  model's price and the `latest` routers, and asks for an OpenRouter key instead of listing when none is set. The
  picker takes the decision as a prop, so a later decision reuses it.

## Why

The builder asked to pick from the decision models OpenRouter offers rather than type an id (task
tsk_01a1d675-9225). The unfiltered `/models` list leaves decision models out, and a free-text id could name a model
that answers nothing 10db can read, which every decision then fell back from without a word in Settings. Testing the
model at save time turns that silent failure into a refusal the builder sees.

Turned down: moving TypeSafe to `/api/alpha/decisions` (the endpoint is alpha and may change; `systemone` is the one
10db has run on); dropping chat completions (a config saved before keeps working); recording each decision's
endpoint in its config (the list already says it, and a stale record would outlive a model moving).

Provider parity: decisions run on an OpenRouter account on every kind of account a project uses, so the picker and
the test never depend on the project's account.
