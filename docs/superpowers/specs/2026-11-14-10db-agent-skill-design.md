# 10db ships the 10db-task skill and installs it for Claude Code and Codex

**Status:** designed on 2026-11-14. Nothing in it is built.

**Decision:** `docs/architecture/decisions/2026-11-14-10db-installs-its-agent-skill-on-launch.md`.

**Builds on:** the `10db-task` skill as it stands in agent-os (`skills/10db-task/`), which talks to the daemon's
local API with the UI token, and the builder MCP bridge (`docs/builder-mcp.md`), which this design leaves as it is.

## Brief

- **What changes for the builder.** The `10db-task` skill (file, edit, start tasks; read a project's settings; assess
  hazards) comes with 10db. On every launch 10db writes it to `~/.10db/skills/10db-task` and links it into
  `~/.claude/skills/10db-task` (Claude Code) and `~/.agents/skills/10db-task` (Codex). An app update updates the
  skill. Settings gains an app-wide section, Agent skill, with one row, "Agents in any repo can use 10db", that shows what is installed and where,
  with a switch to turn it off. agent-os stops carrying the skill.
- **What it buys.** Nothing to copy by hand on a new Mac. The skill can't drift from the API it calls: its source
  sits beside the API in the 10db repo, it imports the New Task rules from `@10db/contracts`, and 10db's own tests
  run it against a real daemon.
- **What could go wrong, and how we'd know.**
  - *10db overwrites something the builder made.* It never does: it creates a missing link, replaces only a link
    that points at nothing, and refreshes a link that is already its own. A link pointing elsewhere, or a real
    folder, is left alone and the Settings row names it.
  - *The skill and the running daemon disagree.* Every call sends the skill's version; a daemon shipping another
    one answers "restart 10db", and `context` and `project` print both versions.
  - *The move off agent-os leaves no skill.* A Claude Code session in any repo shows that at once (the skill is
    missing from its list); agent-os's links are removed only after the installed app carries the installer.
- **Calls you might disagree with.**
  - Install on every launch, on by default, with the switch (the builder's call, 2026-11-14).
  - The skill stays a CLI over the HTTP API, not a thin skill over the builder MCP tools; folding the two is a
    follow-up task (§9).
  - A link that points somewhere else is never taken over, even agent-os's. The move works because agent-os
    deletes its copy, which leaves its links pointing at nothing, and 10db replaces those.
- **What we need from the builder.** Nothing.

## 1. Words

- The **skill** is the folder `10db-task/`: `SKILL.md`, `README.md`, `tendb.mjs` and `VERSION`.
- The **shipped copy** is the skill inside the app bundle (`Contents/Resources/daemon/agent-skill/10db-task/`).
- The **installed copy** is `~/.10db/skills/10db-task/`, which 10db owns and rewrites.
- A **link** is one of `~/.claude/skills/10db-task` and `~/.agents/skills/10db-task`.
- The **skill version** is the first 12 hex digits of a SHA-256 over the shipped copy's other files, written to
  `VERSION` at build time.

## 2. Source and build

- A new package, `packages/agent-skill`:
  - `skill/SKILL.md` and `skill/README.md`, moved from agent-os with the part A reads, and `SKILL.md`'s commands
    pointing at `~/.10db/skills/10db-task/tendb.mjs`.
  - `src/commands.ts`: every `tendb.mjs` command, each taking its dependencies (`api`, `out`, `cwd`, `git`) with
    production defaults in `src/main.ts`. Draft and patch checks use `TaskInput`, `TaskPatch` and the area-name
    rule from `@10db/contracts`, not copies.
  - `src/main.ts`: reads `daemon.json` and `ui-token` from the default data dir, as today, and runs a command.
  - `src/index.ts`: `AGENT_SKILL_SOURCE_DIR` and `buildAgentSkill(outDir)`, which bundles `main.ts` into one
    dependency-free `tendb.mjs` (esbuild, like `builder-mcp.mjs`), copies `skill/`, and writes `VERSION`.
- `apps/daemon/scripts/build.ts` calls `buildAgentSkill` into `<out>/agent-skill/10db-task/`, so the app carries it
  beside the harness.
- The token rule is kept: nothing prints, echoes or interpolates `ui-token`, and the bundle reads it only for the
  `Authorization` header.

## 3. The installer

A daemon module, `apps/daemon/src/agent-skill/`, with `home` and the shipped dir injected (production defaults
`homedir()` and the bundle's path).

- **When it runs:** at daemon start, after the database opens, when the switch is on and the daemon may install.
  `main.ts` decides that and passes it in (`DaemonOptions.agentSkill`): it may when the data dir is
  `defaultDataDir()` and the bundle carries `agent-skill/10db-task`. A daemon on another data dir (`pnpm dev`) or
  run from source installs nothing and Settings says which. Tests pass a temp shipped dir and `builderHome`.
  Turning the switch on runs it at once.
- **The installed copy:** written to a sibling temp folder and renamed over `~/.10db/skills/10db-task`, so a skill
  run during the write sees the old copy or the new one, never half. Skipped when `VERSION` already matches.
- **Each link,** by what is there:

  | Found at the link path                      | Does                                       | Settings shows        |
  | ------------------------------------------- | ------------------------------------------ | --------------------- |
  | nothing (the parent folder is made)         | creates the link                           | linked                |
  | a link to the installed copy                | nothing                                    | linked                |
  | a link to a path that doesn't exist         | replaces it                                | linked                |
  | a link to anything else                     | nothing                                    | points at `<target>`  |
  | a real folder or file                       | nothing                                    | a folder is in the way |

- **Turning the switch off** removes each link that still points at the installed copy, then the installed copy.
  Nothing else is touched.
- **Failures** (permissions, a read-only home) are logged and shown in the row; they never stop the daemon.
- **Managed sessions.** The builder's `~/.claude/skills` comes along into lanes (Settings › Trust). The skill acts
  for the builder with the UI token, so it must not come along: `findBuilderSkills` leaves out a skill whose real path
  is under `~/.10db/skills/10db-task`, with the reason "10db's own skill acts for you with the app's token, so it
  never comes along". Without that it would still be refused, as a path outside the setup read roots, but with a
  reason that misleads. Lanes already can't read the token: the data dir is in every lane's protected reads.

## 4. The version handshake

- `tendb.mjs` reads `VERSION` beside itself and sends `x-10db-skill-version` on every call.
- The daemon compares it with its shipped copy's `VERSION`. When both exist and differ, every route answers 409
  `{ "error": "skill_version", "message": "This 10db-task skill (<a>) isn't the one this 10db ships (<b>). Restart
  10db to update it, or turn on Settings › Agent skill › Agents in any repo can use 10db." }`. A call without the
  header (an older copy) and a daemon with no shipped copy pass.
- `context` and `project` print `skillVersion` and `appVersion` (the build's short commit from `build-info.json`, or
  `null`), read from a new `GET /agent-skill`.

## 5. Settings

`GET /settings/agent-skill` → `{ enabled, installable: true | { reason }, version, installedVersion, installedPath,
links: [{ tool: 'claude_code' | 'codex', path, state, target? }], error? }`; `PUT /settings/agent-skill
{ enabled }` turns it on or off and answers the same shape. Both are zod contracts in `@10db/contracts`. Settings › General
is per project, so the row gets its own app-wide section, **Agent skill**, beside Keep-awake. It follows
lane permissions' switch row: the switch, "Installed, current" or what is wrong, and each link with its
state.

## 6. Provider parity

The skill talks to the daemon, never to a model provider, so it works the same for every project whatever its
account: a Claude plan, Bedrock, an API key or a ChatGPT/Codex plan. Claude Code and Codex get the same copy the
same way, one link each. A tool that isn't installed gets a link it never reads. One gap: an interactive Codex session sandboxes
the network by default, so the skill's call to `127.0.0.1` can fail there; its error says to allow network access for
the session, and a follow-up task closes the gap.

## 7. Tests (testing.md rungs)

| Behavior                                                   | Rung                                         |
| ---------------------------------------------------------- | -------------------------------------------- |
| each link state in §3's table, and switch off              | real temp home and links (table-driven)      |
| atomic replace and skip on matching `VERSION`              | real temp dirs                               |
| the commands against the real API (create, edit, project, context with `dependsOn`, hazards add-only) | `app.request()` through the commands' injected `api` |
| version handshake: match, differ, absent, no shipped copy  | `app.request()`                              |
| settings routes                                            | `app.request()`                              |
| the row shows linked, in the way and off                   | `renderWithDaemon`                           |
| the build writes `tendb.mjs`, `SKILL.md` and a `VERSION` matching its files, and the bundle runs `--help` with plain node | the real build into a temp dir |
| a daemon on the default data dir installs at start; another data dir doesn't | `createTestEngine` with an injected home |

## 8. Moving off agent-os

1. 10db's PR merges and the app on this Mac runs a build carrying it: Settings shows the links as "points at
   …/agent-os/skills/10db-task".
2. An agent-os PR removes `skills/10db-task/` and its two `links.txt` lines, and `check.sh` stops checking them. On
   `git pull` the agent-os links point at nothing.
3. On the next launch 10db replaces them; the row shows "linked". If it doesn't, the skill is missing from every
   session at once, and `ln -sfn ~/.10db/skills/10db-task ~/.claude/skills/10db-task` (and the `~/.agents` one)
   fixes it by hand.

## 9. Out of scope

- The Claude Code plugin marketplace: Claude Code only, so Codex would need a second channel.
- Installing the builder MCP bridge into clients, and folding the skill onto its tools. Both are a follow-up task:
  the bridge lacks `project`, hazards, plan import, goals and the Inbox and batch actions the skill has.
