# Task 4: daemon — Slack placement, the card's context and render access

**Spec:** app shell spec §4.1 Inbox, "The content" (Open, where it helps: a question's last three messages) and
"Performance" ("Counts never load lists"); decision
`docs/architecture/decisions/2026-11-16-the-open-inbox-is-paged-by-row-and-the-daemon-groups-the-rows.md` (the
placement rule).
**State rows:** 9 and 10 (placement follows the live Slack connection), 25 (render access).

## Files

- Create `packages/db/src/store/inbox-context.ts` and `inbox-context.test.ts`. Modify `packages/db/src/store/index.ts`.
- Modify these. Each edit is an additive hunk:
  - `apps/daemon/src/daemon/services.ts`: `pageInbox` gets the placement, and `inboxCardContext` is added;
  - `apps/daemon/src/daemon/start.ts`: `slackConnection` goes in `createServices`' deps, one line;
  - `apps/daemon/src/api/services.ts`: the signature;
  - `apps/daemon/src/api/app.ts`: the route, right after `/inbox/page`;
  - `apps/daemon/src/api/app.test.ts`: the stub and its rows;
  - `apps/daemon/src/screens/render-access.ts` and its test.
- Modify `apps/daemon/src/inbox/AGENTS.md`: the route notes.

## Interfaces

Implement these:

```ts
export function inboxCardContext(db: DbReader, id: InboxItemId, count: number): InboxCardContextDto;
// apps/daemon: createServices deps gain `slackConnection: Pick<SlackConnection, 'get'>`;
// ApiServices gains `inboxCardContext(id: InboxItemId): InboxCardContextDto`; route GET /inbox/:id/context.
```

Call these:

```ts
export function pageInbox(db: DbReader, q: InboxPageQuery, placement: InboxPlacement): InboxPageDto;
export interface InboxPlacement { readonly waitingOut: boolean }   // Slack connected: a sent, unreturned card is Waiting's
export const InboxCardContextDto = z.object({
  messages: z.array(z.object({ author: z.enum(['builder', 'agent']), text: z.string(), at: Timestamp })).max(3),
});
```

## What it does

- **Placement:** `pageInbox: (query) => pageInbox(db, query, { waitingOut:
  deps.slackConnection.get().state === 'connected' })`. It's read at each request. `start.ts` passes the
  `slackConnection` it already builds for the stakeholder services.
- **`inboxCardContext`:**
  - **The card's conversation.** It's `detail.conversationId` when that parses as a `ConversationId` and the
    conversation exists. Otherwise it's the conversation `conversations_owner_unique` gives for (`task`, the task
    of `targets[0].workstreamId`). Otherwise there is none, and the answer is `{ messages: [] }`.
  - **The messages.** The newest `count` items of kind `message` (author `builder`) and `agent_message` (author
    `agent`), oldest first. Parse each `body` with the conversation-items store's per-kind body schema
    (`ConversationItemBody[kind]`). Never use `chat/brief.ts`, which M2 removes.
  - An unknown card id is the store's `NotFoundError`, so the route answers 404.
- **Route:** `GET /inbox/:id/context` answers `services.inboxCardContext(InboxItemId.parse(id))`, with a count of 3
  in the service.
- **Render access:** add `{ route: '/inbox/:id/context' }` beside `/inbox/page`, so a screen frame's selected
  question shows its context.

## Steps

1. **Red.** Write `inbox-context.test.ts` on `createTestStore`, a table:
   - a chat card whose conversation has a builder message, a tool call, two agent messages and two more builder
     messages → the last three of `message` and `agent_message` only, oldest first, with their authors;
   - a lane card whose workstream's task owns a conversation → that conversation's messages;
   - a card with neither → `[]`;
   - a `conversationId` that names no conversation → falls back to the task's, else `[]`;
   - a conversation with one message → one.

   Run. Expected: fails, because the module is missing.
2. **Red.** In `app.test.ts`:
   - `GET /inbox/:id/context` reaches the stub with the parsed id;
   - an id that isn't an `InboxItemId` → 400;
   - `GET /inbox/page?state=open&after=…&page=2` → 400.

   `render-access.test.ts`: a screen token may read `/inbox/inbox_…/context`.
3. **Red.** A services test on a real store, a table ported from the desktop's `splitInbox` connection rows
   (`apps/desktop/src/views/inbox/inbox-rows.test.ts`). An open card with a sent, unreturned send is:
   - absent from `pageInbox({ state: 'open' })` when the connection's `get()` answers `connected`;
   - present when it answers `refused`, `none`, `off` or `unreachable`.

   And it's in `state: 'waiting'` under every connection, as the route has always answered. Extend the existing
   services test for `pageInbox` if there is one, else add the table beside its neighbours.
4. Implement, then make it green. Run `pnpm --filter @10db/db exec vitest related src/store/inbox-context.ts --run
   --maxWorkers=2` and `pnpm --filter @10db/daemon exec vitest related src/api/app.ts src/daemon/services.ts
   src/screens/render-access.ts --run --maxWorkers=2`, then typecheck and lint db and daemon.
5. Update `apps/daemon/src/inbox/AGENTS.md`:
   - the new query keys and refusals;
   - Open's rows and `total`;
   - placement by the live connection;
   - the context route;
   - "no index: `inbox_state_idx`, `LIKE` search".
6. Commit the files above, with the message `feat(daemon): the inbox places sent cards by slack and serves a
   card's context`. The body carries:

   ```
   Value: protects=a question shows its session's last words, and Open leaves out what Waiting holds
     while Slack is connected; fails_when=tool calls or reasoning fill the context, a lane card
     finds no thread, or the placement ignores the connection; why_new=no test read a card's
     conversation, and pageInbox had no placement; no_claim=what the panel draws
   ```
