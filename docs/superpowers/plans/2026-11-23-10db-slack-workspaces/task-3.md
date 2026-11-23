# Card 3: sends by workspace

**Decision:** `decisions/2026-11-23-a-projects-slack-workspace-is-its-own.md`, "Everything a send does uses its own
workspace", "One person, a contact per workspace", "No reach across workspaces", "Changing a project's workspace
takes its questions back" and the name hold in "Which One Is You is per workspace, and blocks nothing".
Stakeholder spec §5 ("A person with no contact"), §7.4 ("Who presses Send") and §7.5 as amended.
**Track:** A, after card 2. It may run beside card 4. **Core:** this is where a question leaves the laptop.

## Files

- **Drafts.** `apps/daemon/src/stakeholders/drafts.ts`:
  - `draftContext` adds `teamId` from `projectSlack(db, card.projectId)`.
  - `recipientsOf(db, card, teamId)` answers null when `teamId` is null or a recipient has no contact in it
    (`contactIn`), so the card stays the builder's with Copy for, as today for anyone unreachable.
  - `draftFor` passes `teamId` to `insertDraft`. `sweepDrafts` compares recipients the same way.
- **Sends.** `apps/daemon/src/stakeholders/sends.ts`:
  - **Deps.** `slack: SlackClients | null`; `hasToken(teamId)`; `slackFor` answers the team id or null and is
    required. Every Slack call takes `slack.clientFor(send.teamId)`. A null client (the team signed out) is the
    "Slack is not connected" 409 at Send, and leaves a reserved send waiting, as `no_token` does today.
  - **`afterDraft` and `send`.**
    - The project's team now is compared with `draft.teamId`. Null: hold `slack_off`, or the 409, as today.
    - A different team: drop the draft and ask the card again of the same people (the `askSomeone` path without
      `always`). That yields a draft in the new team, or Copy for.
    - Holds read the recipient's contact in the send's team: `sendMode`, `dailyLimit`,
      `everSent(db, personId, teamId)` and `newThreadsSince(db, personId, teamId, since)`.
    - `latestThreadFor` takes the team.
  - **The builder's name.** A builder still named `SEED_BUILDER_NAME` holds a draft for `review`, as today, but
    `send` no longer refuses it: remove the "Pick yourself in Settings › Integrations" 409.
  - **`channelFor`.** Reads the recipient's contact in the send's team and records the DM channel with
    `setDmChannel(ctx, personId, teamId, channel)`. A group DM opens from those contacts' user ids.
  - **`continueSending`, `recoverSending(teamId)`, `closeAndSay`.**
    - Each uses the send's own client.
    - A send whose team is no longer its project's fails `workspace_changed` through `failSendsToBuilder`; a
      post already found by its metadata is recorded first. Normally `rebind` has already done this.
    - `recoverSending` runs only the team's `sendingSends(db, teamId)`.
  - **`rebind(projectId)`.** Runs from `setProjectIntegrations` after the binding's write. The binding change
    and the returns are one write; the re-asks follow it.
    - The project's sending and sent sends in another team (or any team, when Off) fail `workspace_changed`.
    - Its drafts in another team are dropped and asked again; when Off they stay, held `slack_off`.
    - Its open question cards that carry Copy for and have no live send are asked again of those people when
      the new binding is a workspace.
- **Services.** `apps/daemon/src/daemon/stakeholder-services.ts`: `setProjectIntegrations` writes the binding,
  then `await sends.rebind(projectId)` when the team changed. Its doc comment in `api/services.ts` says so.
- **Wiring.** `apps/daemon/src/daemon/start.ts`: `createStakeholderSends({ slack: slackClients, hasToken: (teamId)
  => …, slackFor: (projectId) => projectSlack(state.db, projectId).teamId, … })`. Remove card 1's and card 2's
  bridges in this area. `apps/daemon/test/engine.ts` and `routed-wait.test.ts` follow: a fake engine with Slack
  binds its project to the fake team.
- **Docs.** `apps/daemon/src/stakeholders/AGENTS.md` (card 2 made it): drafts come from the project's
  workspace; rebind; the name hold.

## Interfaces it implements

Quoted from the index, exactly:

```ts
export interface SendsDeps {
  readonly state: StateStore;
  readonly slack: SlackClients | null;
  readonly clock: Clock;
  readonly log: Logger;
  readonly parkFor?: (id: InboxItemId) => void;
  readonly hasToken?: (teamId: string) => Promise<boolean>;
  readonly slackFor: (projectId: ProjectId) => string | null;
}
export interface StakeholderSends {
  afterDraft(cardId: InboxItemId): Promise<void>;
  send(cardId: InboxItemId, input: SendInput): Promise<StakeholderSendDto>;
  askSomeone(cardId: InboxItemId, input: AskSomeoneInput): void;
  takeBack(cardId: InboxItemId): Promise<void>;
  keepWaiting(cardId: InboxItemId): void;
  recoverSending(teamId: string): Promise<void>;
  closingTextFor(cardId: InboxItemId): string | null;
  onCardChanged(card: InboxItemDto): Promise<void>;
  rebind(projectId: ProjectId): Promise<void>;
}
// draftContext gains teamId: Pick<DraftDeps, 'projectName' | 'goalTitle' | 'builderName' | 'teamId'>
// DraftDeps gains: readonly teamId: string | null;
```

It calls `SlackClients.clientFor`, `failSendsToBuilder` (card 2), `contactIn`, `insertDraft`, `everSent`,
`newThreadsSince`, `latestThreadFor`, `sendingSends`, `liveSendsWhere` and `setDmChannel` (card 1).

## State-table rows

- Off (no setting, null, signed out) / routed to Mark → no draft, Copy for.
- bound to A / Mark with an A contact → draft in A, his A contact's mode and limit.
- bound to A / Priya with only B → no draft, Copy for.
- bound to A / Mark (A) and Priya (B only) → whole card the builder's, Copy for both.
- bound to A, Mark's limit reached in B → counted against A only.
- bound to A, Mark never sent to in A → reviewed first.
- builder still "You" → held for review; Send works.
- a send reserved in A → every call with A's client; DM channel from the A contact.
- a send mid-post in A / restart → `recoverSending(A)` finds or posts it.
- bound to A, draft in A / bound to B → dropped, asked again.
- bound to A, sending or sent in A / bound to B or Off → fail `workspace_changed`, in the binding's write.
- bound to A, Copy For cards / bound to B → asked again.
- bound to A, draft in A / Off → stays, held `slack_off`.

## Tests

Core: this guards which workspace a question reaches. One new file,
`apps/daemon/src/stakeholders/workspace-sends.test.ts`, on the real rung:
- a real store (`createTestStore`) and the real `createStakeholderSends`;
- `createSlackClients` over a memory Keychain with `xoxb-a` and `xoxb-b`, and a fake `fetch` that records each
  call's method, bearer token, `users` or `channel`, and answers `conversations.open`, `chat.postMessage` and
  `chat.getPermalink`.

Mark has a contact in A (`UA`) and B (`UB`); Priya has one in B only. Projects: P1 bound to A, P2 bound to B, P3
with no setting. Each row seeds a routed card with card 1's stores, then runs the sends as the daemon would:
- Mark in P1: one post, every call with `xoxb-a` and `UA`; the send's `teamId` is A. Mark in P2: `xoxb-b`, `UB`.
- Mark in P3: no draft, no call, the card's Copy for names Mark.
- Priya in P1: no draft, no call, Copy for Priya.
- Mark at his daily limit in B, never sent to in A: a P1 card for him is held `first_send`, not `limit`.
- P1 bound to B while Mark's P1 send is sent: it fails `workspace_changed`, its card is the builder's, and no
  call is made.
- P1's draft for Mark, then P1 bound to B: the next send posts with `xoxb-b` and `UB`.

Prove it red first: with `recipientsOf` reading Mark's first contact instead of his contact in the project's
workspace, the P2 and Priya rows fail. Value card:
`protects=a project's question reaches only its own workspace, through its contact there; fails_when=a send uses
another team's token or contact, or a moved project keeps sending in the old workspace; why_new=data going out
(core); no_claim=Slack's delivery, reply reading`.

## Done when

The checks in Global Constraints pass. `grep -rn "TODO(slack-workspaces)" apps/daemon` finds nothing.
