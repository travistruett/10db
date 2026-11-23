# Card 1: contracts, schema and stores

**Decision:** `decisions/2026-11-23-a-projects-slack-workspace-is-its-own.md`, "One person, a contact per
workspace" and "Everything a send does uses its own workspace". Stakeholder spec §5 ("A Slack contact") and §7.5
("What a send records") as amended by it.
**Track:** A, first. Everything else builds on these shapes.

## Files

- **Contracts.**
  - `packages/contracts/src/team.ts`: `PersonInput.slack` and `PersonDto.slack` become lists; add `contactIn`.
    `SlackContactDto` and `SlackContactInput` stay as they are.
  - `packages/contracts/src/slack.ts`: `SlackWorkspace` gains `botUserId` and `botName` (optional, so a stored
    entry from before still parses). Add `SlackWorkspaceState`, `SlackWorkspaceStatusDto`, `SlackStatusDto` and
    `SendFailure`. `SlackTokenInput` gains `teamId`. `ProjectSlackDto` loses `auto`. `StakeholderSendDto` gains
    `teamId`. Remove `SlackConnectionDto` in card 2, not here: its readers move there.
  - Regenerate `packages/contracts/generated/`.
- **Schema.** `packages/db/src/schema.ts`: `person_contacts.person_id` loses `.unique()` and the table gains
  `uniqueIndex('person_contacts_person_team').on(t.personId, t.teamId)`; `stakeholder_sends` gains a nullable
  `team_id`. Fix the `person_contacts` doc comment ("one row per person and workspace").
- **Dev migration.** `pnpm --filter @10db/db generate` once, after the schema change, and commit it so the
  branch's tests run. It is a `DROP INDEX`, a `CREATE UNIQUE INDEX` and an `ALTER TABLE … ADD`; no rebuild. Card 6
  deletes and regenerates it; do not edit it by hand.
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
    - `everSent`, `newThreadsSince` and `latestThreadFor` take `teamId` and count or join only that team's sends.
      A send with a null team counts for no team.
    - `openSends` and `sendingSends` take an optional `teamId`; their rows carry `teamId`. `timer-watch.ts`
      keeps calling `openSends(db)` with none: the timers need no Slack.
    - Add `liveSendsWhere`. The send DTO carries `teamId`.
  - `packages/db/src/store/inbox-open-rows.ts` and `inbox-page.ts`: `InboxPlacement` becomes
    `{ connectedTeams }`. A sent, unreturned card is left out of Open only when its live send's `team_id` is in
    the list; an empty list leaves every such card in Open.
- **Callers, bridged.** Every caller outside `packages/` must still compile. Make the smallest change that keeps
  today's behavior for one workspace, marked `// TODO(slack-workspaces)`:
  - The daemon's `person.slack` readers (`drafts.ts`, `sends.ts`): the first contact.
  - The store calls that now take a team: the contact's own team.
  - `daemon/services.ts`: the one connection's team when connected, else none.
  - The seed scripts (`apps/daemon/scripts/seed-*.ts`), `apps/daemon/test/engine.ts` and the tests that build a
    person with `slack: {…}`: a one-item list.
  - The desktop's `person.slack` readers (`people-section.tsx`, `person-modal.tsx`, `which-is-you.tsx`,
    `slack-card.tsx`, `ask-someone.tsx`, `route-line.ts`, `slack-preview.tsx`, `test/people-fixtures.ts`).
  Cards 2-5 replace every shim.
- **Docs.** `packages/db/AGENTS.md` only if a rule changed (none should). The storage catalogue entry is card 6's.

## Interfaces it implements

Quoted from the index, exactly:

```ts
export function contactIn(person: Pick<PersonDto, 'slack'>, teamId: string | null): SlackContactDto | null;
export function setDmChannel(ctx: WriteContext, personId: PersonId, teamId: string, channelId: string): void;
export function getDmCursor(db: DbReader, personId: PersonId, teamId: string): string | null;
export function setDmCursor(ctx: WriteContext, personId: PersonId, teamId: string, ts: string): void;
export function clearTeamDmChannels(ctx: WriteContext, teamId: string): number;
export function insertDraft(ctx: WriteContext, input: {
  readonly inboxItemId: InboxItemId; readonly teamId: string; readonly recipients: readonly PersonId[];
  readonly text: string; readonly hits: readonly OutboundHit[];
}): StakeholderSendDto;
export function everSent(db: DbReader, personId: PersonId, teamId: string): boolean;
export function newThreadsSince(db: DbReader, personId: PersonId, teamId: string, since: string): number;
export function latestThreadFor(db: DbReader, recipients: readonly PersonId[], taskId: TaskId, teamId: string):
  { channelId: string; threadTs: string; reviewed: boolean } | null;
export function openSends(db: DbReader, teamId?: string): OpenSendRow[];
export function sendingSends(db: DbReader, teamId?: string):
  { id: StakeholderSendId; teamId: string | null; channelId: string | null; threadTs: string | null; startedAt: string }[];
export function liveSendsWhere(db: DbReader, filter: { readonly teamId: string } | { readonly projectId: ProjectId }):
  { id: StakeholderSendId; inboxItemId: InboxItemId; state: SendState; teamId: string | null }[];
export interface InboxPlacement { readonly connectedTeams: readonly string[]; }
```

And the contract shapes in the index's `team.ts` and `slack.ts` blocks.

## State-table rows

None as behavior: this card gives later cards the shapes. The rows "bound to A, Mark's limit reached in B" and
"Mark never sent to in A" rest on `newThreadsSince` and `everSent` counting by team.

## Tests

None. Card 3's test exercises these stores through the real sends, and card 6's migration test reads the
composite index. Update the existing tests and fixtures that build a person or a placement so they compile.

## Done when

The checks in Global Constraints pass, `pnpm --filter @10db/db drift` is clean, and `grep -rn "TODO(slack-workspaces)"
apps` lists the shims you left, in your report.
