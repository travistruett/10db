# 10db: Linear issues in, results back

**Status:** designed on 2026-11-21; nothing is built. **Builds on** the OAuth MCP servers plan
(`docs/superpowers/plans/2026-11-14-10db-oauth-mcp-servers.md`), Plan in Sessions
(`2026-11-19-10db-plan-in-sessions-design.md`) and the implementation report on steps (PR #729, #732).
**Evidence:** the manual Ampsio AMP-119 pilot, run by Codex on 2026-11-21.

**Amended 2026-11-22:** a project is no longer linked to a Linear team, so the "Linear binding check" and the
Linear row's team link below are removed. A project uses its account's Linear sign-in
(`docs/architecture/decisions/2026-11-22-linear-needs-no-link.md`). The rest of the text is as written.

## Brief

**What changes for you.** A project can be linked to a Linear team. You pull issues into 10db from a session
("bring in my AMP issues that are ready"). The agent finds them, drafts each as a task with its Linear link, and
Accept puts them on the Board. Importing an issue that is already linked points at the existing card. As the
task runs, 10db keeps the Linear issue current without you touching it:
- **Status moves:** In Progress when a run starts, In Review or Ready for Release when the work earns it.
- **One "10db" attachment** shows the live state and links the PR or the card.
- **One comment per milestone** gives the attempt, the evidence, the blocker or the open findings, with
  screenshots when the task took any.

An agent does the Linear side through Linear's own MCP, so there is no status mapping to maintain. It reads
the team's real statuses each time. An optional **"How to update Linear" note** per project tells it your
conventions, for example "Ready for Release means on main; never set Live".

**Settings change shape: sign-ins and bindings.**
- **All Projects** lists your **sign-ins**: who you are at each service. A service can have several (two Slack
  workspaces), and one can serve any number of projects.
- **Each project** has an **Integrations** section of **bindings**: which sign-in it uses and where its output
  goes (Linear team, Slack workspace).
- Artificial Analysis stays All Projects only; nothing about it differs per project. OpenRouter is an account,
  so it stays in Accounts.
- GitHub stays one sign-in (`gh`'s active login); the project card shows which. A per-project GitHub account is
  later, if ever.

**What it buys.** Linear stays where the work is planned, and 10db stays where it runs, with no copying
between them. The pilot's hand steps are gone: importing a card, writing the verification comment and moving
the status.

**What could go wrong, and how we'd know.**
- **It posts to the wrong place.** Your Linear sign-in belongs to your agent, not to a project, and team keys
  repeat across workspaces. We saw it: this session's connector could not see AMP-119. The binding stores the
  workspace and team ids, checked when you bind. Each reporter run must show it sees that workspace before
  it may write, and it may write only to its task's linked issue. Anything else is refused and one Inbox item
  names it.
- **It claims more than the evidence holds.** The AMP-119 card reached Done while its tests had read stale
  container source. The reporter gets 10db's recorded facts (reports, verdicts, evidence and its gaps,
  skipped checks), never only the card's state. A finding left open, or a check that never ran, keeps the
  issue out of Ready for Release, and the comment says what is unverified.
- **It repeats itself or undoes you.** Every event is queued durably and each comment carries a short
  `10db · <event> · attempt N` footer, so a run that posted but crashed before recording is recognized and not
  repeated. The reporter updates its one attachment in place, never moves a status backward, and only comments
  if you moved the issue yourself. Being an agent, it can still word things oddly. That is the accepted cost of
  not maintaining mappings.
- **It leaks a secret.** The guard scans every Linear write for secrets (keys, tokens, credential
  assignments) and refuses a hit; that update is withheld and named in the Inbox. Screenshots are not
  scanned.
- **Linear goes quiet.** If a reporter run fails for any reason, it retries with backoff, and after five tries
  the update is marked failed. One Inbox item per project stays open with a count of the updates waiting,
  failed or withheld, and closes when nothing is left. The task is never held.

**Calls you might disagree with.**
1. **Agent-driven, not mapped.** **Decided** by the builder: start intelligent, a little non-deterministic.
   If statuses prove unreliable, a learned mapping can be saved from the reporter's own choices later.
2. **Done in 10db never sets Linear's completed type** by default. Live belongs to a verified deploy or to
   Linear's GitHub integration.
3. **Importing happens in a session, not through a search box.** It reuses Plan in Sessions, so drafts
   are reviewed before they reach the Board. A search box is a later addition if sessions prove slow.
4. **10db holds no Linear key in v1.** It uses your agent's Linear MCP sign-in. Two costs: nothing posts while
   no agent can run, and one agent account reaches one Linear workspace, so two projects on the same account
   can't bind to teams in different workspaces yet (a follow-up closes it).
5. **Signing in to several Slack workspaces is built when you have a second one.** Part 1 stores the
   workspace in each binding, so nothing is redone then.

**What is needed from you.** Nothing to approve this brief. Before the reporter's first live run, link one
project (Ampsio to team AMP), write a note if you want one, and sign your agent in to the right workspace.

---

## Sign-ins and bindings

A **sign-in** is an identity at a service, kept app-wide. A service can hold a list of them. A **binding** is
per project: which sign-in the project uses, plus the resource at that service. One sign-in serving several
projects and one per project both fall out of this.

| | Sign-in (All Projects) | Binding (this project's Integrations) |
|---|---|---|
| **GitHub** | `gh`'s active login (built) | shows the login in use; delivery, PR pictures and title prefix stay under General |
| **Slack** | bot token per workspace, in the Keychain under the workspace's team id | the workspace's team id |
| **Linear** | the agent account's Linear MCP sign-in, shown per provider; no token kept by 10db | workspace id, team id and key; the "How to update Linear" note; reporter on or off |
| **Artificial Analysis** | sign-in only (built) | none |

- The All Projects section is renamed **Sign-ins** (key `sign-ins`), with `integrations` in
  `RETIRED_SECTIONS` (`apps/desktop/src/views/settings/sections.ts:97`) pointing at it. The project section
  takes the key `integrations`.
- Bindings are `app_settings` keys `linear.${projectId}` and `slack.${projectId}`, the pattern
  `trust.${projectId}` uses (`apps/daemon/src/permissions/trust-switches.ts`). zod schemas live in
  `packages/contracts`.
- A project with no binding doesn't use that service. Slack sends from a project with no Slack binding stay in
  the Inbox, as they do today with Slack off.
- While there is exactly one Slack sign-in, every project, new ones included, is bound to it unless the builder
  turns that off, so adding a project never quietly drops Slack.
- Who Answers stays where it is (Project › Planning). Slack's sends still go to people's DMs; there is no
  project channel.
- **Slack in part 1:** today there is one token (`slack-bot`, `apps/daemon/src/environment/keychain.ts:16`) and
  one connection state (`apps/daemon/src/stakeholders/slack-connection.ts`). Part 1 moves the token to an entry
  keyed by its team id (writing the new entry before removing the old one). Signing in to a second
  workspace, and a contact who answers in two (`person_contacts.person_id` is unique,
  `packages/db/src/schema.ts:1085`), wait for a second workspace.
- **GitHub later:** `gh` holds several accounts and gives the token for a named one
  (`gh auth token --user <name>`), so a per-project account needs no new sign-in when it comes.
- **Linear binding check:** binding a team starts a short session that asks Linear which workspace the sign-in
  reaches and looks up the team; the binding saves both ids. A team in another workspace than the sign-in
  reaches is refused, naming the workspace it does reach.

## Provider parity

The Linear side runs through MCP. Connectors from claude.ai exist only on a Claude plan
(`docs/superpowers/plans/2026-11-14-10db-oauth-mcp-servers.md:44`, `:80-83`); elsewhere Linear is a server
entry the builder configures.

| Account | Linear reached through | Tools look like | Signed out: the card says |
|---|---|---|---|
| Claude plan | the claude.ai Linear connector, or an `mcp.linear.app` entry in Claude Code's config | `mcp__claude_ai_Linear__*` or `mcp__<entry>__*` | "Sign in to Linear in Claude Code: `/mcp`." |
| Claude API key or Bedrock | an `mcp.linear.app` entry in Claude Code's config, signed in with `/mcp` | `mcp__<entry>__*` | "Add Linear's server to Claude Code, then `/mcp`." |
| ChatGPT/Codex plan | `codex mcp add` for `mcp.linear.app` | the entry's tools | With no entry: "Add Linear's server to Codex (codex mcp add linear --url https://mcp.linear.app/mcp), then sign in to it under Settings › Trust › Your MCP Servers." With one not signed in: "Sign in to Linear under Settings › Trust › Your MCP Servers." |

- The guard knows a tool is Linear's by its server: the claude.ai connector by name, a configured entry by its
  URL's host, `mcp.linear.app`. The plan confirms how each provider names them.
- The reporter needs the builder's Linear entry, so the Trust switch **Your MCP servers** off
  (`apps/daemon/src/permissions/trust-switches.ts:64`) turns the reporter off, and the binding card says so.
- The **From Linear** button on a signed-out account shows the same line as the card instead of starting a
  session.

## Import

- Linked projects get a **From Linear** button that starts a session with the Plan panel open, its brief
  naming the bound team.
- The agent searches with Linear's MCP and proposes tasks. Each draft follows the `10db-task` skill's rules:
  an outcome title, why, criteria and areas. A Linear "blocks" relation between two imported issues becomes
  `dependsOn`.
- A proposal's task carries the link. Accept writes it with the task (`apps/daemon/src/shape/convert.ts:248`).
  A draft whose issue is already linked is skipped at Accept, and its row points at the existing card; the rest
  of the Accept goes ahead.
- `create_task` and `TaskInput` (`packages/contracts/src/entities.ts:820`) accept the link too, with the same
  rule, so "import AMP-120" in any session works.
- Undo Accept removes the tasks and their links. A task's `linear_posts` rows are deleted with it.
- The card shows the Linear id as a link.

## Reporter

### When

- **Events** on a linked task: a run starts; a step ends blocked, waiting or skipped (an Inbox item); a review
  verdict lands; the workstream reaches DONE, FAILED or CANCELLED; a PR opens or merges.
- Each event is written at once as a pending `linear_posts` row, so a daemon restart loses none: on startup,
  pending rows are picked up again, as `delivery/trigger.ts` does for deliveries.
- One reporter runs per task. It starts 30 s after the first pending event (the clock is injected) and takes
  every pending row for that task. Events arriving while it runs stay pending for the next run.

### States

| State | Event | Next |
|---|---|---|
| idle | event on a linked task | pending (row written) |
| pending | 30 s pass, no reporter running for the task | running (takes all pending rows) |
| running | new event | running; the new row stays pending |
| running | reporter records its rows | idle, or pending if rows arrived meanwhile |
| running | the daemon stops | pending: retried on startup; posts already made are found by their footer |
| running | any failure: session ends without recording, workspace check fails, Linear unreachable | pending with backoff (5 min, doubling to 6 h); the project's one Inbox item is opened or its count raised |
| pending | its fifth failed run | failed: shown on the card's Linear tab and counted in the Inbox item; a later event on the task starts fresh |
| running | the scan refuses a write | that row recorded as withheld, with the pattern's name, and counted in the Inbox item |
| any | task unlinked, binding removed or reporter turned off | pending rows dropped; a running reporter's later writes are refused |
| any | task deleted | its rows are deleted |
| any | the project has no pending, failed or withheld rows left, or the builder dismisses them | the Inbox item closes |

### What it is handed

- The task and its link, the project's note, and this task's recorded rows.
- The attempt's implementation report, every review verdict and open finding.
- The evidence (gate commands, exit codes, commits) and what is missing from it (skipped checks, refused
  commands, a gate that did not run).
- The PR URL, and the task's screenshots as files.

### What it may do

- Read anything Linear's MCP shows it.
- Write only to its task's linked issue: comment, set status, create or update the one attachment, upload
  files. Then record each row through a 10db tool, `report_linear_post` (event ids, comment ids, the status
  set, the attachment URL).
- Each comment ends with `10db · <event> · attempt N · <event id>`. Before writing, the reporter reads the
  issue's comments; an event whose id already appears is recorded without posting again. It finds its
  attachment by its URL on the linked issue, so one created but never recorded is updated, not duplicated.

### Where it runs

- A short session of 10db's own, outside any lane, with no repository write access, on the Efficient tier of
  the project's account. It loads 10db's tools and the account's Linear server only: it is 10db's own errand,
  not the builder's work, and every other server is a way for task data to leave.
- The first thing it does is report through `report_linear_workspace` the workspace and team it sees. Until
  that matches the binding, the guard refuses every Linear write. This guards against an account signed in to
  the wrong workspace, not a misbehaving agent; the plan reads the workspace from the Linear tool's own result
  if the provider's hooks expose it.
- After that, the guard allows a Linear write only when its issue is the linked identifier or the issue id
  saved with the link, or its comment or attachment id is one this task's rows recorded. Everything else is
  refused. The reason is a hard limit: sending data out to somewhere the builder didn't choose
  (`docs/architecture/decisions/2026-11-12-10db-trusts-the-developer-and-contains-the-agent.md`). Allowed
  writes need no judge; the builder chose this issue by linking it.
- The guard scans every Linear write's text fields (body, title, subtitle, description) with the outbound
  scan's secret patterns only. The URL, code-fence and file-path patterns of
  `apps/daemon/src/stakeholders/outbound-scan.ts` are left out: the reporter posts links and commands by
  design. A hit refuses that call and names the pattern; the reporter records the row as withheld and the run
  goes on. Uploaded screenshots are not scanned.

### Rules in its brief

- Read the team's statuses with their types and positions; never move to an earlier position or a lower type.
- If a person changed the status since the last recorded row, comment only.
- No completed-type status unless the note says so.
- Open findings and unverified checks are named in the comment and block Ready for Release.

## Data

- `tasks`: `external_kind`, `external_id`, `external_issue_id` (Linear's id) and `external_url`, all nullable,
  with a unique index on `(project_id, external_kind, external_id)`.
- `linear_posts`: id, task, event kind, attempt, state (pending, recorded, withheld or failed), tries, session, comment ids, the status
  set, the attachment URL, created and recorded at. This is the reporter's queue and log, and the card's
  Linear tab reads it.
- Bindings in `app_settings`, so no table for them.
- One migration, generated last on its branch (`packages/db/AGENTS.md`).

## Sizes

1. **Sign-ins and bindings in Settings; the Slack token keyed by workspace.** Feature. It moves one Keychain
   entry and writes bindings; it adds no table.
2. **Linear binding, task link and import.** Feature. It extends the Plan in Sessions Accept e2e flow with a
   linked draft and a second Accept of the same issue.
3. **Reporter.** Core: it sends data out and adds a guard rule. Its plan is an index plus cards.

Each part ships on its own. Part 2 is useful without part 3: the link alone ends duplicate imports.

## Not in this version

- Linear's agent API: delegating an issue to "10db", with progress shown as an agent session. It needs a
  public HTTPS webhook answered within 5 to 10 s, which a local Mac doesn't have.
- Auto-import by label or status.
- A 10db-held Linear key: for writes while no agent runs, and for two Linear workspaces on one account.
- Several Slack workspaces signed in at once, and a per-project GitHub account.
- Sentry.
