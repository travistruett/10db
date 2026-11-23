# Card 5: People and the Inbox, per workspace

**Size:** Feature (UI). One code review with card 4, after a click-through against the real daemon.
**Decision:** `decisions/2026-11-23-a-projects-slack-workspace-is-its-own.md`, "One person, a contact per
workspace" and "No reach across workspaces". Stakeholder spec §5, §10.1 (People) and §10.2 ("The question card")
as amended.
**Track:** B, after card 4. It may start beside card 3; its e2e leg needs card 3 merged (the draft rule).

## Files

- **People.** `apps/desktop/src/views/settings/people/people-section.tsx`:
  - `ReachChip` becomes one chip per contact in a signed-in workspace: the Slack mark, the workspace's name and
    `@<member>` when the member list has them ("Acme @mark"). A person with none keeps "Not on Slack".
  - "How Sent" shows the mode when every contact shares it, else "By Workspace".
  - `ConnectSlack` shows only while no workspace is `connected`. The "setup isn't finished" variant goes:
    Which One Is You no longer holds anything.
- **The person modal.** `person-modal.tsx` and `member-select.tsx`:
  - `MemberSelect` takes `teamId`.
  - The modal lists the person's contacts, one block per workspace: the workspace's name, the member picked
    there, Send Mode and Daily Limit, and Remove.
  - **Add <Workspace>** adds a block for each signed-in workspace the person has no contact in.
  - A contact in a workspace that isn't signed in shows dimmed with "not connected" and Remove. It is kept on
    save unless removed: the modal always sends the whole list.
  - A new person's handle is proposed from the first member picked, as today.
- **Ask Someone and the routes editor.** `views/inbox/ask-someone.tsx` and `views/settings/add-route-modal.tsx`
  read the project's workspace with `useProjectIntegrations(projectId)`. A person's label is:
  - "<name> · Slack" with a contact there;
  - "<name> · not in <Workspace>'s Slack" without one;
  - "<name> · Slack is off for this project" when the project is Off.
  - A person never on Slack keeps "not on Slack".
  - Nobody is disabled: the builder may still ask them and copy the message.
- **The card.**
  - `views/inbox/route-line.ts`: `stakeholderMode`, `copyPeople` and the Copy rule read
    `contactIn(person, teamId)` with the project's team; callers pass it.
  - The Copy card's line names why, from the same three labels.
  - `views/inbox/slack-preview.tsx`: the limit is `contactIn(person, send.teamId)?.dailyLimit`.
- **Hooks.** Drop the remaining `TODO(slack-workspaces)` shims in `apps/desktop`.
  `apps/desktop/src/test/people-fixtures.ts` follows the list shape.
- **Docs.**
  - Short "Amended by `decisions/2026-11-23-a-projects-slack-workspace-is-its-own.md`" notes at the top of the
    stakeholder spec's §5, §9.1, §9.2 and §10.1, and under the sign-ins spec's "Sign-ins and bindings" Slack
    line. Leave the rest of the specs' text.
  - `apps/desktop/src/views/inbox/AGENTS.md`: one line on the Copy rule by workspace.
- **e2e, the People and Inbox leg.** It extends the same test in `stakeholder-questions.spec.ts`, after card 4's
  leg has bound the e2e project to Acme:
  - On Settings › People, Dana Ruiz's row shows one chip, "Globex". Her modal lists one contact, Globex, with
    Send Mode and Daily Limit, and offers **Add Acme**.
  - On the seeded question, Ask Someone lists "Dana Ruiz · not in Acme's Slack". Asking her leaves **Copy for
    Dana Ruiz** on the card, and its line names Acme.
  - Run `expectAccessible` on the modal and the card. Keep the Priya steps as they are.

## Interfaces it implements

From the index, word for word (the members hooks are card 2's; this card is their first real caller):

```ts
// apps/desktop/src/daemon/people.ts (cards 2, 4 and 5)
export function useSlackStatus(): UseQueryResult<SlackStatusDto>;            // replaces useSlackConnection
export function useSetSlackToken(): UseMutationResult<SlackStatusDto, Error, SlackTokenInput>;
export function useRemoveSlackWorkspace(): UseMutationResult<SlackStatusDto, Error, string>;
export function useSlackMembers(teamId: string | null, query: string, enabled: boolean): UseQueryResult<SlackMemberDto[]>;
export function useSlackMember(teamId: string | null, userId: string | null): SlackMemberDto | null;
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

// apps/daemon/src/api/services.ts (card 2)
slackStatus(): SlackStatusDto;
setSlackToken(input: SlackTokenInput): Promise<SlackStatusDto>;
removeSlackWorkspace(teamId: string): Promise<SlackStatusDto>;      // replaces removeSlackToken
listSlackMembers(teamId: string, query: string): Promise<SlackMemberDto[]>;
// Routes: GET /slack -> SlackStatusDto; PUT /slack/token -> SlackStatusDto;
// DELETE /slack/workspaces/:teamId -> SlackStatusDto (replaces DELETE /slack/token);
// GET /slack/members?teamId=&query= -> SlackMemberDto[] (409 when that workspace is not signed in or Slack is off)
```

## State-table rows

| State | Event | Next |
|---|---|---|
| bound to A | routed to Priya, who has only a B contact | no draft; Copy for Priya; marked "not in A's Slack" (cards 3, 5) |

Plus, as what this card shows (card 3 makes them): "project Off … routed to Mark" and "bound to A … routed to
Mark (A) and Priya (B only)".

## Tests

No unit tests. The e2e leg above.

## Done when

The checks in Global Constraints pass. You clicked through People, the modal with two contacts, Ask Someone and a
Copy card against the real daemon with seeded workspaces. Screenshots are in your scratch folder and named in your
report. `grep -rn "TODO(slack-workspaces)" apps` finds nothing.
