# Card 4: Settings › Integrations › Slack as a list of workspaces

**Size:** Feature (UI over card 2's routes). One code review, after a click-through against the real daemon.
**Decision:** `decisions/2026-11-23-a-projects-slack-workspace-is-its-own.md`, "Several workspaces, one app each",
"A project names its workspace, or none", "Changing a project's workspace takes its questions back" and "Which
One Is You is per workspace, and blocks nothing". Stakeholder spec §10.1 as amended.
**Track:** B, first. Starts once card 2 is merged; may run beside card 3.

## Files

- **The card.** `apps/desktop/src/views/settings/sign-ins/slack-card.tsx`. Keep the `IntegrationCard` shell, the
  setup steps, `TokenField` and the Disconnect `ConfirmModal`.
  - **The list.** A row per workspace from `useSlackStatus()`, in stored order. The row's line is
    "Acme · posts as @10db · you're @travis": its team, `@<botName>` (or `@10db` before the first check), and
    "you're @<member>" when the builder has a contact there. A second dim line gives the state when it is not
    `connected`, worded as today's `StateLine`, with `checking` reading "Checking…".
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

Quoted from the index, exactly:

```ts
export function useSlackStatus(): UseQueryResult<SlackStatusDto>;
export function useSetSlackToken(): UseMutationResult<SlackStatusDto, Error, SlackTokenInput>;
export function useRemoveSlackWorkspace(): UseMutationResult<SlackStatusDto, Error, string>;
export function useSlackMember(teamId: string | null, userId: string | null): SlackMemberDto | null;
```

It calls `GET /slack`, `PUT /slack/token`, `DELETE /slack/workspaces/:teamId`, `PUT /projects/:projectId/integrations`
and reads `ProjectSlackDto.out`.

## State-table rows

- no workspace / Add Workspace; A / Add Workspace with B's token; A / Replace Token with B's token (the refusal
  shown on the row).
- A / Disconnect (the confirm's words).
- A refused, B connected (each row its own state; Overview names A; one Inbox card for A).
- daemon started (`checking`); `TENDB_SLACK=off` (rows read-only).
- bound to A, sends out / bound to B or Off (the confirm).
- A connected, the builder has no A contact; first That's Me renames; a later one keeps the name.

## Tests

No unit tests (`.claude/rules/testing.md`: a UI change extends a core e2e flow). The e2e leg above.

## Done when

The checks in Global Constraints pass. You clicked through the card against the real daemon (`make dev` or the
`10db-dev-window` skill) with two seeded workspaces, `TENDB_SLACK=off`. Screenshots of the list, Add Workspace's
steps, a row's menu and the project Select are in your scratch folder and named in your report.
