# Plan: sign-ins and bindings, Slack by workspace

**Size:** Feature (10db's Standard): settings sections, two `app_settings` keys, one Keychain entry moved. No
migration, no new table. One implementer end to end; one review after a click-through; extend one e2e.
**Spec:** `docs/superpowers/specs/2026-11-21-10db-accounts-harnesses-and-sign-ins-design.md` "Sign-ins and
bindings" (part 4), which applies `2026-11-21-10db-linear-integration-design.md` "Sign-ins and bindings" (its
part 1). Runs beside the Core plan `2026-11-21-10db-accounts-harnesses.md`, which owns Accounts, Billing and
Decisions; this plan touches none of those.

## Brief

**What changes for you.** Settings › All Projects › Integrations becomes **Sign-ins**: GitHub (`gh`'s login),
Slack (one card per signed-in workspace, named by its workspace), Artificial Analysis, and Linear per account (how
each account reaches Linear, or the line saying how to set it up). Each project gets an **Integrations** section:
the GitHub login it uses, and its Slack workspace (bound automatically while there is exactly one; you can turn
it off). A project with Slack off keeps its sends in the Inbox. Your Slack token is deleted once; paste it again
and it is stored under its workspace.

**What could go wrong.** Sends silently stop for a project: the auto-binding covers every project, new ones
included, while there is one workspace, and an unbound project's send says "Slack is off for this project" in the
Inbox. A stale link to `/settings/integrations` lands on the project section: it redirects to Sign-ins.

**Calls you might disagree with.** Linear's binding (team, note, reporter) is not in this cut; it comes with
Linear's part 2 and its binding check. Here Linear appears only as a sign-in.

**Needed from you:** paste the Slack bot token again after this lands. Screenshots of the new layout before merge.

## Parts

1. **Slack token by workspace (daemon).** The token is stored under Keychain account `slack-bot:<teamId>` (team id
   from `authTest()`, `stakeholder-services.ts:44-60`), written then read back, before anything else changes.
   Every reader (`start.ts:956`, `:966`) reads the signed-in workspace's entry; the workspace's team id and name
   are kept in `app_settings` key `slack.workspaces` (zod schema in `packages/contracts/src/slack.ts`; a list, one
   entry now). At startup the old `slack-bot` item and every `person_contacts` row whose `team_id` isn't a
   signed-in workspace are deleted (today: no rows). Disconnect removes the entry and the workspace.
2. **Bindings (daemon + contracts).** `app_settings` keys `slack.${projectId}` = `{ teamId: string | null }`, the
   `trust.${projectId}` pattern (`permissions/trust-switches.ts:138-153`), zod in contracts. Absent key: bound to
   the one workspace while exactly one exists; `teamId: null` is the builder's "off". Routes
   `GET/PUT /projects/:projectId/integrations` returning `{ github: { login }, slack: { teamId, teamName,
   auto: boolean } }`. Sends from a project with no binding stay in the Inbox (`stakeholders/sends.ts:68`, `:305`)
   with "Slack is off for this project". The reply watch is unchanged (one workspace).
3. **Linear per account (daemon, read only).** `GET /settings/sign-ins/linear`: one row per live agent account:
   `via: 'connector' | 'server' | 'none'`, the server's sign-in state when `server`, and the hint line from the
   Linear spec's Provider parity table when `none`. A Claude plan reads its claude.ai connectors from the
   connector directory (`sessions/claude-connectors.ts`; a connector named Linear); a Codex account its
   `mcp.linear.app` entry from `accounts/mcp-sign-ins.ts`; a Claude API key or Bedrock account the builder's
   configured server whose URL host is `mcp.linear.app`. Cached answers only; it never starts a probe session on a
   Settings visit if the directory has none (says "not checked yet").
4. **Desktop.** `sections.ts`: key `sign-ins` (All Projects, label Sign-ins, subhead Connections) replaces
   `integrations` there; `integrations` becomes a Project-scope section; `RETIRED_SECTIONS` maps the old
   app-scope address to `sign-ins`. The Sign-ins body reuses `github-card.tsx`, `slack-card.tsx` (titled by the
   workspace once signed in), `aa-card.tsx`, plus a Linear card listing the per-account rows. The project
   Integrations body shows the GitHub login and a Slack switch (on = the workspace's name). Copy that says
   "Settings › Integrations" for Slack (`views/inbox/send-failure.ts:10-15`, `overview-section.tsx:100`) points at
   Sign-ins. Update `apps/desktop/src/views/settings/AGENTS.md` (lines 17-30).

## Tests

- One test on a real temp Keychain-free path: the startup clean-up deletes the old item and contacts of no
  signed-in workspace, and a token is written under its team id and read back (core: it deletes data). Fake the
  Keychain (an injected dependency).
- Extend `apps/desktop/e2e/stakeholder-questions.spec.ts:89-93`: visit `/settings/sign-ins` (and assert the
  `/settings/integrations` redirect lands there), and one project's Integrations section shows the Slack line.
- No rendered-component tests.

## Done when

Typecheck, lint, related tests, the e2e above, `make check-changed`, a click-through against the real daemon
(`10db-dev-window` skill or the dev UI), and screenshots of All Projects › Sign-ins and Project › Integrations for
the builder (`screens` skill). Then a PR, auto-merge off until the builder has seen the screenshots.
