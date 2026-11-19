# Non-core unit tests: what was cut and what stays

One pass over the daemon and package unit tests outside core (dec_01a1efc1, dec_01a1f0ec): a test file stays only if it
is a real catch, guards security or secrets, is a pure rule table or parser, holds the inbox permission-broker blocks,
or is one seam test for a module no e2e flow reaches. Everything else is deleted. No test was written.

## Brief

- **What changes:** the scoped unit tests go from 8,182 to 1,224 in 677 files to 161 (table below); nothing in
  production changes except exports and modules that only deleted tests used.
- **What it buys:** less CI time and less test code to keep in step with each change; the e2e flows are the main check.
- **What could go wrong:** a deleted test was the only guard on a behavior. A broken e2e flow, or a bug a user hits,
  is how we'd know; that bug then gets one regression test.
- **Calls you might disagree with:** `apps/daemon/test/fixtures.test.ts` and `tests/repo/src/benchmarks-off.test.ts`
  stay, though the plan listed them for deletion: the first is the run `git-hook-variables.test.ts` depends on (test
  repositories ignore git hook variables), the second is the only check that test, e2e and dev daemons never read the
  builder's keys or message Slack or OpenRouter.
- **Needed from you:** nothing.

## Counts

Counted with `vitest list --json` per package, over the in-scope files only: core directories, migrations tests,
`git-guard.test.ts` and the seatbelt, live, process, pass, delivery, recovery and trust tests of `apps/daemon/test`
are left out of both columns. `vitest list` counts an `it.each` table as one test, so a run reports more tests than
this table (the kept `inbox.test.ts` runs 346 cases from its permission-broker tables).

| Area                             | Files before | Files after | Tests before | Tests after |
| -------------------------------- | -----------: | ----------: | -----------: | ----------: |
| apps/daemon/src (non-core)       |          441 |          78 |        5,665 |         762 |
| apps/daemon/test (non-core)      |           47 |          45 |          451 |         114 |
| packages/contracts               |           56 |           5 |          543 |          21 |
| packages/db (non-migration)      |           88 |           7 |        1,014 |          88 |
| packages/agent-skill             |            4 |           2 |           40 |          10 |
| tests/repo (excluding git-guard) |           41 |          24 |          469 |         229 |
| Total                            |          677 |         161 |        8,182 |       1,224 |

## What stays

- **Real catches:** `api/render-reads`, `session-setup/instructions`, `pictures/browser-host`,
  `pictures/playwright-camera`, and in `tests/repo` `model-names`, `ci` and `gate`.
- **Security and secrets:** the origin guard and app proxy, the Keychain and account-secret readers, login and
  session environments, the dev UI token, the outbound scan, blocked hosts, the Codex guard and lane permissions,
  judged denials, MCP approvals, shape permissions, the hook judge, chat and shape confinement and policy, the git
  refusal, sandbox roots, the instance lock, `sessions/open-in-root`, the OpenRouter key move, the judge, every
  `*.live.test.ts`, and at most 10 token, origin or refused-build tests each from `api/app`, `self-update` and
  `script-installer` (`github/login` had none and went).
- **Credential and token cases, cut out of files that otherwise went** (45 tests in 21 files, each with only the
  setup it uses): no account credential in a project, session, Plan or takeover environment
  (`environment/launch`, `daemon/shape-session-tools`, `sessions/claude-takeover`, `sessions/codex-takeover`,
  `takeover/render`); the pinned Claude and Codex binaries refused on a wrong checksum, changed files or loose
  permissions (`environment/pinned-install`); 10db's own skill kept out of a session
  (`session-setup/builder-skills`); what a render token may read (`screens/render-access`, whole); a repo's or
  the builder's MCP server given only the variables approved for it, with no secret shown or logged
  (`sessions/project-mcp`, `inbox/project-mcp-reader`, `session-setup/your-mcp-config`, `plugin-mcp`,
  `your-mcp-hash`, `your-mcp-dto`); the session token and secret files in a Codex session and its home
  (`sessions/codex-session`, `sessions/codex-home`); a gateway session that would bill a saved login
  (`sessions/claude-adapter`); a secret file refused by Commit (`chat/title-row-git`); registry hosts without
  their tokens (`registries/find-registry-hosts`); the bridge sending no token to an exited pid
  (`builder-bridge/bridge`); and the unattended permission broker (`inbox/unattended-broker`, whole). The macOS
  CI step runs `builder-skills` and `pinned-install` again.
- **Rule tables and parsers:** `routing/choose-model`, `env`, the Claude and Codex mappings and the Codex protocol.
- **Partial files:** `inbox.test.ts` keeps its six `permission broker` describes; `watcher.test.ts` keeps stray
  writes in `.git`, the real file-system watcher, and the out-of-bounds and refused-write tests.
- **One seam each** (the first test) for briefing, mcp, preview, priority, events, log, keep-awake, backups and
  agent-skill; the first two tests of each remaining `apps/daemon/test` API file. `knowledge-api` and
  `workbench-api` went, as the e2e flows cover them.
- **Packages:** contracts keeps glob-overlap, allowed-commands, sign-in-url, trust-policy and trust; db keeps the
  execution, pass-shared, task-hold, trust-grant, denied-permission and MCP-approval stores and `database.test.ts`;
  agent-skill keeps connection and skill-version.
- **tests/repo** keeps its rule tests, with `install-app`, `self-update-script` and `rollback-app` cut to their
  refuse and rollback paths.

Helpers, fixtures and production exports that only deleted tests used were removed until knip was clean.
