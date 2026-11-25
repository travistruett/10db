# Task 2: the two decisions

**Size: Feature.** Read the index's Brief and Global Constraints first. Needs task 1.

## Files

- `apps/daemon/src/daemon/judge-services.ts`: `testKind` returns Nouls for `Acceptance` and `AcceptanceSecond`.
- `apps/daemon/src/daemon/decision-offer.ts`:
  - `defaultSecondOpinionModel(db, account, decision)` returns `OPENROUTER_SECOND_OPINION_MODEL` or
    `OPENROUTER_ACCEPTANCE_SECOND_MODEL` on OpenRouter, and the Balanced tier on Anthropic and Bedrock.
  - `defaultModelFor` uses it for both second-opinion decisions.
  - `settleSecondOpinionModel(ctx, account)` settles both second opinions. Wherever it patches, it patches only
    `model`, never `enabled`.
- `apps/desktop/src/views/settings/decision-catalogue.ts`: entries for both decisions. Copy them from
  `crosses_limit`/`crosses_limit_second` in the same voice:
  - "Acceptance: is each criterion met?" with the cheap model;
  - "Acceptance, second opinion" with the stronger model, asked only for criteria the first didn't read as met.
- `apps/desktop/src/views/settings/decision-numbers.ts` and `apps/desktop/src/test/judge-fixtures.ts`: entries.
- `tests/repo/src/model-names.test.ts`: allowlist `anthropic/claude-sonnet-5.5`.

## Interfaces

- It calls `JudgeDecision.Acceptance`, `JudgeDecision.AcceptanceSecond` and `OPENROUTER_ACCEPTANCE_SECOND_MODEL`, as
  the index quotes them.

## Spec sections

"Decisions and providers".

## Tests

None new. `judge-services.test.ts` already covers `testKind` through the wiring. Run it, along with the decision
offer's existing tests.
