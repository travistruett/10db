# Card 2: workspaces in the daemon

**Decision:** `decisions/2026-11-23-a-projects-slack-workspace-is-its-own.md`, "Several workspaces, one app each",
"A project names its workspace, or none", "A new bot is a new conversation" and the per-workspace watch in
"Everything a send does uses its own workspace". Stakeholder spec §9.2 ("The connection in 10db") and §8.2
("Reading replies") as amended.
**Track:** A, after card 1. **Core:** the token refusal and the bot change decide where posts go.

## Files

- **Slack client.** `apps/daemon/src/slack/responses.ts` (`AuthTestReply` gains `user`) and `client.ts`
  (`SlackIdentity` gains `botName`).
- **Clients per workspace.** `apps/daemon/src/stakeholders/slack-clients.ts` (new): `createSlackClients`.
  - A client per signed-in team, made on first use and kept. Its token is read from `slackBotAccount(teamId)` at
    each call, as today.
  - `clientFor` answers null for a null team or one not in `slack.workspaces`.
- **The workspace list.** `apps/daemon/src/stakeholders/slack-workspaces.ts`:
  - Add `saveSlackWorkspace`, `removeSlackWorkspace` and `boundTeam`. Remove `slackTokenReader`.
  - `projectSlack` drops `auto`: no setting, `null`, or a workspace not signed in is Off. It fills `out`, which
    the services read from `liveSendsWhere({ projectId })`, counting sending and sent; it can take it as an
    argument, or the services can add it.
  - Nothing reads `workspaces[0]` any more.
- **States per workspace.** `apps/daemon/src/stakeholders/slack-connection.ts`: `SlackConnection` becomes
  `SlackConnections`.
  - `list()` answers every workspace in `slack.workspaces` with its state: `checking` until its watch's first
    check.
  - `set` reads `slack.workspaces` and does nothing for a team not there, so a tick that ends after a Disconnect
    can't bring a row back.
  - `off` comes from the daemon's options. The event names the team.
- **Returns and the bot record.** `apps/daemon/src/stakeholders/send-returns.ts` (new): `failSendsToBuilder`,
  `recoverFromBotChange` and `recordBot`.
  - `recordBot` writes `botUserId`, `botName` and `botSince` (now) on the workspace's entry, per its doc comment.
    A watch's check passes `'check'` and never triggers a recovery.
  - Point `reply-watch.ts`'s `guard` and `sends.ts`'s `fail` at `failSendsToBuilder`, so the three places that
    hand a card back share one write.
- **Watches per workspace.**
  - `apps/daemon/src/stakeholders/reply-watch.ts`: one watch per team.
    - It takes `teamId`, its own `slack` client, the shared `connections` and `matched`.
    - It reads `openSends(db, teamId)` and calls `sends.recoverSending(teamId)`; until card 3 changes that
      signature, bridge it with a TODO shim.
    - Its identity check runs `recordBot(ctx, identity, 'check')` in a write, and sets only its own team's state.
    - Keep the immediate first check that #763 added.
    - `reconnect` awaits the tick in flight, then checks.
  - `apps/daemon/src/stakeholders/reply-watches.ts` (new): `createReplyWatches`.
    - It loads `MatchState` once and makes a watch per signed-in workspace on `start()`.
    - `reconnect` adds a watch or reconnects the existing one. `drop` awaits the watch's `stop()`, which waits
      for its tick in flight.
    - Each watch has its own timer, so a slow or refused workspace never delays another. It exposes no `tick`.
- **Services and routes.**
  - `apps/daemon/src/daemon/stakeholder-services.ts`:
    - `setSlackToken`, step 1: check the token on a client of its own, as today. With `input.teamId` set and
      Slack's team different, refuse with `InvalidError` ("That token is for <team>. Use Add Workspace for it.")
      before the Keychain is touched.
    - Step 2: write the token to `slackBotAccount(teamId)`.
    - Step 3, in one state write: `saveSlackWorkspace` and `recordBot(ctx, identity, 'token')`.
    - Step 4: `await watches.reconnect(teamId)`. The watch's check sets the state.
    - It never removes another workspace's token. Answer `connections.list()`.
    - `removeSlackWorkspace(teamId)`, in order: remove that Keychain item; `removeSlackWorkspace` (the bot record
      goes with the entry); `connections.drop`; `await watches.drop`. Contacts and project bindings stay.
    - `listSlackMembers(teamId, query)`: the member cache is per team. 409 when the team isn't signed in or
      Slack is off.
    - `projectIntegrations` fills `slack.out`. `setProjectIntegrations` keeps refusing a workspace that isn't
      signed in; card 3 replaces its write with `rebindProjectSlack`.
  - `apps/daemon/src/api/services.ts` and `apps/daemon/src/api/app.ts`: the four routes in the block below.
    `DELETE /slack/token` is removed. `GET /slack/members` reads `teamId` with zod.
  - `apps/daemon/src/daemon/services.ts`: `pageInbox(…, { connectedTeams: connections.connectedTeams() })`.
- **Wiring.** `apps/daemon/src/daemon/start.ts`:
  - `slackClients` (null with `TENDB_SLACK=off`), `slackConnections`, and `replyWatches.start()` after recovery.
  - `sends` keeps a single-client bridge (TODO) until card 3.
  - `apps/daemon/test/engine.ts` follows.
- **Desktop bridge.** `apps/desktop/src/daemon/people.ts`:
  - Add `useSlackStatus`, `useSetSlackToken` (it takes `SlackTokenInput`), `useRemoveSlackWorkspace`,
    `useSlackMembers(teamId, …)` and `useSlackMember(teamId, …)`.
  - Their readers keep compiling through TODO shims on the first workspace; card 4 replaces them.
  - Remove `SlackConnectionDto` from contracts and regenerate.
- **Docs.**
  - `apps/daemon/AGENTS.md`: the `TENDB_SLACK=off` note names `slack-bot:<teamId>` (it still says `slack-bot`),
    and the `slack/` note adds that a client belongs to one workspace.
  - A new `apps/daemon/src/stakeholders/AGENTS.md` (none exists), four lines: a send's workspace is its
    project's; clients by team; a watch per workspace; the bot record and who may change it.
  - `apps/daemon/src/inbox/AGENTS.md`: Waiting is per workspace (`connectedTeams`), replacing the `waitingOut`
    sentence.

## Interfaces it implements

From the index, word for word:

```ts
// apps/daemon/src/slack: SlackIdentity gains botName (auth.test's `user`); AuthTestReply gains user: z.string() (card 2)

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

// apps/daemon/src/stakeholders/slack-connection.ts (card 2): SlackConnection becomes
export interface SlackConnections {
  readonly off: boolean;
  /** Every signed-in workspace with its state, in stored order; a workspace never checked reads `checking`. */
  list(): SlackStatusDto;
  get(teamId: string): SlackWorkspaceStatusDto | null;
  /** A no-op for a team not in `slack.workspaces`; an event goes out only when the state changes. */
  set(teamId: string, state: SlackWorkspaceState, detail?: {
    readonly identity?: SlackIdentity; readonly error?: string | null; readonly at?: string;
  }): void;
  drop(teamId: string): void;
  connectedTeams(): string[];
}
export function createSlackConnections(deps: { readonly state: StateStore; readonly off: boolean }): SlackConnections;

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

// apps/daemon/src/stakeholders/reply-watch.ts (card 2): one watch per workspace
export interface ReplyWatchDeps {
  readonly state: StateStore;
  readonly teamId: string;
  readonly slack: SlackClient;
  readonly inbox: Pick<InboxService, 'answerAs'>;
  readonly judge: Judge;
  readonly sends: Pick<StakeholderSends, 'recoverSending' | 'closingTextFor'>;
  readonly clock: Clock; readonly log: Logger;
  readonly connections: SlackConnections;
  /** Shared by every watch; saved after each tick. */
  readonly matched: MatchState;
  readonly intervalMs?: number;
}
// ReplyWatch keeps start / stop / tick / reconnect; reconnect awaits the tick in flight before it checks.

// apps/daemon/src/stakeholders/reply-watches.ts (card 2)
export interface ReplyWatches {
  /** One watch per signed-in workspace, each checked at once, then every interval on its own timer. */
  start(): void;
  /** Stops every watch and waits for each one's tick in flight. */
  stop(): Promise<void>;
  /** A token was saved: the workspace's watch starts, or waits for its tick in flight, checks again and reads on. */
  reconnect(teamId: string): Promise<void>;
  /** The workspace was disconnected: its watch stops, after its tick in flight. */
  drop(teamId: string): Promise<void>;
}
export function createReplyWatches(deps: Omit<ReplyWatchDeps, 'teamId' | 'slack' | 'matched'> & {
  readonly slack: SlackClients | null;   // null: TENDB_SLACK=off, no watch runs
}): ReplyWatches;

// apps/daemon/src/api/services.ts (card 2)
slackStatus(): SlackStatusDto;
setSlackToken(input: SlackTokenInput): Promise<SlackStatusDto>;
removeSlackWorkspace(teamId: string): Promise<SlackStatusDto>;      // replaces removeSlackToken
listSlackMembers(teamId: string, query: string): Promise<SlackMemberDto[]>;
// Routes: GET /slack -> SlackStatusDto; PUT /slack/token -> SlackStatusDto;
// DELETE /slack/workspaces/:teamId -> SlackStatusDto (replaces DELETE /slack/token);
// GET /slack/members?teamId=&query= -> SlackMemberDto[] (409 when that workspace is not signed in or Slack is off)

// apps/desktop/src/daemon/people.ts (cards 2, 4 and 5)
export function useSlackStatus(): UseQueryResult<SlackStatusDto>;            // replaces useSlackConnection
export function useSetSlackToken(): UseMutationResult<SlackStatusDto, Error, SlackTokenInput>;
export function useRemoveSlackWorkspace(): UseMutationResult<SlackStatusDto, Error, string>;
export function useSlackMembers(teamId: string | null, query: string, enabled: boolean): UseQueryResult<SlackMemberDto[]>;
export function useSlackMember(teamId: string | null, userId: string | null): SlackMemberDto | null;
```

## Interfaces it reads

From the index, word for word (card 1 built these; `recoverSending(teamId)` is card 3's, bridged until then):

```ts
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

// packages/db/src/store/inbox-open-rows.ts (card 1)
export interface InboxPlacement {
  /** Workspaces connected now: a sent, unreturned card whose send is in one of them is Waiting's, not Open's. */
  readonly connectedTeams: readonly string[];
}

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
```

## State-table rows

| State | Event | Next |
|---|---|---|
| no workspace | Add Workspace, a token Slack accepts | the workspace is listed; `recordBot(…, 'token')` records its bot; its watch starts and checks at once (card 2) |
| A signed in | Add Workspace with B's token | B is added beside A; A's token, bindings and contacts are untouched (card 2) |
| A | a token for A again, same bot | A's token replaced; nothing else changes (card 2) |
| A | Replace Token on A's row with B's token | refused, "That token is for B"; nothing stored (card 2) |
| A | a token for A from a new bot (app made again) | one write: A's DM channels and cursors cleared, `botSince` now, A's sending and sent sends fail `bot_changed`, cards back to the builder; other workspaces untouched (card 2) |
| A, no bot on record (stored before this, or reconnected) | the first check or a token | the bot is recorded with `botSince` now; A's DM channels are forgotten; no send fails (card 2) |
| A, a watch check in flight with the old token | a token from a new bot is saved | the writes are serial; whichever records first wins. Token first: the stale check sees a different bot and does nothing. Check first: the token is a bot change (card 2) |
| A | Disconnect | A's entry (bot record included) and token removed, its state dropped, its watch stopped after its tick in flight; contacts and bindings kept; A's projects read Off; A's sent cards show in Open (card 2) |
| A, a watch tick in flight | Disconnect | the tick finishes; its late `connections.set` is a no-op because A is no longer stored (card 2) |
| A, a watch tick in flight | Replace Token | `reconnect` waits for the tick, then checks with the new token; a refusal the old token earned is overwritten by that check (card 2) |
| A refused, B connected | ticks | A's watch pauses; B reads and sends; Waiting holds only B's sent cards; Overview names A (cards 2, 4) |
| daemon started | — | each workspace is `checking` until its first check, which runs at once (card 2) |
| `TENDB_SLACK=off` | any | `off: true`; rows listed read-only; nothing read or sent (cards 2, 4) |
| a send reserved in A | post, follow-up, reminder, move, closing line | made with A's client only; DM channel from the recipient's A contact (cards 2, 3) |
| A disconnected, then reconnected | drafts held `slack_off`, Copy For cards | nothing runs by itself: the builder presses Send on a held draft, or Ask Someone on a Copy For card (cards 2, 3) |

## Tests

Core: the token refusal and the bot change decide which workspace a post reaches. Extend
`apps/daemon/src/daemon/slack-sign-ins.test.ts`, which already runs the real services over a fake `fetch` and a
memory Keychain. Its first case's expectation, that a second token replaces the first, now inverts.
- A token for a second team is added beside the first: both Keychain items and both entries remain.
- Replace Token on team A with a token whose `auth.test` names team B is refused, and neither the Keychain nor
  `slack.workspaces` changes.
- A token for team A from a new bot user (A had a bot on record) clears the DM channel of A's contact and fails
  A's sent send with `bot_changed`, giving its card to the builder. B's contact and B's sent send are untouched.
  Seed the sends with card 1's store calls.
- Reply watches, through `createReplyWatches`: A's `auth.test` answers `invalid_auth` and B's succeeds. Call
  `start()`, then `stop()`, which waits for each first check. A reads `refused`, B reads `connected`, and every
  call the fake `fetch` saw for B carried B's token. No test-only export.

One value card for the commit that adds the cases: `protects=a post reaches only its own workspace's bot;
fails_when=a token for another team swaps a workspace, a new bot keeps stale DM channels, or one workspace's
refusal stops another; why_new=data going out and recovery (core); no_claim=Slack's real auth.test or channel
semantics`.

## Done when

The checks in Global Constraints pass. `grep -rn "workspaces\[0\]\|slackTokenReader" apps` finds nothing.
