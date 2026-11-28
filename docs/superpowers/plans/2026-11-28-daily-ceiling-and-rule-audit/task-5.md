# Task 5: the Activity icon's dot

Read the index's Brief and Global Constraints first. Size: Small (one setting, two routes, one indicator), built on
tasks 2 and 3.

**Files:**

- New `packages/db/src/store/activity-attention.ts`: the app setting `activity.attention`, `{ since }`, read
  through zod; unreadable reads as `{ since: null }`.
- `packages/contracts/src/activity.ts`: `ActivityAttentionDto = { since: iso datetime | null }`. Additive.
- `apps/daemon/src/inbox/auto-ceiling-card.ts` and `apps/daemon/src/inbox/rule-asks-card.ts`: each calls
  `markActivityAttention(ctx)` in the write that raises its card, and posts a plain notice (no `decision`) saying
  what happened, so Activity lists it and the desktop's `notice.posted` handler refetches the dot.
- `apps/daemon/src/api/app.ts`: `GET /activity/attention`, `POST /activity/seen`.
- `apps/desktop/src/daemon/activity-queries.ts`: `useActivityAttention` under `activityKeys.all`, and the
  mutation; `apps/desktop/src/views/factory/activity-drawer.tsx`: the dot on `ActivityButton`.
- `apps/desktop/e2e/inbox-activity.spec.ts` (extended); `apps/desktop/src/views/factory/AGENTS.md`.

**Implements**, exactly: `markActivityAttention`, `clearActivityAttention`.

**Behavior.**

- The dot shows while `since` is not null. Nothing else sets it: not a decision, a notice, an undo, or Ask Me Next
  Time, which the builder did themselves.
- Opening the panel calls `POST /activity/seen`, which clears it. A second rule switch or ceiling after that sets
  it again.
- The dot is one for the app, not per project: the icon is the header's. The two notices carry their project, so
  the panel's project filter still finds them.
- The dot has an accessible name: the button reads "Activity, something changed" while it shows.

**Tests.** No unit test. Extend `inbox-activity.spec.ts`: after two undos of one rule the icon shows the dot, and
opening the panel removes it.

**Spec:** "6. Auditing what 10db decided" (the last bullet).
