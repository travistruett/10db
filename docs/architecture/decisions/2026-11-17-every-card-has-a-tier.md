# Every card has a tier, an urgency and a way to close, and a notice is an event in Activity

- **Date:** 2026-11-17
- **Amends:** `decisions/2026-10-31-notices-not-cards.md` (a notice now has a home outside a batch: the event log, read
  as Activity)

## Decision

- **Every card a raiser stores declares three things where it is built, and the types require them.** `FlagInput` and
  the delivery `Card` have `tier`, `urgency` and `closesWhen`, none optional.
  - `tier` is `CardTier` (`apps/daemon/src/inbox/card-tier.ts`): `ask` (the builder chooses something 10db then does,
    or fixes something 10db watches for), `notice` (told, asked nothing) or `status` (live state 10db handles). A
    stored card is an `ask` or a `status` (`StoredTier`); a notice is never stored as one.
  - `urgency` is set by the builder of the card. `flagCard` stores the urgency it is given and has no default, so a
    flag is no longer high unless it says so. High is work stopped or about to be lost until the builder acts, normal
    is something to decide with nothing stopped, low is an undo offer or an optional choice.
  - `closesWhen` has three forms: `{ by: 'answer' }` (the builder's answer closes it), `{ by: 'event', when }` (a
    `CardResolvesWhen` condition: `tasks_started`, `batch_shipped`, `checkout_trusted`; `flagCard` writes it into
    `detail.resolvesWhen`) and `{ by: 'withdrawn', when }` (10db's own code withdraws or resolves it, and `when` names
    that code).
  - The contract is compile-time. `flagCard` never throws for a missing or odd tier, and no tier is written to
    `inbox_items`.
- **A notice is a `notice.posted` event, or a batch notice, never an `inbox_items` row.** `postNotice` appends the
  event inside the caller's write, so it commits or rolls back with the change that raised it. A notice about a task
  is posted on entity `task`; one about a project on `project`; one with neither on `app`. It never counts, badges or
  notifies. It carries a key of at most 200 characters (`fitNoticeKey`), a line and a body that `fitNotice` cuts to fit
  `Notice`.
- **Activity reads the event log.** `GET /activity/page` (`pageActivity`, `packages/db/src/store/activity.ts`) pages
  `notice.posted` events newest first by keyset on `seq`, filtered by project (its own notices and its tasks'), task
  or search text. `groupNotices` folds a repeat with the same key, project and task within 10 minutes into one row
  with a count. No migration and no index: the read uses `events_entity_idx` and the event's rowid.
- **`{ by: 'withdrawn' }` keeps Dismiss, as `{ by: 'answer' }` does.** The no-Dismiss rule of the Inbox signal's S2
  applies only to cards whose `closesWhen` is a `CardResolvesWhen` condition (`{ by: 'event' }`).
- **At start, open cards of a kind that is a notice now are resolved once.** `resolveNoticeCards`
  (`apps/daemon/src/daemon/notice-sweep.ts`) matches 16 kinds by their raisers' fold keys, and by title, body or
  option count where one fold key prefix also names an ask. Each close is its own write with the reason "This kind of
  card is a notice now; it is in Activity."
- **Built in S1:** the three fields on every raiser, `postNotice`, the activity read and route, the notices the
  raisers post, and the sweep. **Designed, not built:** the closers and answers §5 of the spec names for S2 and S4
  (each card that waits for one carries a `// S2:` or `// S4:` note), the status line, no-Dismiss for condition
  cards, and the repo test that fails on a builder the sort table doesn't name (S3).

## Why

- **The numbers** (`docs/superpowers/specs/2026-11-17-10db-inbox-signal-design.md` §1): of 770 cards since
  2026-10-28, 325 flags offered only Dismiss and were never answered (205 dismissed, 107 withdrawn by 10db), while 75
  of the 77 flags that offered a real choice were answered. 71 of the 73 flags of the last week offered only Dismiss.
- **Four mechanisms kept the noise coming**, and each is closed at its source:
  1. every flag was high, because `flagCard` hardcoded it: urgency is now declared;
  2. a dismissed card came back, because a fold key looks only at open cards: a notice has no card to fold or
     dismiss, and a condition card's closer is declared (S2 removes its Dismiss);
  3. some causes never closed their cards: every card now says how it closes, so one that doesn't is visible in review;
  4. a flapping condition made a card each time: a repeat notice is one Activity row with a count, and a status
     condition is S2's line.
- **Approach B over A and C.** A, fixing card by card, is what the builder has done since 2026-10-31
  (`decisions/2026-10-31-notices-not-cards.md`), and the Dismiss-only cards returned because nothing stopped new
  ones. C, a display-only split by whether a card has options, leaves stale cards stale, stops no new noise, and puts
  the rule in the browser, which
  `decisions/2026-11-16-the-open-inbox-is-paged-by-row-and-the-daemon-groups-the-rows.md` moved to the daemon.
  Requiring the three fields in the types is the only option that makes a new builder choose. The judge as the sorter
  was rejected: it can lose a real ask and needs an OpenRouter account.
- **`withdrawn` is a third form** because most cards 10db closes itself are not closed by an answer or by one of the
  three `CardResolvesWhen` conditions: the disk card, worktree cards, pull request watch cards and account cards each
  have their own code that withdraws them. Declaring them `{ by: 'answer' }` would say the builder closes what the
  builder does not, and widening `CardResolvesWhen` would put every withdrawer's logic in one table. The form names
  the code instead, so S3's test can check it exists.
- **A task's notice sits on the `task` entity** so the drawer reads it through `events_entity_idx` (entity type, entity
  id, type) without opening any event's JSON. A project's Activity reads its own notices and its tasks' by one join
  to `tasks`. A notice on the project would have made the drawer scan the project's notices and parse each.
- **No index.** Medians of 20 runs on a 250,000-event log, in ms (dense is 10,000 notices, sparse is 20):

  | Read                            | Dense | Sparse |
  | ------------------------------- | ----- | ------ |
  | first page                      | 2.21  | 24.76  |
  | middle page (after seq 125,000) | 1.13  | 4.16   |
  | one project                     | 4.01  | 0.17   |
  | one task                        | 0.19  | 0.07   |

  Past 50 ms for any of these, an index would be needed, which is a migration and so is not added here.

- **Provider parity:** a notice, a tier and the sweep depend on no account or provider. The notices that name a model
  or account name it in text, and every provider's runs post them alike.
