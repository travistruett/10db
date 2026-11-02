# 10db makes routine decisions with fast models through OpenRouter

**Status:** designed on 2026-10-31; built by `docs/superpowers/plans/2026-10-31-10db-openrouter-decisions.md`.
**Decision:** `docs/architecture/decisions/2026-10-31-openrouter-makes-routine-decisions.md`.

## 1. Intent

10db is slow because it does the same amount of process for every task, whatever the task needs. From 10db's own
event log (2026-10-31): 45 finished tasks averaged 7.3 hours of wall time and 36 minutes of sessions. Every task
paid for a review step, a lane queue and a session for it, and 36 of 44 reviews sent nothing back.

Many of those calls are small judgments a fast, cheap model makes well in a fraction of a second, for a fraction of
a cent: TypeSafe's System One model Jev costs $0.042 per million input tokens, so a 5,000-token call is about
$0.0002. The builder wants every such model reached through OpenRouter, with one key, so the model behind each
decision can change without code.

**Goals**

1. One way for the daemon to ask a model a typed question through OpenRouter (the **judge**), with the key in the
   Keychain, a timeout, and today's rule as the answer whenever the model is off, slow, failing or unsure.
2. Every judge call logged with what was asked, what came back and what 10db did, and shown in Settings.
3. A Settings section where the builder sets or replaces the key, tests the connection, and turns each decision on
   or off and picks its model.
4. The first decision: **does this change need its review step?** It acts from day one.

**Non-goals:** permissions (lanes use Claude Code's auto mode for those,
the decision that lanes run in auto mode inside the sandbox, 2026-10-31); the decisions that come next (rerun or fix a
red CI check, how much to check on the Mac, a task's steps, model and effort, areas from a task's words), which plug
into the same judge later; running lanes on OpenRouter models.

**Anti-goals:** a model answer that loosens a boundary (the sandbox, the guard, claims, a hazard); a decision that
cannot fall back to today's rule; a key in a file, a log, the database or a response.

## 2. The judge

`apps/daemon/src/judge/` owns it.

- **Interface.** `judge.choose({ decision, model, state, question, options, timeoutMs })` returns
  `{ kind: 'answered', choice, confidence, model, latencyMs, costUsd }` or
  `{ kind: 'fallback', reason: 'off' | 'no_key' | 'timeout' | 'error', detail }`. It never throws; the caller
  applies today's rule on any fallback. `options` is a non-empty list of named choices; `confidence` is 0..1.
- **Two call shapes, one key.** OpenRouter serves TypeSafe's System One models (`typesafe/jev-*`) on
  `POST https://openrouter.ai/api/v1/systemone` (TypeSafe's request shape: `model`, `state`, named `questions`
  with `type: 'choice'`; the answer carries per-option probabilities) and every other model on
  `POST https://openrouter.ai/api/v1/chat/completions` with a JSON-schema response format asking for
  `{ choice, confidence }`. The judge picks the shape from the model id. Both responses are parsed with zod; a
  response that does not parse is a fallback with `error`. No SDK: `fetch`, injected for tests.
- **Key.** Keychain service `10db`, account `openrouter-api-key`, read through the existing `Keychain`
  (`apps/daemon/src/environment/keychain.ts`) on each call, never cached, logged, stored in the database or
  returned by the API. `TENDB_JUDGE=off` keeps a daemon from reading the key or calling OpenRouter, as
  `TENDB_BENCHMARKS=off` does for Artificial Analysis; the test projects, the live acceptance daemon and
  `scripts/dev.sh` set it.
- **Config** is one app setting (`app_settings` key `judge`, zod-validated on read): `enabled` (default true) and,
  per decision, `{ enabled, model, floor }`. A missing or invalid value reads as the defaults.
- **Log.** Table `judge_calls`: id, decision, model, the state and question sent (the text 10db built, never a
  secret), the answer and confidence, latency, cost when OpenRouter reports it, the outcome (`acted`,
  `below_floor`, `fallback_off`, `fallback_no_key`, `fallback_timeout`, `fallback_error`, and `stopped` for a
  call a cancel or a shutdown cut short, which Settings › Decisions words as stopped, not failed), the workstream
  when there is one, and the time. Rows older than 30 days are deleted at startup.

## 3. Settings › Decisions

A new app-wide section, "Decisions", beside Models:

- **OpenRouter key:** "Set" or "Not set", never the key. Set or Replace opens a masked field; Remove deletes the
  Keychain item. The daemon writes the Keychain; the desktop never holds the key after sending it.
- **Test connection:** one tiny call on the review decision's model; shows the model, latency and cost, or the
  error in plain words.
- **Use fast models for routine decisions:** the master switch.
- **Per decision** (one row today, "Skip review for small, well-tested changes"): on or off, the model (a text
  field with the default filled in), and the confidence it must reach.
- **Recent decisions:** the last 20 judge calls: when, which decision, the model, the answer and confidence, and
  what 10db did, each linking its task (the board opens that task's drawer: `/board?task=<id>`).

## 4. The first decision: review size

Where: the runner, when a step's gate has passed and the next step is `review`
(`apps/daemon/src/runner/runner.ts`, the `gate passed; next:` transition), the same place the docs-only rule skips
QA.

- **Rules first, always review:** the task has a `security`, `auth`, `migration` or `dependency` risk tag; the
  review step is pinned; the diff against the batch's base is over 400 changed lines or touches over 15 files;
  the change holds a binary file, or touches a dependency manifest or lockfile, a migration, a CI or workflow file
  (`.github/**`), a protected path (`.claude/**`, `.codex/**`, `AGENTS.md`, `CLAUDE.md`) or any path in one of the
  project's hazards; the judge or this decision is off. Then the review runs, as today, and no call is made.
- **Otherwise ask** (timeout 4 s): state is the task's title, description and criteria, the diff's file list and
  stat, the diff itself capped at 24 KB (marked `[diff cut at 24 KB]` when it was), and that the gate passed (never its
  output). The task text and the diff are fenced as data, not instructions. Question: "Does this change need an independent
  code review before it ships, or is it small, clear and covered by its tests?" Options `review` and `skip`.
  The default model is `typesafe/jev-1.13`; the default floor is 0.8.
- **Skip** only when the answer is `skip` at or above the floor. The review step is marked skipped, with the reason
  "skipped by <model> (<confidence>): <the question's short answer>", and the workstream moves to the step after
  it, or is done, exactly as a skipped QA does; a QA step that then follows still skips when only Markdown changed. Every other answer, and every fallback, runs the review.
- The full gate after the step has already passed, and CI still decides before the pull request merges.

## 5. Security and data

The state sent to OpenRouter (task text and a capped diff) leaves the machine for OpenRouter and the model's
provider; TypeSafe does not train on it, and zero retention is enterprise-only. The builder accepted this by adding
the key. Nothing else is sent: no key, no environment, no paths outside the repository. The diff is text a lane
wrote, and System One models do not treat their state as hostile, so the decision a model makes is limited to
**skipping a review**, and a change to the files a diff cannot show the weight of (manifests, migrations, CI, protected paths, binaries) is never asked about: the gate has passed and CI still runs, so the worst case is a missed review finding, not a
loosened boundary.

## 6. Testing

Table-driven, red first: the judge's two response shapes and each fallback (off, no key, timeout, HTTP error,
unparseable), with an injected `fetch` and clock; the config's defaults and invalid values; the API never
returning the key; review size's rule rows (each forces review with no call), an answer above and below the floor,
and each fallback running the review; the Settings section's states (key set or not, test success and failure).
