# Plan: Settings › This Project › Trust, one place for what lanes get

**Size:** Feature overall. Part 1's write is a permission (approving a repo MCP server), so it gets one core test
and the review checks it as Core; it reuses the store write the Inbox card already makes. Parts 2 and 3 are
Feature.

## Brief

**What changes for you.** This Project › Trust becomes the one place that says what a lane gets:
1. **The repo's MCP servers** (the checkout's `.mcp.json`) get their own card, with each server's state (On, Off,
   Waiting) and the same On/Off control your own servers have. Turning one On shows what the approval card shows
   (what it runs, the hosts it reaches, what it reads) and asks you to confirm. If the server has a waiting
   approval card in the Inbox, your choice answers that card.
2. **"Live Systems" becomes "Production".** The copy says lanes may read these places, and 10db's judge refuses
   any write to them. 10db proposes entries from the repo (vercel.json, `*_PROD*` names and production URLs in
   `.env.example`, prod compose files, deploy workflows, cloud profiles named prod), each with where it came
   from, added with one click.
3. **"What Comes Along" and "Comes Along / Left Out" become one list.** Each switch shows the items it brings
   under it. Left Out keeps what you would expect to see; duplicates and 10db's own skill fold into one quiet
   line ("3 more left out as expected · Show").

**What it buys.** One page answers "what will a lane have, and what can it touch?" A repo server no longer hides
behind an Inbox card you dismissed.

**What could go wrong, and how we'd know.**
- Approving from Settings approves a config you didn't read. The On confirm shows the card's own text for the
  current config, and the approval is recorded for that config's hash only. A changed `.mcp.json` asks again, as
  today.
- A proposal is wrong (a staging host). Nothing is added without your click, and each shows its source line.
- An item lands under the wrong switch. Each item carries the switch that brought it, set where it is produced.

**Calls you might disagree with.**
- "Production" lists stay text the judge reads. Nothing new blocks at the sandbox. The copy says "the judge
  refuses", not "blocked".
- Turning a repo server Off records a deny (the same as Deny on the card). Default/As-app doesn't exist for repo
  servers: they are approved per project already.
- Proposals live in the Production card itself, not in Review Suggestions' modal. That modal edits project fields,
  and Production is a trust setting.

**What is needed from you.** Nothing.

## Provider parity

Repo MCP servers, Production and the preview are already provider-neutral: Claude and Codex sessions both read
approvals, the trust policy text and the setup plan. The preview keeps Codex's "(its skills only)" plugin wording.

## Parts

**1. Repo MCP servers.**
- Contracts: `RepoMcpServerDto` = `McpServerReview` + `verdict: 'approved' | 'denied' | 'pending'` + `inboxId` +
  `body` (the approval card's text, from `approvalBody`). `GET /projects/:id/repo-mcp-servers` lists them with no
  side effect (unlike `POST …/mcp-servers/review`, which raises cards). An unreadable `.mcp.json` returns the
  error text, shown in the card.
- `PUT /projects/:id/repo-mcp-servers/:name` body `{ configHash, verdict }`. The service re-reads `.mcp.json`;
  if the hash is no longer current it refuses (409, "the config changed; look again"). If an open approval card
  exists for that fold key, it answers the card through `InboxService` (so `applyMcpApproval` writes and the card
  closes). Otherwise it calls `recordMcpApproval` with the current review's `variables`/`hosts` (empty for a
  deny) and `sourceInboxId: null`, in one write.
- Desktop: a "Repo MCP Servers" card under the switches, one row per server: name, transport, state, On/Off.
  On opens a confirm modal with `body`; Off writes at once.
- Test (core, permissions): one daemon test on a real SQLite file and a temp checkout. It approves from Settings
  while a card is open; the card closes and `getMcpApproval` returns approved for that hash. A stale hash is
  refused.

**2. Production.**
- Rename in the desktop only (the setting key and route stay). New copy in `trust-rows.ts`.
- `proposeProduction(git, repoPath)` in `apps/daemon/src/trust/propose-production.ts`. It pins a commit as
  `suggestSettings` does, reads a capped set of files and returns `{ entry, source: { path, line } }[]`, minus
  entries already listed. Detectors: `vercel.json` (`alias`, domains), `.env.example`/`.env.*.example` (names
  containing `PROD` and https URLs in their values), `docker-compose.prod*.yml`/`compose.prod*.yml` (service image
  hosts), `.github/workflows/*.yml` jobs or environments named `production`/`prod` (their `url`), and AWS/GCP
  profile names containing `prod` in repo config. `GET /projects/:id/live-systems/proposals`.
- Desktop: under the input, "10db found these in the repo" with each entry, its source and Add. Add writes
  through the existing `useSetLiveSystems`.
- No unit test (not core). The e2e covers one proposal.

**3. One list.**
- Contracts: `SetupPreviewDto` items gain `from: TrustSwitchKey | null` and `expected: boolean`. `skills` and
  `plugins` become `loaded: { what, from }[]`; `leftOut` keeps `{ what, why, from, expected }`.
- Daemon: each producer tags its items (`builder-skills.ts` → `yourSkills`, `project-definitions.ts` →
  `projectSkills`, instructions → `projectInstructions`/`yourInstructions`, the plugin list → `yourPlugins`,
  the sandbox judge's items by the input they came from). `expected` is true for the duplicate-name and 10db-skill
  reasons only.
- Desktop: each switch row lists its loaded items and unexpected left-out items under it (folded past 5). One quiet
  line at the end counts the expected ones, with Show. Items with `from: null` sit in a last "Other" group.

**E2E.** No Trust spec exists. Add one short flow, `apps/desktop/e2e/project-trust.spec.ts`: open This Project ›
Trust, see a switch's items under it, add one Production proposal from a fixture repo with a `vercel.json`, and see
a repo MCP server from the fixture's `.mcp.json` as Waiting, turn it On through the confirm, and see On.

**Notes.** `apps/desktop/src/views/settings/AGENTS.md` is at its word budget: Trust's notes go in a new
`apps/desktop/src/views/settings/trust/AGENTS.md` (move the existing Trust section there).
