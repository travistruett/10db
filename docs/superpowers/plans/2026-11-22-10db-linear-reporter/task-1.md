# Card 1: contracts, the `linear_posts` table and store, the Reporter owner kind

**Spec:** "Data" (`linear_posts`); "Reporter" › "When" (rows written at once).
**Track:** A, first.

## Files

- `packages/contracts/src/ids.ts`: `LinearPost: idSchema(['lnp'], 'LinearPostId')` in `ID_SCHEMAS` and
  `ID_PREFIX`, plus the export pair.
- `packages/contracts/src/linear-posts.ts` (new, exported from the index): `LinearEventKind`, `LinearPostState`,
  `LinearPostDto`, `LinearReporterSettings`, `ReportLinearWorkspaceInput`, `ReportLinearPostInput`, exactly as in
  the index's Interfaces. Register the DTOs in `json-schema.ts` as the other DTOs are, then regenerate
  `packages/contracts/generated/`.
- `packages/contracts/src/events.ts`: `EventType.LinearPostChanged = 'linear_post.changed'`.
- `packages/contracts/src/conversation.ts`: `ConversationOwnerKind.Reporter = 'reporter'`. Fix every exhaustive
  switch the compiler then flags. A Reporter conversation is not a chat: `mcp/server.ts` `conversationTools`
  already returns null for non-Chat owners, so no chat tool reaches it. Make sure no chat list, search or sidebar
  query picks it up (grep `ownerKind` and `ConversationOwnerKind.Chat` in `packages/db/src/store` and
  `apps/daemon/src/chat`).
- `packages/db/src/schema.ts`: `linearPosts` table `linear_posts`. Columns: `id`, `task_id` (FK tasks),
  `project_id` (FK projects), `event`, `dedupe_key`, `attempt`, `detail` (json), `state`, `tries`, `due_at`,
  `last_error`, `withheld_pattern`, `session_id` (FK sessions, nullable), `comment_ids` (json string[]),
  `status_set`, `attachment_url`, `dismissed_at`, `created_at`, `recorded_at`. Unique `(task_id, dedupe_key)`;
  index `(state, due_at)`.
- `packages/db/src/store/linear-posts.ts` (new, re-exported): the functions in the index's Interfaces. Each write
  emits `LinearPostChanged` with `entityType: 'task'`, `entityId: taskId` and `data: { projectId }`.
- Generate one migration with `pnpm --filter @10db/db generate` so the tests run. The coordinator regenerates it at
  the end; don't hand-edit it.
- `docs/architecture/db-storage.md`: one entry for the table.

## Interfaces

Implements `enqueueLinearPost`, `listLinearPosts`, `pendingLinearPosts`, `takeLinearPosts`, `recordLinearPosts`,
`failLinearPosts`, `dropPendingLinearPosts`, `dismissLinearPosts` and `linearPostCounts`, quoted in the index.
`failLinearPosts` sets `state = failed` and `due_at = null` once `tries` reaches `maxTries`.
`recordLinearPosts` sets `recorded_at`. A withheld outcome sets `state = withheld` and `withheld_pattern`.

## State-table rows

- idle / the same event again → nothing (the unique key; `enqueueLinearPost` returns null).
- pending / failure → tries+1, then due again or failed.
- any / dismiss → `dismissed_at` set on failed and withheld rows.

## Tests

One file, `linear-posts.test.ts`, on a real SQLite store (`createTestStore`), core (the reporter's durable queue):
- a repeat dedupe key writes nothing;
- `failLinearPosts` at its fifth try marks the row failed and clears `due_at`;
- `dropPendingLinearPosts` for a project leaves recorded, withheld and failed rows.

## Done when

The checks in Global Constraints pass, and `pnpm --filter @10db/db generate` reports no drift after your commit.
