# Task 6: answering the card

**Size: Core.** Read the index's Brief and Global Constraints first. Needs task 5.

## Files

- `apps/daemon/src/acceptance/card.ts`: `applyAcceptanceAnswer`.
- `apps/daemon/src/inbox/service.ts`:
  - validates `AcceptanceChoice`, and refuses Send back without a note;
  - calls `deps.onAcceptanceAnswer` inside the answering write;
  - never hands an `acceptance` card to `onParkedAnswer`;
  - `deliver` resolves it, as it does Check and Plan.
- `apps/daemon/src/daemon/start.ts`: wires `onAcceptanceAnswer` to `applyAcceptanceAnswer`.
- `apps/daemon/src/runner/runner.ts`: `settle` never parks on an `acceptance` card. Filter it out of
  `openItemsForWorkstream(...)` where a run picks the card it waits on.
- `apps/daemon/src/recovery/recover.ts`: never picks an `acceptance` card as the card a run waits on.
- `apps/daemon/src/inbox/human-touch.ts` and `packages/contracts/src/human-touch.ts`: count the kind.
- Desktop:
  - `inbox/kind-icons.ts` and `inbox/permission-labels.ts`;
  - `desktop/tauri.ts` (the notification text);
  - `inbox/inbox-card.tsx` and `open-inbox.tsx`: the criteria list, using the Check card's layout;
  - replace the stand-ins task 1 added.

## Interfaces

`applyAcceptanceAnswer(ctx, item, {choice, note?})`, as the index quotes it.
- **Accept** resolves the card. `acceptedCriteria` reads it from then on.
- **Send back** resolves the card and inserts one Ready follow-up task in the project:
  - title "Meet the acceptance criteria of <task>";
  - criteria: the card's listed criteria;
  - description: the builder's note, plus a link line to the original task.

  It doesn't touch the original run.

## State-table rows

- "Builder accepts on the card".
- "Builder sends back on the card".
- "Card answered while the Review waits on its own question".

## Spec sections

"The card".

## Tests

None new. Run the related tests for `inbox/service.ts` and `recovery/recover.ts`. The e2e in task 7 and the
click-through in task 8 show the card.
