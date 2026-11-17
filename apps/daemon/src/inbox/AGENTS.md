# apps/daemon/src/inbox

- Two routes list cards. `GET /inbox` (`?state=OPEN,ANSWERED`, comma-separated `InboxState`s) answers every
  card in those states as an array, most urgent and then oldest first; the Open list, the sidebar badge, the
  tray, the Sessions view and the daemon's own tests read it. `GET /inbox/page` (`InboxPageQuery`, served by
  `pageInbox` in `packages/db/src/store/inbox-page.ts`) answers one page, an `InboxPageDto` (`items`,
  `total`, `page`, `pageSize`), with filtering, sorting and counting done in the query; the Inbox's Waiting
  and Resolved tables and the chat tab's resolved cards read it. A list that can grow without limit is read through the page route.
- `InboxPageQuery` is a strict object (an unknown key is a 400): `state` (`open`, `waiting` or `resolved`),
  `project`, `kind`, `outcome`, `person`, `sort` (`updatedAt`, `createdAt`, `kind`, `title`, `sentAt`), `dir`,
  `page` (from 1) and `pageSize` (1 to 100, 25 by default).
  - `open` is an `OPEN` card; `waiting` is an `OPEN` card whose live send is `sent` with no `returnedAt`
    (whatever the Slack connection; the app shows Waiting only while Slack is connected); `resolved` is a
    `RESOLVED` card.
  - `outcome` follows `inboxOutcome` in contracts, in its order: a Slack answer (`answer.via` is `slack`), then
    10db's close (a `detail.resolution` that `CardResolution` accepts), then `answered` for the rest. The SQL
    is one `CASE` built from `CARD_RESOLUTION`; `inbox-page.test.ts` checks it against `inboxOutcome` row by
    row, so change both together.
  - `person` keeps cards with a send to that person as a recipient; in Waiting, the send that is out now.
  - With no `sort`, Resolved is newest updated first, Waiting the longest out first (a card with no send
    last), and Open most urgent then oldest. Ties go by id. A page past the last answers the last, with its
    own number in `page`.
- No index was added for the page: every page filters on `state` (`inbox_state_idx`) and the send subqueries
  use `stakeholder_sends_card_idx`. A `(state, updated_at)` index is for when resolved cards reach six figures.
- A screen's render token may read `/inbox/page` (`screens/render-access.ts`), as it reads `/inbox`; the app
  names the frame's project in the query.
