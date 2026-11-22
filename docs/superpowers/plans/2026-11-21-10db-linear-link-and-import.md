# Plan: Linear binding, task link and import

**Size:** Feature (10db's Standard), with one Core card first: card 1
(`2026-11-21-10db-linear-link-and-import/task-1.md`, permissions) sends a chat's or Plan's call to an MCP tool to
the judge, as a lane's goes. The Feature: one migration (four nullable `tasks` columns and a unique index), one
`app_settings` key, one 10db MCP tool, a Settings card, a button, a Plan panel row and a task link. One implementer
end to end; one review after a click-through; extend the New Plan e2e.
**Spec:** `docs/superpowers/specs/2026-11-21-10db-linear-integration-design.md`: "Sign-ins and bindings" (the
Linear binding check), "Provider parity", "Import", "Data" (the `tasks` columns only), "Sizes" item 2. The
reporter (part 3, Core) and `linear_posts` are not in this plan.

## Brief

**What changes for you.**
- **Project › Integrations gets a Linear card.** Type a team key (AMP) and press Link. 10db opens a short session
  on the project's account; it asks Linear which workspace your sign-in reaches and finds the team. The card then
  shows the workspace and the team.
  - A team your sign-in can't see is refused, naming the workspace it does reach.
  - Unlink clears the binding.
- **A linked project has From Linear beside New Plan.** It opens a Plan session whose brief names the team. You
  ask for issues ("the ready AMP ones"), and the agent drafts each one as a task carrying its Linear link. A
  "blocks" relation between two imported issues becomes `dependsOn`.
- **Accept puts the drafts on the Board with their links.** An issue that is already on the Board is skipped, and
  its row points at the existing card.
- **"import AMP-120" works in any session**, through `create_task`.
- **Cards and drawers show the Linear id as a link.**

**What it buys.** You no longer copy issues by hand, and the link alone ends duplicate imports.

**What could go wrong, and how we'd know.**
- **Linear's calls in a chat or Plan session were carded one by one.** You chose "Judge, like lanes": card 1 sends
  those calls to the project's judge (10db's judge or auto mode), as a lane's go, so reads run and a risky write
  is carded. With no judge they are still carded, and one answer can allow the whole server. A wrong judge call
  would show as a Linear write that ran unasked; the judge's verdicts are in the session's log.
- **The binding points at the wrong workspace.** The binding stores the workspace and team ids that the session
  read through your sign-in. Part 3 checks them again before each write.

**Calls you might disagree with.**
- **The binding check is a visible session**, titled "Link Linear team AMP", not a hidden one.
  - It uses the session machinery that already runs on every provider, and you can read what it did.
  - It is archived once it links.
  - Cost if wrong: one more kind of session to hide later.
- **The "How to update Linear" note and the reporter switch wait for part 3.** Nothing reads them before part 3,
  and a switch that does nothing would mislead you.

**Needed from you:** nothing. Screenshots of the Linear card and a linked Plan row come before the merge, and the PR
merges unless you say stop.

## Provider parity

The binding check and the import are sessions on the project's account, so they reach Linear the way that
account's sessions do:
- **Claude plan:** the claude.ai connector, or an `mcp.linear.app` entry.
- **Claude API key or Bedrock:** the entry.
- **Codex:** its `codex mcp add` entry.

When the project's account has no Linear (`LinearVia.None` in `GET /settings/sign-ins/linear`), the card and
From Linear show that row's hint line in place of Link and the session.

## Parts

0. **Card 1 (Core):** the judge rule above, its decision and its one test. Reviewed on its own before the rest.
1. **Data (db, contracts).**
   - `tasks` gains `external_kind`, `external_id` (AMP-119), `external_issue_id` (Linear's id) and
     `external_url`, all nullable, with a unique index on `(project_id, external_kind, external_id)`. The
     migration is generated last, after the final merge of `main` (`packages/db/AGENTS.md`).
   - Contracts:
     - `ExternalKind` (`as const`, `Linear: 'linear'`) and `ExternalLink { kind, id, issueId, url }`.
     - The link is optional on `TaskInput` (`entities.ts:820`) and on the plan's task drafts (loose tasks, goal
       tasks, additions, in `shape.ts`).
     - `external: ExternalLink | null` on the task DTO.
     - `LinearBinding { workspaceId, workspaceName, teamId, teamKey, teamName }` is stored at `app_settings` key
       `linear.${projectId}`, in the `trust.${projectId}` pattern.
2. **Link rules (daemon).**
   - `create_task`, and every other writer of `TaskInput`, refuses an issue already linked in the project and
     names the existing task.
   - Convert (`shape/convert.ts` `convertProposals`) skips a draft whose issue is already linked. The draft's
     proposal records the existing task as what Convert made of it, so the view links the card, and the rest of
     the Accept goes ahead.
   - Undo Accept removes only the tasks the Accept made; their links go with the rows.
3. **Binding (daemon, desktop).**
   - `GET /projects/:id/integrations` adds `linear: LinearBinding | null` plus the check in flight, if any.
   - `POST /projects/:id/integrations/linear/check { teamKey }` opens a chat on the project's account. Its opening
     message tells the agent to read the workspace with Linear's tools, look the team up, and call 10db's
     `link_linear_team` with `{ workspace, team | null }`.
   - The tool writes the binding only for the check that project has in flight (held in memory, one at a time),
     then archives the chat. With `team: null` it records the refusal, naming the reached workspace.
   - `DELETE /projects/:id/integrations/linear` unlinks.
   - The card in `project-integrations-section.tsx` has these states: signed out (the hint), unlinked (the key
     and Link), checking (a link to the session), linked (workspace, team, Unlink) and refused (the reason, Link
     again).
4. **Import (daemon, desktop).**
   - From Linear shows only for a linked project. It opens a Plan session (`POST /chats` with `plan: true`)
     whose opening brief names the workspace and team, the `10db-task` drafting rules, the link on each draft
     and blocks→`dependsOn`.
   - A Plan row with a link shows its Linear id; a skipped row says "Already on the Board" and links the card.
   - The task card and drawer show the id as a link, opened outside the app the way other links are.
5. **Fake script and e2e.**
   - `sessions/fake-plan-script.ts`: a message containing "linear" proposes one loose task linked to `AMP-1`.
   - Extend the New Plan test (`apps/desktop/e2e/sessions.spec.ts:581`): Accept a linked draft and the card
     shows AMP-1; propose it again, Accept, and the row points at the existing card while the Board has one
     AMP-1.

## Tests

- **E2e:** the extension in part 5.
- **One unit test in `shape/convert`, on real SQLite:** an Accept with one already-linked draft and one new one
  writes only the new task and points the skipped row at the existing card.
- **One test of the unique index refusal through `create_task`**, if it is cheap on the same fixture.
- No component tests, and no test of the binding check.
- **The binding check is run live instead.** The implementer runs it once on a real account and reports what it
  saw (the project's Linear sign-in, team AMP). If no real account is reachable from the worktree, the report
  says so.
