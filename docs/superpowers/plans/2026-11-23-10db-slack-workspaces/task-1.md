# Card 1: contracts, schema and stores

**Decision:** `decisions/2026-11-23-a-projects-slack-workspace-is-its-own.md`, "One person, a contact per
workspace" and "Everything a send does uses its own workspace". Stakeholder spec §5 ("A Slack contact") and §7.5
("What a send records") as amended by it.
**Track:** A, first. Everything else builds on these shapes.

## Files

- **Contracts.**
  - `packages/contracts/src/team.ts`: `PersonInput.slack` and `PersonDto.slack` become lists; add `contactIn`.
    `SlackContactDto` and `SlackContactInput` stay as they are.
  - `packages/contracts/src/slack.ts`: `SlackWorkspace` gains `botUserId`, `botName` and `botSince` (optional, so
    a stored entry from before still parses). Add `SlackWorkspaceState`, `SlackWorkspaceStatusDto`,
    `SlackStatusDto` and `SendFailure`. `SlackTokenInput` gains `teamId`. `ProjectSlackDto` loses `auto` and
    gains `out`. `StakeholderSendDto` gains `teamId`. `SlackConnectionDto` stays until card 2, which moves its
    readers.
  - Regenerate `packages/contracts/generated/`.
- **Schema.** `packages/db/src/schema.ts`: `person_contacts.person_id` loses `.unique()` and the table gains
  `uniqueIndex('person_contacts_person_team').on(t.personId, t.teamId)`; `stakeholder_sends` gains a nullable
  `team_id`. Fix the `person_contacts` doc comment ("one row per person and workspace").
- **Dev migration.** `pnpm --filter @10db/db generate` once, after the schema change, and commit it so the
  branch's tests run. It is a `DROP INDEX`, a `CREATE UNIQUE INDEX` and an `ALTER TABLE … ADD`; no rebuild. The
  coordinator regenerates it at each merge of `main` that brings a migration, and card 6 replaces it; never edit it
  by hand.
- **Stores.**
  - `packages/db/src/store/team.ts`:
    - `writeContact` becomes `writeContacts(ctx, personId, list)`: a team left out is deleted; a new team is
      inserted; an existing team keeps its row, and a changed `userId` there clears `dmChannelId` and
      `dmCursor`.
    - `contactOf` takes a team id. `personDto` gets every contact of the person, oldest first. `listPeople` reads
      all contacts once and groups them.
    - `setDmChannel`, `getDmCursor` and `setDmCursor` take `teamId`. Add `clearTeamDmChannels`.
  - `packages/db/src/store/stakeholder-sends.ts`:
    - `insertDraft` takes `teamId`, reads each recipient's contact in it, and writes `team_id`.
    - `everSent` and `newThreadsSince` take `teamId` and count only that team's sends. A send with a null team
      counts for no team.
    - `latestThreadFor` takes `teamId` and `since`: only sends in that team whose `sent_at` is at or after
      `since`; a null `since` joins nothing.
    - `openSends` and `sendingSends` take an optional `teamId`; their rows carry `teamId`. `timer-watch.ts`
      keeps calling `openSends(db)` with none: the timers need no Slack.
    - Add `liveSendsWhere`. The send DTO carries `teamId`.
  - `packages/db/src/store/inbox-open-rows.ts` and `inbox-page.ts`: `InboxPlacement` becomes
    `{ connectedTeams }`. A sent, unreturned card is left out of Open only when its live send's `team_id` is in
    the list; an empty list leaves every such card in Open.
- **Callers, bridged.** Every caller outside `packages/` must still compile. Make the smallest change that keeps
  today's behavior for one workspace, marked `// TODO(slack-workspaces)`:
  - The daemon's `person.slack` readers (`drafts.ts`, `sends.ts`): the first contact.
  - The store calls that now take a team: the contact's own team; `latestThreadFor`'s `since`: the epoch.
  - `daemon/services.ts`: the one connection's team when connected, else none.
  - The seed scripts (`apps/daemon/scripts/seed-*.ts`), `apps/daemon/test/engine.ts` and the tests that build a
    person with `slack: {…}`: a one-item list.
  - The desktop's `person.slack` readers (`people-section.tsx`, `person-modal.tsx`, `which-is-you.tsx`,
    `slack-card.tsx`, `ask-someone.tsx`, `route-line.ts`, `slack-preview.tsx`, `test/people-fixtures.ts`).
  Cards 2-5 replace every shim.
- **Docs.** `packages/db/AGENTS.md` only if a rule changed (none should). The storage catalogue entry is card 6's.

## Interfaces it implements

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
```

## State-table rows

None as behavior: this card gives later cards the shapes. These rows rest on its stores:
- "bound to A, Mark's limit reached in B" and "Mark never sent to in A": `newThreadsSince` and `everSent` count by
  team.
- "an answered A thread from before A's `botSince`": `latestThreadFor`'s `since`.
- "A refused, B connected" (Waiting holds only B's): `InboxPlacement.connectedTeams`.

## Tests

None. Card 3's test exercises these stores through the real sends, and card 6's migration test reads the
composite index. Update the existing tests and fixtures that build a person or a placement so they compile.

## Done when

The checks in Global Constraints pass, `pnpm --filter @10db/db drift` is clean, and your report lists the shims
`grep -rn "TODO(slack-workspaces)" apps` finds.
