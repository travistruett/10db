# Task 1: a chat stores Full access and the patch turns it on or off

Read the index's Brief and Global Constraints first.

**Files:** `packages/db/src/schema.ts` (`chats`), the chats store and its DTO mapping in `packages/db`,
`packages/contracts/src/chat.ts`, `packages/contracts/generated/` (regenerated), `apps/daemon/src/chat/service.ts`
(`patch`) and its wiring in `apps/daemon/src/daemon/start.ts`, the migration (generated last), and one line in
`docs/architecture/db-storage.md`.

**Implements:**

```ts
ChatDto: { ...; fullAccess: z.boolean() }
ChatPatchInput: { ...; fullAccess: z.boolean().optional() }
// chats
fullAccess: integer('full_access', { mode: 'boolean' }).notNull().default(false)
```

**Design (the index's state table, the Turn On and Turn Off columns).** In `ChatService.patch`, a `fullAccess`
change:
- is refused while the conversation is busy, with the model change's words, and while the place is moving
  ("Wait for the move to finish");
- on a chat still reading or choosing, turning it on first records Here through
  `ChatWorkService.enterHere(chatId)`, the step Open in Terminal takes (`takeover/service.ts` injects it as
  `work: () => Pick<ChatWorkService, 'enterHere'>`; inject it into the chat service the same way);
- stores the flag and closes the warm session, as an effort-only change does, so the next turn starts with it;
- emits the chat's changed event so the title row refetches.

Spec section it implements: sessions-simplified spec "4.5 Open in Terminal" (recording Here), by analogy.

**Tests:** none new.
