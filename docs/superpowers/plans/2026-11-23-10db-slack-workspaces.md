# Plan: Slack, one workspace per project

**Size:** Core (10db's Careful). It decides where data goes out of the laptop (which company's Slack a question
reaches), recovers sends after a bot change, and migrates contacts and sends. It gets this index, one card per
task and a plan review. Sub-steps inside a card (a route, a menu item) get no process of their own.
**Design:** `decisions/2026-11-23-a-projects-slack-workspace-is-its-own.md` (the rulings), and the architecture
review behind it (`~/Agents/notes/10db/2026-11-23-slack-workspaces-review.md`, read-only, outside the repo). It
amends the stakeholder spec (`docs/superpowers/specs/2026-11-11-10db-stakeholder-questions-design.md`) §5, §9.1,
§9.2 and §10.1, and the sign-ins spec's "Sign-ins and bindings".
**Builds on:** `fix/slack-startup-check` (#763), assumed merged: the reply watch checks its connection as soon as
it starts. Every per-workspace watch here keeps that.

## Brief

**What changes for you.**
- Settings › Integrations › Slack becomes a list of workspaces. Each row reads "Ampsio · posts as @10db · you're
  @travis" with its state, and a menu: **Change Who You Are**, **Replace Token**, **Disconnect**. **Add Workspace**
  opens the same three steps as today (copy the manifest, make the app in that workspace, paste its token). Each
  workspace has its own app.
- Each project row has a **Select**, a workspace or **Off**, in place of the switch. Your current projects are
  bound to Ampsio when this lands, so nothing changes. A new project starts Off and sends nothing until you pick.
- People: a person keeps one row, with a Slack chip per workspace they're in. The person modal lists their
  contacts, each with its own send mode and daily limit, and adds one per workspace.
- A question goes to a person only through their contact in the project's workspace. Someone with none there
  gets **Copy for <name>**, never a message from another workspace. Ask Someone and the routes editor mark them
  "not in Acme's Slack".
- Which One Is You is asked per workspace and no longer blocks Send. Your first pick still names you.
- Overview and the Inbox's Waiting tab read each workspace's own state: one refused token no longer pulls every
  waiting card back into Open.
- Fixed on the way: re-making the Slack app (a new bot) left people unreachable (`channel_not_found`) until you
  removed and re-added them. Now 10db forgets that workspace's DM channels and old threads and hands its open
  questions back to you.

**What it buys.** A second company's project can use its own Slack, and nothing in the send path can carry one
company's question into another's workspace. Today a second token replaces the first, moves unbound projects to
it, and posts the first company's contacts with the second's bot.

**What could go wrong, and how we'd know.**
- **A post goes out with the wrong token.** Every Slack call of a send goes through `clientFor(send.teamId)`, and
  a draft is made only from contacts in the project's workspace. Card 3's test runs the real sends over a fake
  `fetch` that records each call's token and user, across two workspaces, Off, and a person missing a contact.
- **A moved project still posts in the old workspace.** The binding and the take-back are one write, and a send
  whose team differs from its project's stored binding is never posted to. A post already in flight that lands
  afterwards is closed with a "taken back" line in that thread, never marked sent (card 3).
- **A migration drops or merges contacts.** Card 6's test migrates a database seeded at the previous migration and
  compares contacts, sends and bindings before and after.
- **One workspace's trouble stalls another.** Each workspace has its own watch, timer and state. Card 2's test has
  one workspace refused while the other connects with its own token.
- **A bot change is missed.** The bot user id is kept with each workspace. A token from a different bot clears that
  team's DM channels, puts its older threads out of reach, and fails its open sends back to you (card 2's test).
  A workspace with no bot on record (stored before this, or reconnected) records one and forgets its DM channels.

**Calls you might disagree with.**
1. **Changing a project's workspace, or turning it Off, takes back its questions that are out** (sending or sent):
   they fail back to you with "workspace changed". Drafts are drafted again for the new workspace (or wait, held,
   when Off). The Select confirms first when anything is out. Today, Off kept reading replies to questions
   already sent. Cost if wrong: replies to a moved project's questions are read on in the old workspace instead.
2. **Nothing is asked again by itself.** Copy For cards made while a project was Off, and drafts held while its
   workspace was disconnected, wait for you: Ask Someone or Send. Cost if wrong: a re-ask pass later.
3. **A Disconnected workspace keeps its contacts and project bindings, and forgets its bot.** Its projects read
   Off while it's gone and come back on reconnect, which counts as a first connection: DM channels reopen and a
   follow-up starts a new thread. Its sent cards stay in your Inbox's Open, as Disconnect does today.
4. **The daily limit and the first-send review count per workspace.** Mark's first question in Acme is shown to
   you first, even if he's had many in Ampsio. Cost if wrong: one extra review per person per workspace.
5. **A builder still named "You" has drafts shown first** rather than Send refused. Your name only changes how a
   message reads, and you can edit it in the preview. Cost if wrong: a refusal again.
6. **A draft records its workspace when it's drafted,** not when it's sent (the review proposed at reserve). The
   draft's recipients are read from that workspace's contacts, so the team must be known then.
7. **A new question in an Off project gets Copy for, not a held draft.** Today an Off project's question is
   drafted and held "Slack is off". With contacts per workspace an Off project has no workspace to draft from.
8. **Rows of a workspace show even with `TENDB_SLACK=off`**, read-only and marked Off, so a dev daemon and the e2e
   can show the list and the project Select.

**What is needed from you.** Nothing to start. On the draft PR, once cards 1-5 are merged into it: a free second
Slack workspace you can install an app in, and ten minutes. Run `TENDB_SLACK=on pnpm dev:window` in the
integration worktree, whose data directory (`.dev/data`) is throwaway and holds none of the installed app's
workspaces. Add that workspace, bind a project, and ask yourself a question there. The installed app is never
touched.

---

## Global Constraints

- Read `AGENTS.md`, `.claude/rules/code-style.md`, `.claude/rules/testing.md`, and the `AGENTS.md` of every
  directory you touch, once each. Keep notes in your scratch folder.
- **Live Slack is never called from an agent.** Agents never read the real Keychain items `slack-bot*`, never
  write the real database (`~/Library/Application Support/10db`), and every daemon they start has
  `TENDB_SLACK=off`. Tests talk to Slack through `createSlackClient` over a fake `fetch` (the network is the
  boundary; `.claude/rules/testing.md`), with real stores and the real sends, watches and services.
- **The repo typechecks after every card.** Where a later card owns a caller, the earlier card bridges it with the
  smallest shim, marked `// TODO(slack-workspaces)`. The coordinator greps for that marker before the pull request
  leaves draft; none may remain.
- **Migrations are forward-only** (`v0.1.0` is tagged and an ancestor of `main`; `packages/db/AGENTS.md`). Card 1
  generates one dev migration so the branch's tests run. **At each merge of `main` into the integration branch**
  the coordinator checks whether `main` added a migration. If it did, the coordinator deletes the dev migration
  (its `.sql`, its `drizzle/meta` snapshot and its `_journal.json` entry), takes `main`'s files as they are, runs
  `pnpm --filter @10db/db generate`, and commits the regenerated dev migration in the merge. Card 6 replaces it
  after the final merge. No other card commits a migration, and only one open pull request adds migrations at a
  time.
- **No reach across workspaces, anywhere.** No code path picks "a" workspace: no `workspaces[0]` (card 6's
  migration is the one exception, and says so), no fallback to the only one, no contact read without a team id.
- **Two bindings, two uses.** Drafting reads the *effective* binding (`projectSlack`: a stored workspace that is
  signed in, else Off). A reserved or sent send checks the *stored* binding (`boundTeam`): a team that differs is
  taken back; a disconnected one waits.
- Labels are Title Case. Desktop copy follows the brief's words: "Add Workspace", "Replace Token", "Change Who You
  Are", "Disconnect", "Off", "not in <Workspace>'s Slack", "Copy for <name>".
- Tests: only those named on the card, each with a value card in its commit (`.claude/rules/testing.md`). No
  rendered-component tests and no test-only exports; the UI extends `apps/desktop/e2e/stakeholder-questions.spec.ts`.
- While working, run `pnpm vitest related <files> --maxWorkers=2` plus typecheck and lint of the packages
  changed. Before you hand back, run `make precheck`. Never the full suite, never `make check-changed` (this is an
  integration branch). If lint runs out of memory, rerun it with `NODE_OPTIONS=--max-old-space-size=8192`.
- Commit after every green step, naming paths. Scopes: `daemon`, `desktop`, `contracts`, `db`, `docs`.
- Use the injected `Clock`, not `Date.now` or a bare `setTimeout`.

## Provider parity

Nothing differs by provider. Slack is reached only by the daemon, over `fetch`, with a bot token from the Keychain.
No agent, harness or account takes part: a lane on a Claude plan, Claude through Bedrock or an API key, or a
ChatGPT/Codex plan raises the same `ask_human` card, and routing, drafting, sending and reading run on that card
afterwards (`decisions/2026-11-12-stakeholder-questions-run-on-the-inbox-card.md`). A project's workspace is a
setting of the project, independent of its account; moving a project to another account never changes its
workspace. The judge's reply-match and approval decisions keep their per-account fallback rules unchanged.

## Interfaces

Each card repeats, word for word, the blocks it implements or reads.

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

// packages/db/src/schema.ts (card 1)
// person_contacts: person_id loses .unique(); (t) => [uniqueIndex('person_contacts_person_team').on(t.personId, t.teamId)]
// stakeholder_sends: teamId: text('team_id')   // nullable; set by insertDraft

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

// apps/desktop/src/daemon/people.ts (cards 2, 4 and 5)
export function useSlackStatus(): UseQueryResult<SlackStatusDto>;            // replaces useSlackConnection
export function useSetSlackToken(): UseMutationResult<SlackStatusDto, Error, SlackTokenInput>;
export function useRemoveSlackWorkspace(): UseMutationResult<SlackStatusDto, Error, string>;
export function useSlackMembers(teamId: string | null, query: string, enabled: boolean): UseQueryResult<SlackMemberDto[]>;
export function useSlackMember(teamId: string | null, userId: string | null): SlackMemberDto | null;
```

## State table (design, not a test list)

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
| A connected, the builder has no A contact | the row is shown | Which One Is You on A's row; nothing is blocked (card 4) |
| the builder named "You" | first That's Me, in any workspace | that contact saved and the builder renamed (card 4) |
| the builder named | That's Me in another workspace | that contact saved; the name is kept (card 4) |
| upgrade, one workspace W | migration | every project without a setting bound to W; a stored Off stays Off; each send gets its team; contacts keep their rows (card 6) |
| upgrade, a live send whose team can't be found | migration | failed `no_workspace` and its card back to the builder, by the migration itself (card 6) |
| upgrade, no workspace | migration | nothing is bound; every project reads Off (card 6) |

## Tracks

Integration branch `feat/slack-workspaces`, a draft PR from the first push. Each implementer works in its own
worktree `../10db-worktrees/slack-workspaces-<track>`, branched from the integration branch. The coordinator merges
each card in.

- **Track A** (worktree `slack-workspaces-a`):
  - [Card 1](2026-11-23-10db-slack-workspaces/task-1.md): contracts, schema and stores: contacts per workspace,
    a send's team, workspaces with their bot, Waiting by workspace; one dev migration; shims for every caller.
  - [Card 2](2026-11-23-10db-slack-workspaces/task-2.md): workspaces in the daemon: a client, a state and a reply
    watch per workspace, token add, replace and refusal, the bot record and the bot change, Disconnect, the
    routes. Core.
  - [Card 3](2026-11-23-10db-slack-workspaces/task-3.md): sends by workspace: drafts from the project's
    workspace, limits per contact, posts with the send's client, the binding change in one write, late posts,
    old threads, the builder's name hold. Core. *Review group 1: cards 1-3.*
  - [Card 6](2026-11-23-10db-slack-workspaces/task-6.md): the migration, regenerated after the final merge of
    `main`, with the data migration and its test. Last. *Review group 3.*
- **Track B** (worktree `slack-workspaces-b`, starts once card 2 is merged):
  - [Card 4](2026-11-23-10db-slack-workspaces/task-4.md): Settings › Integrations › Slack as a list, the project
    Select, Which One Is You per workspace, Overview and the Inbox's Slack card. Feature.
  - [Card 5](2026-11-23-10db-slack-workspaces/task-5.md): People, the person modal, Ask Someone, the routes
    editor, the card's route line and preview; the e2e extension; the spec notes. Feature. Its e2e leg needs
    card 3 merged. *Review group 2: cards 4-5, after a click-through against the real daemon.*

**In parallel:** card 3 and card 4 run side by side once card 2 is merged, and card 5 runs beside card 3 until its
e2e leg. Cards 1 and 2 are sequential (every later card needs their shapes), and card 6 waits for everything.
**Shared files:** `apps/daemon/src/daemon/start.ts` (cards 2, 3), `apps/daemon/test/engine.ts` (cards 1-3),
`apps/desktop/src/daemon/people.ts` (cards 2, 4, 5) and the e2e spec (cards 4, 5). The coordinator merges them.
**Builder QA:** on the draft PR once cards 1-5 are merged, as the brief says; card 6 does not wait for it.

## Notes from plan review round 2

- **Upgrade resets thread joining once.** An existing workspace has no `botSince`, so its first check stamps
  now: the first follow-up per task after the upgrade (or after a Disconnect and reconnect) opens a new thread and
  may be held for review again. Accepted.
- **A stored-Off project with questions still out loses them at upgrade.** Their team differs from the stored
  binding (null), so the first touch fails them back as `workspace_changed`. Accepted: it is the new rule.
- **Card 6 leaves orphan drafts as drafts.** Statement 3 fails only sending or sent sends it can't place;
  `failSend` allows nothing else, so a draft is never moved straight to failed.
- **Card 3 touches `reply-watch.ts`** for the stored-binding check on reminders (card 2 owns the file; only a race
  reaches it). Card 3 runs after card 2 merges.
