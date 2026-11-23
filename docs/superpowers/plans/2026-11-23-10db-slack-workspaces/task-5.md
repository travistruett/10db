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

Quoted from the index, exactly:

```ts
export function useSlackMembers(teamId: string | null, query: string, enabled: boolean): UseQueryResult<SlackMemberDto[]>;
export function useSlackMember(teamId: string | null, userId: string | null): SlackMemberDto | null;
export function contactIn(person: Pick<PersonDto, 'slack'>, teamId: string | null): SlackContactDto | null;
```

It calls `PUT /people/:personId` and `POST /people` with `PersonInput.slack` as a list, and
`GET /slack/members?teamId=&query=`.

## State-table rows

- bound to A / Priya with only B → "not in A's Slack", Copy for (shown).
- bound to A / Mark (A) and Priya (B only) → Copy for both (shown).
- Off / routed to Mark → "Slack is off for this project", Copy for (shown).

## Tests

No unit tests. The e2e leg above.

## Done when

The checks in Global Constraints pass. You clicked through People, the modal with two contacts, Ask Someone and a
Copy card against the real daemon with seeded workspaces. Screenshots are in your scratch folder and named in your
report. `grep -rn "TODO(slack-workspaces)" apps` finds nothing.
