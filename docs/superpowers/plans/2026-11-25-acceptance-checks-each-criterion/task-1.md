# Task 1: contracts and schema

**Size: Core.** Read the index's Brief and Global Constraints first.

## Files

- `packages/contracts/src/acceptance.ts`, new. Export it from the package entry.
- `packages/contracts/src/judge.ts`:
  - two `JudgeDecision` keys;
  - `OPENROUTER_ACCEPTANCE_SECOND_MODEL`;
  - `JudgeConfig.decisions` and `JudgeConfigPatch` entries, each with a `.default` and `enabled: false`;
  - `DEFAULT_JUDGE_CONFIG`.
- `packages/contracts/src/states.ts`: `EvidenceKind.Acceptance` and `InboxKind.Acceptance`.
- `packages/contracts/src/entities.ts`:
  - the `fix` variant's `providerSessionId`;
  - `EvidenceDto.detail`;
  - `AcceptanceChoice` beside `CheckChoice`.
- `packages/contracts/src/steps.ts`: `WorkstreamStep.acceptanceSentBack` (optional, a non-negative integer).
- `packages/db/src/schema.ts`: `evidence.detail` as nullable JSON text. **Don't generate the migration** (task 8).
- `packages/db/src/store/evidence.ts` (or wherever evidence rows are read and written): read and write `detail`,
  parsed with `AcceptanceDetail` at the boundary.
- `packages/contracts/generated/`: regenerate with the repo's generator, never by hand.

## Interfaces

These are implemented exactly as the index quotes them:
- `AcceptanceVerdict`, `AcceptanceCriterionResult`, `AcceptanceDetail`, `AcceptanceChoice`, `AcceptanceChecking`,
  `AcceptanceFigures`;
- `JudgeDecision.Acceptance`, `JudgeDecision.AcceptanceSecond`, `OPENROUTER_ACCEPTANCE_SECOND_MODEL`;
- `EvidenceKind.Acceptance`, `InboxKind.Acceptance`;
- the `fix` variant;
- `EvidenceDto.detail`;
- `WorkstreamStep.acceptanceSentBack`.

## Notes

- `Record<InboxKind, …>` and `Record<JudgeDecision, …>` tables will fail typecheck in the daemon and desktop. Don't
  fix them here; tasks 2, 6 and 7 own them. To keep the branch building, add the minimal entries those tables need
  (a label, an icon, a zero count). Name them in the commit body so tasks 2 and 6 replace them.
- Stored `fix` actions without `providerSessionId` must still parse, which the `.default(null)` covers.

## Spec sections

"Decisions and providers", "The questions" (its Record paragraph), "Send-back" (its Fix rule bullet).

## Tests

None. These are types; the later cards' tests exercise them.
