# Task 7: pictures

**Size inside the plan:** Feature-sized code in a Core plan. **Read:** the index's brief and Global Constraints;
spec §6 "Pictures and Slack". Clear `pictures/pictures.ts` with the coordinator first (Global Constraints, peer
ownership).

## Files

- `apps/daemon/src/pictures/picture-routes.ts:74-82`: `takesPictures` is true for a task whose batch
  `isLocalCopy`, as for a Your-folder task naming a routed page.
- `apps/daemon/src/pictures/pictures.ts`: the after of a copy task is asked on its batch's SHIPPED transition
  (`batch.changed`), not on its workstream's DONE; start-up's catch-up also asks afters for copy tasks whose batch
  shipped in the last `MISSED_AFTER_MS` with none.
- `apps/daemon/src/pictures/AGENTS.md`: the note.

## Behavior

The before is unchanged: asked at first launch under `before-rule.ts`. Slack is unchanged: `onAfterCapture` →
`announceTask`.

## State-table rows

`landed` (the after).

## Tests

None. The hookup is two conditions on tested paths; the pilot checks the posts.

## Done when

Typecheck, lint, related tests, `make precheck`.
