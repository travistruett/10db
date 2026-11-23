# Card 2: workspaces in the daemon

**Decision:** `decisions/2026-11-23-a-projects-slack-workspace-is-its-own.md`, "Several workspaces, one app each",
"A project names its workspace, or none", "A new bot is a new conversation" and the per-workspace watch in
"Everything a send does uses its own workspace". Stakeholder spec §9.2 ("The connection in 10db") and §8.2
("Reading replies") as amended.
**Track:** A, after card 1. **Core:** the token refusal and the bot change decide where posts go.

## Files

- **Slack client.** `apps/daemon/src/slack/responses.ts` (`AuthTestReply` gains `user`) and `client.ts`
  (`SlackIdentity` gains `botName`).
- **Clients per workspace.** `apps/daemon/src/stakeholders/slack-clients.ts` (new): `createSlackClients`. A
  client per signed-in team, made on first use and kept; its token is read from `slackBotAccount(teamId)` at each
  call, as today. `clientFor` answers null for a team not in `slack.workspaces`.
- **The workspace list.** `apps/daemon/src/stakeholders/slack-workspaces.ts`: add `saveSlackWorkspace` and
  `removeSlackWorkspace`; remove `slackTokenReader`. `projectSlack` drops `auto`: no setting, `null`, or a
  workspace not signed in is Off. Nothing reads `workspaces[0]` any more.
- **States per workspace.** `apps/daemon/src/stakeholders/slack-connection.ts`: `SlackConnection` becomes
  `SlackConnections`. `list()` answers every workspace in `slack.workspaces` with its state (`checking` until its
  watch's first check); `off` comes from the daemon's options. The event names the team.
- **Returns.** `apps/daemon/src/stakeholders/send-returns.ts` (new): `failSendsToBuilder`, `recoverFromBotChange`
  and `recordBot`. Point `reply-watch.ts`'s `guard` and `sends.ts`'s `fail` at `failSendsToBuilder` so the
  three places that hand a card back share one write.
- **Watches per workspace.**
  - `apps/daemon/src/stakeholders/reply-watch.ts`: one watch per team. It takes `teamId`, its own `slack`
    client, the shared `connections` and `matched`. It reads `openSends(db, teamId)` and calls
    `sends.recoverSending(teamId)`; until card 3 changes that signature, bridge it with a TODO shim. Its
    identity check calls `recordBot` in a write (bot unknown: record and forget DM channels; a different one:
    `recoverFromBotChange`). It sets only its own team's state. Keep the immediate first check that #763 added.
  - `apps/daemon/src/stakeholders/reply-watches.ts` (new): `createReplyWatches`. It loads `MatchState` once,
    makes a watch per signed-in workspace on `start()`, and adds or stops one on `reconnect` and `drop`. Each
    watch has its own timer, so a slow or refused workspace never delays another.
- **Services and routes.**
  - `apps/daemon/src/daemon/stakeholder-services.ts`:
    - `setSlackToken`: check the token on a client of its own, as today. With `input.teamId` set and Slack's
      team different, refuse with `InvalidError` ("That token is for <team>. Use Add Workspace for it.") before
      the Keychain is touched.
    - Then write the token to `slackBotAccount(teamId)` and, in one state write, `saveSlackWorkspace`: a
      changed bot runs `recoverFromBotChange`, and an unknown one `clearTeamDmChannels`.
    - Then set that team `connected` and `await watches.reconnect(teamId)`. Another workspace's token is never
      removed.
    - `removeSlackWorkspace(teamId)`: remove that Keychain item, `removeSlackWorkspace`, `connections.drop`,
      `watches.drop`. Contacts and project bindings stay.
    - `listSlackMembers(teamId, query)`: the member cache is per team. 409 when the team isn't signed in or
      Slack is off.
    - `setProjectIntegrations` keeps refusing a workspace that isn't signed in. Card 3 adds the rebind.
    - `projectIntegrations` fills `slack.out` from `liveSendsWhere({ projectId })`, counting sending and sent.
  - `apps/daemon/src/api/services.ts` and `apps/daemon/src/api/app.ts`: the four routes in the index's
    Interfaces. `DELETE /slack/token` is removed. `GET /slack/members` reads `teamId` with zod.
  - `apps/daemon/src/daemon/services.ts`: `pageInbox(…, { connectedTeams: connections.connectedTeams() })`.
- **Wiring.** `apps/daemon/src/daemon/start.ts`: `slackClients` (null with `TENDB_SLACK=off`),
  `slackConnections`, `replyWatches.start()` after recovery. `sends` keeps a single-client bridge (TODO) until card
  3. `apps/daemon/test/engine.ts` follows.
- **Desktop bridge.** `apps/desktop/src/daemon/people.ts`: `useSlackStatus`, `useSetSlackToken` (takes
  `SlackTokenInput`), `useRemoveSlackWorkspace`, `useSlackMembers(teamId, …)` and `useSlackMember(teamId, …)`. Its
  readers keep compiling through TODO shims on the first workspace; card 4 replaces them. Remove
  `SlackConnectionDto` from contracts and regenerate.
- **Docs.** `apps/daemon/AGENTS.md`: the `TENDB_SLACK=off` note names `slack-bot:<teamId>` (it still says
  `slack-bot`), and the `slack/` note adds that a client belongs to one workspace. A new
  `apps/daemon/src/stakeholders/AGENTS.md` (none exists) with four lines: a send's workspace is its project's,
  clients by team, a watch per workspace, the bot record. `apps/daemon/src/inbox/AGENTS.md`: Waiting is per
  workspace (`connectedTeams`), replacing the `waitingOut` sentence.

## Interfaces it implements

Quoted from the index, exactly:

```ts
export interface SlackClients {
  clientFor(teamId: string): SlackClient | null;
}
export function createSlackClients(deps: {
  readonly state: StateStore; readonly keychain: Keychain; readonly fetch: typeof fetch;
  readonly clock: Clock; readonly timeoutMs: number;
}): SlackClients;
export function saveSlackWorkspace(ctx: WriteContext, workspace: Required<SlackWorkspace>):
  { readonly botChanged: boolean; readonly botKnown: boolean };
export function removeSlackWorkspace(ctx: WriteContext, teamId: string): void;
export function projectSlack(db: DbReader, projectId: ProjectId): ProjectSlackDto;
export interface SlackConnections {
  readonly off: boolean;
  list(): SlackStatusDto;
  get(teamId: string): SlackWorkspaceStatusDto | null;
  set(teamId: string, state: SlackWorkspaceState, detail?: {
    readonly identity?: SlackIdentity; readonly error?: string | null; readonly at?: string;
  }): void;
  drop(teamId: string): void;
  connectedTeams(): string[];
}
export function createSlackConnections(deps: { readonly state: StateStore; readonly off: boolean }): SlackConnections;
export function failSendsToBuilder(ctx: WriteContext,
  sends: readonly { readonly id: StakeholderSendId; readonly inboxItemId: InboxItemId }[], code: string): void;
export function recoverFromBotChange(ctx: WriteContext, teamId: string): StakeholderSendId[];
export function recordBot(ctx: WriteContext, identity: SlackIdentity): void;
export interface ReplyWatches {
  start(): void;
  stop(): Promise<void>;
  reconnect(teamId: string): Promise<void>;
  drop(teamId: string): Promise<void>;
  tick(teamId: string): Promise<void>;
}
export function createReplyWatches(deps: Omit<ReplyWatchDeps, 'teamId' | 'slack' | 'matched'> & {
  readonly slack: SlackClients | null;
}): ReplyWatches;
slackStatus(): SlackStatusDto;
setSlackToken(input: SlackTokenInput): Promise<SlackStatusDto>;
removeSlackWorkspace(teamId: string): Promise<SlackStatusDto>;
listSlackMembers(teamId: string, query: string): Promise<SlackMemberDto[]>;
```

It calls card 1's `clearTeamDmChannels`, `liveSendsWhere`, `openSends(db, teamId)` and `InboxPlacement`.

## State-table rows

- no workspace / Add Workspace → listed, connected, bot recorded, watch checks at once.
- A / Add Workspace with B's token → B beside A, A untouched.
- A / a token for A again, same bot → replaced, nothing else.
- A / Replace Token with B's token → refused, nothing stored.
- A / a token from a new bot → DM channels cleared, sending and sent sends fail `bot_changed`, others untouched.
- A stored before this / first check or token → bot recorded, DM channels forgotten, no send fails.
- A / Disconnect → token, watch and state gone; contacts and bindings kept; projects read Off.
- A refused, B connected → A paused, B reads; Waiting holds B's only.
- daemon started → `checking` until the first check.
- `TENDB_SLACK=off` → `off: true`, nothing read.

## Tests

Core: the token refusal and the bot change decide which workspace a post reaches. Extend
`apps/daemon/src/daemon/slack-sign-ins.test.ts`, which already runs the real services over a fake `fetch` and a
memory Keychain. Its first case's expectation, that a second token replaces the first, now inverts.
- A token for a second team is added beside the first: both Keychain items and both entries remain.
- Replace Token on team A with a token whose `auth.test` names team B is refused, and neither the Keychain nor
  `slack.workspaces` changes.
- A token for team A from a new bot user clears the DM channel of A's contact, fails A's sent send with
  `bot_changed` and gives its card to the builder. B's contact and B's sent send are untouched. Seed the sends
  with card 1's store calls.
- Reply watches: A's `auth.test` answers `invalid_auth` and B's succeeds. After one tick of each, A reads
  `refused`, B reads `connected`, and every call the fake `fetch` saw for B carried B's token. Run this through
  `createReplyWatches`, with `tick(teamId)`.

One value card for the commit that adds the cases: `protects=a post reaches only its own workspace's bot;
fails_when=a token for another team swaps a workspace, or a new bot keeps stale DM channels; why_new=data going
out and recovery (core); no_claim=Slack's real auth.test or channel semantics`.

## Done when

The checks in Global Constraints pass. `grep -rn "workspaces\[0\]\|slackTokenReader" apps` finds nothing.
