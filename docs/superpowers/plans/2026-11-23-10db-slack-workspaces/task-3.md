# Card 3: sends by workspace

**Decision:** `decisions/2026-11-23-a-projects-slack-workspace-is-its-own.md`, "Everything a send does uses its own
workspace", "One person, a contact per workspace", "No reach across workspaces", "Changing a project's workspace
takes its questions back, in the same write", "A new bot is a new conversation" (old threads) and the name hold in
"Which One Is You is per workspace, and blocks nothing". Stakeholder spec §5 ("A person with no contact"), §7.4
("Who presses Send") and §7.5 as amended.
**Track:** A, after card 2. It may run beside card 4. **Core:** this is where a question leaves the laptop.

## Files

- **Drafts.** `apps/daemon/src/stakeholders/drafts.ts`:
  - `draftContext` adds `teamId`, the effective binding from `projectSlack(db, card.projectId)`.
  - `recipientsOf(db, card, teamId)` answers null when `teamId` is null or a recipient has no contact in it
    (`contactIn`), so the card stays the builder's with Copy for, as today for anyone unreachable.
  - `draftFor` passes `teamId` to `insertDraft`. `sweepDrafts` compares recipients the same way.
- **The binding change.** `apps/daemon/src/stakeholders/project-binding.ts` (new): `rebindProjectSlack`, all in
  the caller's write, with no Slack call.
  1. `setProjectSlack`.
  2. `liveSendsWhere({ projectId })`. Its `sending` and `sent` sends whose team differs from the new one (every
     one, for Off) go to `failSendsToBuilder(ctx, …, 'workspace_changed')`.
  3. When the new binding is a workspace, its drafts in another team are dropped. Each card is routed back to the
     draft's recipients (`setInboxRecipients`, `RoutedBy.Builder`) and drafted again with `draftOnOpen`, which
     yields a draft in the new team or Copy for. Their after-commit steps are returned.
  4. For Off, drafts are left alone.
  - Copy For cards are never asked again; the builder presses Ask Someone.
- **Sends.** `apps/daemon/src/stakeholders/sends.ts`:
  - **Deps.** `slack: SlackClients | null`; `hasToken(teamId)`; `slackFor` (effective) and `boundTo` (stored),
    both required. Every Slack call takes `slack.clientFor(send.teamId)`.
  - **A reserved or sent send** (`continueSending`, `recoverSending(teamId)`, `closeAndSay`, reminders through
    the watch) checks, in this order:
    1. `send.teamId !== boundTo(project)`: take it back, `failSendsToBuilder(…, 'workspace_changed')`. Only a
       race can leave this, since `rebindProjectSlack` does it in the binding's write. A post found by its
       metadata first gets the closing line below.
    2. `clientFor(send.teamId)` is null (the workspace is disconnected): leave it, as `no_token` does today.
    3. Otherwise go on with that client.
    - `recoverSending` runs only the team's `sendingSends(db, teamId)`.
  - **A post that lands after its send was failed** (`landed`, when `markSent` throws `ConflictError` and the
    send's error is `workspace_changed` or `bot_changed`):
    - Never mark it sent, and never re-draft it.
    - Post the `taken_back` closing line in that new thread with the send's own client, if it still has one;
      log a failure.
    - The card stays the builder's. A later Send by the builder drafts again (`redraftFailed`) in the project's
      workspace at that time.
  - **`afterDraft` and `send`.**
    - The effective team now is compared with `draft.teamId`. Null: hold `slack_off`, or the 409, as today.
    - Another team (a draft `rebindProjectSlack` has not reached, which only a race allows): do nothing and log.
    - Holds read the recipient's contact in the send's team: `sendMode`, `dailyLimit`,
      `everSent(db, personId, teamId)` and `newThreadsSince(db, personId, teamId, since)`.
  - **Follow-ups.** `threadFor` passes `latestThreadFor(…, teamId, workspace.botSince ?? null)`, so a thread from
    before the bot was recorded is never joined. `channelFor` then opens a fresh DM from the recipient's contact
    in the send's team (its `dmChannelId`, which a bot change cleared, or `openDm`) and records it with
    `setDmChannel(ctx, personId, teamId, channel)`. A group DM opens from those contacts' user ids.
  - **The builder's name.** A builder still named `SEED_BUILDER_NAME` holds a draft for `review`, as today, but
    `send` no longer refuses it: remove the "Pick yourself in Settings › Integrations" 409.
- **Services.** `apps/daemon/src/daemon/stakeholder-services.ts`: `setProjectIntegrations` runs
  `state.write((ctx) => rebindProjectSlack(ctx, projectId, teamId, draftOpts))`, then each returned step. Its
  doc comment in `api/services.ts` says the change takes back what is out.
- **Wiring.** `apps/daemon/src/daemon/start.ts`:
  - `createStakeholderSends({ slack: slackClients, hasToken: (teamId) => …, slackFor: (id) =>
    projectSlack(state.db, id).teamId, boundTo: (id) => boundTeam(state.db, id), … })`.
  - Pass `draftOpts` to the stakeholder services.
  - Remove card 1's and card 2's bridges in this area.
  - `apps/daemon/test/engine.ts` and `routed-wait.test.ts` follow: a fake engine with Slack binds its project to
    the fake team.
- **Docs.** `apps/daemon/src/stakeholders/AGENTS.md` (card 2 made it): drafts come from the effective binding,
  reserved sends check the stored one; the binding change is one write; late posts are closed; old threads are
  not joined.

## Interfaces it implements

From the index, word for word:

```ts
// apps/daemon/src/stakeholders/sends.ts (card 3)
export interface SendsDeps {
  readonly state: StateStore;
  /** Null when TENDB_SLACK=off: every draft stays as it is. */
  readonly slack: SlackClients | null;
  readonly clock: Clock;
  readonly log: Logger;
  readonly parkFor?: (id: InboxItemId) => void;
  /** Whether a workspace's bot token is stored; Send is a 409 with the draft kept when it is not. */
  readonly hasToken?: (teamId: string) => Promise<boolean>;
  /** The effective binding (projectSlack): what a draft is made in. */
  readonly slackFor: (projectId: ProjectId) => string | null;
  /** The stored binding (boundTeam): a reserved send in another team is taken back, never posted. */
  readonly boundTo: (projectId: ProjectId) => string | null;
}
export interface StakeholderSends {
  afterDraft(cardId: InboxItemId): Promise<void>;
  send(cardId: InboxItemId, input: SendInput): Promise<StakeholderSendDto>;
  askSomeone(cardId: InboxItemId, input: AskSomeoneInput): void;
  takeBack(cardId: InboxItemId): Promise<void>;
  keepWaiting(cardId: InboxItemId): void;
  /** Sends of this workspace that were mid-flight: found posts are recorded, the rest posted. */
  recoverSending(teamId: string): Promise<void>;
  closingTextFor(cardId: InboxItemId): string | null;
  onCardChanged(card: InboxItemDto): Promise<void>;
}

// apps/daemon/src/stakeholders/project-binding.ts (card 3)
/**
 * Binds a project to a workspace or Off and takes back what it had elsewhere, in the caller's one write: sending
 * and sent sends in another team (any team, for Off) fail `workspace_changed`; drafts in another team are dropped
 * and drafted again for the same people when the new binding is a workspace. Returns the drafts' after-commit steps.
 */
export function rebindProjectSlack(ctx: WriteContext, projectId: ProjectId, teamId: string | null,
  opts: { readonly afterDraft: (id: InboxItemId) => void; readonly log: Logger }): (() => void)[];

// apps/daemon/src/stakeholders/drafts.ts (card 3)
// draftContext gains teamId: Pick<DraftDeps, 'projectName' | 'goalTitle' | 'builderName' | 'teamId'>
// DraftDeps gains: readonly teamId: string | null;   // the effective binding, from projectSlack
```

## Interfaces it reads

From the index, word for word:

```ts
// packages/contracts/src/team.ts (card 1)
// SlackContactDto and SlackContactInput are unchanged.
export const PersonInput = z.object({
  handle: HyphenatedKey,
  name: z.string().min(1).max(80),
  /** One contact per workspace; a workspace left out has its contact removed. */
  slack: z.array(SlackContactInput).max(20).default([])
    .refine((list) => new Set(list.map((c) => c.teamId)).size === list.length, 'One contact per workspace'),
});
export const PersonDto = z.object({
  id: PersonId, handle: HyphenatedKey, name: z.string(), isBuilder: z.boolean(),
  /** Every contact the person has, signed-in workspace or not, oldest first. */
  slack: z.array(SlackContactDto).default([]),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
/** The person's contact in this workspace; null for no workspace (Off) or none there. */
export function contactIn(person: Pick<PersonDto, 'slack'>, teamId: string | null): SlackContactDto | null;

// packages/contracts/src/slack.ts (card 1)
/** One signed-in workspace; its bot token is in the Keychain under `slack-bot:<teamId>`. */
export const SlackWorkspace = z.strictObject({
  teamId: z.string().min(1),
  teamName: z.string(),
  /** The bot on record; absent until the first record (stored before this, or connected again). */
  botUserId: z.string().min(1).optional(),
  botName: z.string().min(1).optional(),
  /** When this bot was recorded: threads sent before it are never joined. */
  botSince: z.iso.datetime().optional(),
});
export const SlackWorkspaceState = {
  Checking: 'checking', Connected: 'connected', Refused: 'refused', Unreachable: 'unreachable', None: 'none',
} as const;
export type SlackWorkspaceState = (typeof SlackWorkspaceState)[keyof typeof SlackWorkspaceState];
/** One workspace as its watch last found it; never the token. `none`: its token is gone from the Keychain. */
export const SlackWorkspaceStatusDto = z.strictObject({
  teamId: z.string(), teamName: z.string(),
  botUserId: z.string().nullable(), botName: z.string().nullable(),
  state: z.enum(SlackWorkspaceState),
  checkedAt: z.iso.datetime().nullable(), error: z.string().nullable(),
});
/** `GET /slack`: every signed-in workspace; `off` when the daemon runs with TENDB_SLACK=off. */
export const SlackStatusDto = z.strictObject({ off: z.boolean(), workspaces: z.array(SlackWorkspaceStatusDto) });
// SlackConnectionDto is removed (card 2).
/** `PUT /slack/token`. With `teamId` it replaces that workspace's token and refuses another team's. */
export const SlackTokenInput = z.strictObject({ token: /* unchanged */, teamId: z.string().min(1).optional() });
/** What Slack is for a project: its workspace, or nulls for Off, and how many of its questions are out now. */
export const ProjectSlackDto = z.strictObject({
  teamId: z.string().nullable(), teamName: z.string().nullable(),
  /** Sends of the project's cards that are sending or sent: what a change of workspace takes back. */
  out: z.number().int().min(0),
});
// `auto` is removed. ProjectSlackSetting, ProjectIntegrationsDto and ProjectIntegrationsInput keep their shapes.
// StakeholderSendDto gains: teamId: z.string().nullable()   // null only on a send migrated without a team
// SendState, heldBy values and returnedReason are unchanged. New failure codes (strings in `error`):
export const SendFailure = {
  WorkspaceChanged: 'workspace_changed', BotChanged: 'bot_changed', NoWorkspace: 'no_workspace',
} as const;
// EventType.SlackConnectionChanged: entityType 'slack', entityId the team id, data { state }.

// packages/db/src/store/team.ts (card 1)
export function setDmChannel(ctx: WriteContext, personId: PersonId, teamId: string, channelId: string): void;
export function getDmCursor(db: DbReader, personId: PersonId, teamId: string): string | null;
export function setDmCursor(ctx: WriteContext, personId: PersonId, teamId: string, ts: string): void;
/** Forgets the DM channel and cursor of every contact in a workspace; returns how many changed. */
export function clearTeamDmChannels(ctx: WriteContext, teamId: string): number;
// insertPerson/updatePerson take PersonInput's list: a team left out is deleted; a new user in a team forgets that
// contact's DM channel and cursor; an unchanged contact keeps them. deleteContactsOutsideWorkspaces is unchanged.

// packages/db/src/store/stakeholder-sends.ts (card 1)
/** Reads each recipient's contact in `teamId`; InvalidError when one has none. */
export function insertDraft(ctx: WriteContext, input: {
  readonly inboxItemId: InboxItemId; readonly teamId: string; readonly recipients: readonly PersonId[];
  readonly text: string; readonly hits: readonly OutboundHit[];
}): StakeholderSendDto;
export function everSent(db: DbReader, personId: PersonId, teamId: string): boolean;
export function newThreadsSince(db: DbReader, personId: PersonId, teamId: string, since: string): number;
/** Only threads of sends in `teamId` sent at or after `since` (the workspace's `botSince`; null: none joinable). */
export function latestThreadFor(db: DbReader, recipients: readonly PersonId[], taskId: TaskId, teamId: string,
  since: string | null): { channelId: string; threadTs: string; reviewed: boolean } | null;
export function openSends(db: DbReader, teamId?: string): OpenSendRow[];       // OpenSendRow gains teamId: string | null
export function sendingSends(db: DbReader, teamId?: string):
  { id: StakeholderSendId; teamId: string | null; channelId: string | null; threadTs: string | null; startedAt: string }[];
/** Draft, sending and sent sends of a workspace or of a project's cards, with the team each was drafted in. */
export function liveSendsWhere(db: DbReader, filter: { readonly teamId: string } | { readonly projectId: ProjectId }):
  { id: StakeholderSendId; inboxItemId: InboxItemId; state: SendState; teamId: string | null }[];

// apps/daemon/src/stakeholders/slack-clients.ts (card 2)
export interface SlackClients {
  /** The client of a signed-in workspace, reading its token at each call; null for a null team or one not signed in. */
  clientFor(teamId: string | null): SlackClient | null;
}
export function createSlackClients(deps: {
  readonly state: StateStore; readonly keychain: Keychain; readonly fetch: typeof fetch;
  readonly clock: Clock; readonly timeoutMs: number;
}): SlackClients;

// apps/daemon/src/stakeholders/slack-workspaces.ts (card 2)
export function readSlackWorkspaces(db: DbReader): SlackWorkspace[];                     // unchanged
/** Adds the workspace, or renames its entry; its bot fields are kept (recordBot writes them). */
export function saveSlackWorkspace(ctx: WriteContext, workspace: { teamId: string; teamName: string }): void;
/** Drops the entry, bot record included. */
export function removeSlackWorkspace(ctx: WriteContext, teamId: string): void;
/** The effective binding: the stored workspace while it is signed in; no setting, null, or signed out is Off. */
export function projectSlack(db: DbReader, projectId: ProjectId): ProjectSlackDto;
/** The stored binding as written, signed in or not; null for no setting or Off. */
export function boundTeam(db: DbReader, projectId: ProjectId): string | null;
export function setProjectSlack(ctx: WriteContext, projectId: ProjectId, teamId: string | null): void;  // unchanged
// slackTokenReader is removed. cleanUpSlackSignIns is unchanged.

// apps/daemon/src/stakeholders/send-returns.ts (card 2)
/** Fails each send with `code` and gives its card back to the builder; in the caller's write. */
export function failSendsToBuilder(ctx: WriteContext,
  sends: readonly { readonly id: StakeholderSendId; readonly inboxItemId: InboxItemId }[], code: string): void;
/** A workspace's bot is new: its DM channels and cursors go, and its sending and sent sends fail `bot_changed`. */
export function recoverFromBotChange(ctx: WriteContext, teamId: string): StakeholderSendId[];
/**
 * Records the bot a check found. None on record: record it with `botSince` now and forget the team's DM channels.
 * The same bot: nothing. A different bot: from a saved token, recoverFromBotChange and record it; from a watch's
 * check, nothing (the check read a token that has since been replaced).
 */
export function recordBot(ctx: WriteContext, identity: SlackIdentity, source: 'token' | 'check'): void;
```

## State-table rows

| State | Event | Next |
|---|---|---|
| project Off (no setting, `null`, or a signed-out workspace) | a question routed to Mark | no draft; the card is the builder's with Copy for Mark (card 3) |
| bound to A | routed to Mark, who has an A contact | a draft with `teamId` A, read from his A contact; held or sent by that contact's send mode and limit (card 3) |
| bound to A | routed to Priya, who has only a B contact | no draft; Copy for Priya; marked "not in A's Slack" (cards 3, 5) |
| bound to A | routed to Mark (A) and Priya (B only) | the whole card stays the builder's with Copy for both, as for anyone unreachable (card 3) |
| bound to A, Mark's limit reached in B | a new A thread for Mark | counted against his A contact only (card 3) |
| bound to A, Mark never sent to in A | his first A question | shown first for review, whatever B had (card 3) |
| builder still "You" | a draft that nothing else holds | held for review; Send works (card 3) |
| a send reserved in A | post, follow-up, reminder, move, closing line | made with A's client only; DM channel from the recipient's A contact (cards 2, 3) |
| bound to A, an answered A thread from before A's `botSince` | a follow-up for the same people and task | not joined: a new thread in a fresh DM (card 3) |
| a send mid-post in A | restart | A's watch runs `recoverSending(A)`: the post is found and recorded, or posted (card 3) |
| bound to A, a draft in A | bound to B | in the binding's write: the draft dropped and the card drafted again for the same people, in B or Copy for; `afterDraft` runs after the commit (card 3) |
| bound to A, sends sending or sent in A | bound to B, or Off | in the binding's write: they fail `workspace_changed`, cards back to the builder; the Select confirms first (cards 3, 4) |
| bound to A, a draft in A | Off | the draft stays, held `slack_off` at its next `afterDraft`, or a 409 at Send (card 3) |
| a post in flight in A (send `sending`) | a rebind, Off, or a bot change fails it | the post may still land. `markSent` refuses (the send is failed), so it stays failed and a "taken back" closing line goes in that thread with A's client (logged if that fails). The card stays the builder's. Nothing is drafted for a failed send, so there is no second post anywhere until the builder presses Send, which drafts again in the project's workspace now (card 3) |
| a post in flight in A | Disconnect | it lands and is recorded sent (Open shows it, A not connected), or reads no token and stays `sending`; on reconnect `recoverSending(A)` finds or posts it. The stored binding is still A, so it is never taken back (card 3) |
| a reserved send in A, stored binding B (only a race can leave this) | `continueSending`, `recoverSending`, `closeAndSay` | checked first: taken back with `workspace_changed`; a post found by its metadata gets the closing line as above (card 3) |
| a reserved send in A, stored binding A, A signed out | any post | checked second: no client, so it waits, as `no_token` does today (card 3) |
| two rebinds in a row, or a restart after the binding's write | — | each rebind is one write and sees the last one's result; a draft whose `afterDraft` a restart cut off waits unheld in the Inbox with Send, as any such draft does today (card 3) |
| A disconnected, then reconnected | drafts held `slack_off`, Copy For cards | nothing runs by itself: the builder presses Send on a held draft, or Ask Someone on a Copy For card (cards 2, 3) |

## Tests

Core: this guards which workspace a question reaches. One new file,
`apps/daemon/src/stakeholders/workspace-sends.test.ts`, on the real rung:
- a real store (`createTestStore`) and the real `createStakeholderSends` and `rebindProjectSlack`;
- `createSlackClients` over a memory Keychain with `xoxb-a` and `xoxb-b`, and a fake `fetch` that records each
  call's method, bearer token, `users` or `channel`, and answers `conversations.open`, `chat.postMessage` and
  `chat.getPermalink`. One `chat.postMessage` can be held on a promise the test releases, for the in-flight row.

Mark has a contact in A (`UA`) and B (`UB`); Priya has one in B only. Projects: P1 bound to A, P2 bound to B, P3
with no setting. Each row seeds a routed card with card 1's stores, then runs the sends as the daemon would:
- Mark in P1: one post, every call with `xoxb-a` and `UA`; the send's `teamId` is A. Mark in P2: `xoxb-b`, `UB`.
- Mark in P3: no draft, no call, the card's Copy for names Mark.
- Priya in P1: no draft, no call, Copy for Priya.
- Mark at his daily limit in B, never sent to in A: a P1 card for him is held `first_send`, not `limit`.
- P1 bound to B while Mark's P1 send is sent: in that one write it fails `workspace_changed`, its card is the
  builder's, and no call is made.
- P1's draft for Mark, then P1 bound to B: the draft is in B at once, and its send posts with `xoxb-b` and `UB`.
- Mark's P1 post held in flight, then P1 bound to B, then the post released: the send stays failed, the only
  later call is A's closing line in that thread with `xoxb-a`, and nothing is posted with `xoxb-b`.
- An answered P1 thread for Mark sent before A's `botSince`: a follow-up on the same task opens a new DM thread,
  not that one.

Prove it red first: with `recipientsOf` reading Mark's first contact instead of his contact in the project's
workspace, the P2 and Priya rows fail. Value card: `protects=a project's question reaches only its own workspace,
through its contact there, and a moved project posts nothing more in the old one; fails_when=a send uses another
team's token or contact, a moved project keeps sending in the old workspace, or a late post is marked sent;
why_new=data going out (core); no_claim=Slack's delivery, reply reading`.

## Done when

The checks in Global Constraints pass. `grep -rn "TODO(slack-workspaces)" apps/daemon` finds nothing.

## Review note

This card also adds the stored-binding check to reminders in `apps/daemon/src/stakeholders/reply-watch.ts`
(card 2 owns the file and merges first; only a race reaches the check).
