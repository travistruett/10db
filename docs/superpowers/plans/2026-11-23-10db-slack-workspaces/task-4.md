# Card 4: Settings › Integrations › Slack as a list of workspaces

**Size:** Feature (UI over card 2's routes). One code review, after a click-through against the real daemon.
**Decision:** `decisions/2026-11-23-a-projects-slack-workspace-is-its-own.md`, "Several workspaces, one app each",
"A project names its workspace, or none", "Changing a project's workspace takes its questions back, in the same
write" and "Which One Is You is per workspace, and blocks nothing". Stakeholder spec §10.1 as amended.
**Track:** B, first. Starts once card 2 is merged; may run beside card 3.

## Files

- **The card.** `apps/desktop/src/views/settings/sign-ins/slack-card.tsx`. Keep the `IntegrationCard` shell, the
  setup steps, `TokenField` and the Disconnect `ConfirmModal`.
  - **The list.** A row per workspace from `useSlackStatus()`, in stored order.
    - The row's line is "Acme · posts as @10db · you're @travis": its team, `@<botName>` (or `@10db` before the
      first check), and "you're @<member>" when the builder has a contact there.
    - A second, dim line gives the state when it is not `connected`, worded as today's `StateLine`. `checking`
      reads "Checking…".
  - **Each row's menu.**
    - **Change Who You Are** shows only when the builder has a contact there.
    - **Replace Token** opens a `TokenField` under the row that sends `{ token, teamId }`. A refusal ("That token
      is for …") shows as the field's error. A `refused` row opens it by itself, replacing the unbound field of
      today, which let a wrong token swap the workspace.
    - **Disconnect** confirms with the workspace's name: "10db stops sending and reading Acme's Slack and
      removes its token from your Keychain. Its projects send nothing until it is connected again. Questions
      already sent there stay in your Inbox."
  - **Adding.** With no workspace, the three steps show as today. With one or more, an **Add Workspace** button
    under the rows shows the same steps (step 2's text says "in the workspace you're adding"), and closes on
    success.
  - **`TENDB_SLACK=off`.** `off: true` keeps the card's "Off: 10db was started with TENDB_SLACK=off" line, lists
    the rows without menus, and hides Add Workspace.
- **Which One Is You.** `which-is-you.tsx` takes `teamId`. It shows on a row whose workspace is `connected` and
  where the builder has no contact.
  - It sends the builder's whole contact list with that team's contact added or replaced.
  - It renames the builder to the member's real name only while the builder is still named "You".
  - The first one (the builder still "You") stays the yellow callout, now worded "Pick yourself so messages
    carry your name." Any later one is a plain field with a dim "Optional" hint. Neither says sending waits.
- **The project rows.** `project-rows.tsx` `SlackProjectRow` becomes a Select labelled "Slack for <project>":
  the signed-in workspaces by name, then **Off**, with the value from `useProjectIntegrations`.
  - A change while `slack.out > 0` opens a `ConfirmModal`: "<n> questions out in <Workspace>'s Slack come back
    to you." It names Off the same way.
  - The project rows show whenever at least one workspace is listed, under the workspace rows.
- **Overview and the Inbox.**
  - `views/settings/overview-rows.ts` `slackState(status)`:
    - off → Off, as today;
    - no workspace → Needs You, "Not connected";
    - any workspace not `connected` or `checking` → Needs You, naming it ("Acme: token refused");
    - else Works, "Ampsio, Acme · posts as @10db".
    - `overview-section.tsx` passes the status.
  - `views/inbox/system-cards.ts`: one Slack-refused card per refused workspace, keyed `slack-refused:<teamId>`
    and naming it, linking to Integrations focused on Slack.
- **Hooks.** `apps/desktop/src/daemon/people.ts` and `sign-in-queries.ts`: drop card 2's TODO shims for these
  readers; `useSlackConnection` is gone. `daemon/events.ts` keeps invalidating `SLACK_KEY` on `slack` events.
- **Docs.** `docs/slack-app.md`: one app per workspace, made from the same manifest; Add Workspace, Replace Token,
  and that re-making an app is a new bot (open questions come back). `apps/desktop/src/views/settings/AGENTS.md`:
  one line on the Slack card's rows and the project Select.
- **e2e, the Integrations leg.** `apps/desktop/e2e/stakeholder-questions.spec.ts` and the seed it runs:
  - `apps/daemon/scripts/seed-question-card.ts` takes optional `workspaces` and `people`. `workspaces` is written
    to `slack.workspaces`; `people` are inserted with their contacts. It is the leg's existing seed; it gains
    no new file.
  - Seed two workspaces, Acme and Globex, and Dana Ruiz with a Globex contact only.
  - On Settings › Integrations, both rows show under the Off line, with no menus.
  - The e2e project's Select reads Off. Choose Acme, reload, and it still reads Acme.
  - Run `expectAccessible` on the card.

## Interfaces it implements

From the index, word for word:

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
| A refused, B connected | ticks | A's watch pauses; B reads and sends; Waiting holds only B's sent cards; Overview names A (cards 2, 4) |
| `TENDB_SLACK=off` | any | `off: true`; rows listed read-only; nothing read or sent (cards 2, 4) |
| bound to A, sends sending or sent in A | bound to B, or Off | in the binding's write: they fail `workspace_changed`, cards back to the builder; the Select confirms first (cards 3, 4) |
| A connected, the builder has no A contact | the row is shown | Which One Is You on A's row; nothing is blocked (card 4) |
| the builder named "You" | first That's Me, in any workspace | that contact saved and the builder renamed (card 4) |
| the builder named | That's Me in another workspace | that contact saved; the name is kept (card 4) |

Plus, as what this card shows (card 2 makes them): Add Workspace, the Replace Token refusal, Disconnect and
the `checking` state.

## Tests

No unit tests (`.claude/rules/testing.md`: a UI change extends a core e2e flow). The e2e leg above.

## Done when

The checks in Global Constraints pass. You clicked through the card against the real daemon (`make dev` or the
`10db-dev-window` skill) with two seeded workspaces, `TENDB_SLACK=off`. Screenshots of the list, Add Workspace's
steps, a row's menu and the project Select are in your scratch folder and named in your report.
