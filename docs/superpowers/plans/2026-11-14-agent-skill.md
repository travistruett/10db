# Agent skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Brief

- **What changes for the builder:** 10db carries the `10db-task` skill, installs it into `~/.10db/skills/10db-task`
  on every launch and links it for Claude Code and Codex. Settings › Agent skill shows it, with a switch to turn
  it off. A stale skill says "restart 10db".
- **What it buys:** no hand copying on a new Mac, and a skill tested against the real API in 10db's own suite.
- **What could go wrong:** the installer touching what the builder made. It is guarded by a real-filesystem
  table of every state a link path can be in (Task 3), and nothing is replaced unless it is 10db's own link or a
  link to nothing.
- **Calls you might disagree with:** the skill stays a CLI over HTTP (spec §9); the setting lives in its own
  Settings section because General is per project.
- **Needed from you:** nothing.

**Goal:** Ship the `10db-task` skill inside 10db, install and link it on launch, show it in Settings, and refuse a
skill of another version.

**Architecture:** A new package `@10db/agent-skill` holds the skill's files and its CLI in TypeScript, with every
command taking injected deps. The daemon build bundles the CLI into `<out>/agent-skill/10db-task/` with a `VERSION`.
A daemon module `agent-skill/` installs that folder and its links at start, serves its status, and a middleware
compares the skill's version header.

**Tech Stack:** TypeScript, zod 4, Hono, esbuild, vitest, React + Mantine, TanStack Query, msw.

**Spec:** `docs/superpowers/specs/2026-11-14-10db-agent-skill-design.md` (and its decision,
`docs/architecture/decisions/2026-11-14-10db-installs-its-agent-skill-on-launch.md`).

## Global Constraints

- Installed copy: `~/.10db/skills/10db-task` (under `builderHome`, never `homedir()` directly).
- Links: `~/.claude/skills/10db-task` (tool `claude_code`) and `~/.agents/skills/10db-task` (tool `codex`).
- Version header: `x-10db-skill-version`. Skill version: the first 12 hex digits of SHA-256 (§Task 2).
- App setting key: `agent_skill_enabled`, default `true`.
- 409 body: `{ "error": "skill_version", "message": "This 10db-task skill (<a>) isn't the one this 10db ships (<b>). Restart 10db to update it, or turn on Settings › Agent skill › Agents in any repo can use 10db." }`.
- Lane exclusion reason, exact: `10db's own skill acts for you with the app's token, so it never comes along`.
- Row label, exact: `Agents in any repo can use 10db`. Section title: `Agent skill`.
- Code style and testing rules: `.claude/rules/code-style.md`, `.claude/rules/testing.md`. `as const` objects, no
  enums, branded IDs, typed errors, zod at every boundary (files read from disk, HTTP bodies, child output).
- Pin dependencies exactly: `esbuild` `0.28.2`, `zod` `4.6.7` (the versions the daemon already pins).
- A package never imports an app. The daemon runtime does not import `@10db/agent-skill`; only its build script and
  tests do.
- Never print, echo or interpolate `ui-token`.
- Provider parity: the skill calls the daemon only; nothing branches on a project's provider.

## Review Focus

1. A fresh Mac or a Codex-only Mac with no `~/.claude/skills` or `~/.agents/skills`: the parent is created and the
   link made (Task 3, row `missing parent`).
2. A relative symlink at the link path, dangling or pointing at the installed copy through `..`: judged by what it
   resolves to, not its text (Task 3, rows `relative to ours`, `relative dangling`).
3. A crash mid-install leaves `~/.10db/skills/.10db-task-<random>` and an installed copy with no `VERSION`: the
   next start rewrites the copy and removes the leftover temp folder (Task 3, row `half-written`).
4. The builder replaces 10db's link with their own, then turns the switch off: their link is kept (Task 3,
   `uninstall` rows).
5. The skill run while 10db is closed, or with a stale `daemon.json`: the same messages as today, not a stack trace
   (Task 1, `connection` rows).

---

### Task 1: `@10db/agent-skill`: the skill's files and its CLI

**Files:**
- Create: `packages/agent-skill/{package.json,tsconfig.json,vitest.config.ts,AGENTS.md}` (copy `packages/harness`'s
  shape: private, ESM, `exports: { ".": "./src/index.ts", "./build": "./src/build.ts" }`, deps
  `@10db/contracts` `workspace:*`, `zod` `4.6.7`; devDeps `esbuild` `0.28.2`)
- Create: `packages/agent-skill/skill/SKILL.md`, `skill/README.md`: from
  `~/Projects/agent-os-worktrees/10db-skill-project-read/skills/10db-task/` (it has the `project` read). Change `T=`
  to `~/.10db/skills/10db-task/tendb.mjs`; README's "step 1 of queue task 8" paragraph becomes one line that the
  builder MCP bridge (`docs/builder-mcp.md`) is a separate channel; README says 10db installs the skill.
- Create: `packages/agent-skill/src/commands.ts`, `src/connection.ts`, `src/main.ts`, `src/index.ts`, `packages/contracts/src/agent-skill.ts`
- Test: `packages/agent-skill/src/commands.test.ts`, `src/connection.test.ts`
- Modify: root `vitest.config.ts` `projects` (add `'packages/agent-skill'`)

**Interfaces:**
- Consumes: `TaskInput`, `TaskPatch` (or `TaskPatchFields`) and the area-name schema from `@10db/contracts`.
- Produces:
  - `packages/contracts/src/agent-skill.ts`, exported from the contracts index (Tasks 3, 4, 6 use it):
  ```ts
  export const SKILL_VERSION_HEADER = 'x-10db-skill-version';
  export const AgentSkillTool = { ClaudeCode: 'claude_code', Codex: 'codex' } as const;
  export const AgentSkillLinkState = { Linked: 'linked', Missing: 'missing', PointsElsewhere: 'points_elsewhere', InTheWay: 'in_the_way' } as const;
  export const AgentSkillNotInstallable = { FromSource: 'from_source', OtherDataDir: 'other_data_dir' } as const;
  export const AgentSkillLink = z.object({ tool: z.enum(AgentSkillTool), path: z.string(), state: z.enum(AgentSkillLinkState), target: z.string().nullable() });
  export const AgentSkillStatus = z.object({
    enabled: z.boolean(),
    installable: z.union([z.literal(true), z.object({ reason: z.enum(AgentSkillNotInstallable) })]),
    version: z.string().nullable(), installedVersion: z.string().nullable(), installedPath: z.string(),
    links: z.array(AgentSkillLink), error: z.string().nullable(),
  });
  export const AgentSkillInput = z.object({ enabled: z.boolean() });
  export const AgentSkillInfo = z.object({ version: z.string().nullable(), appCommit: z.string().nullable() });
  ```
  (plus the `type X = ...` pairs).
  - `export class TendbError extends Error { name = 'TendbError' }`
  - `export interface CommandDeps { api(method: string, path: string, body?: unknown): Promise<unknown>; out(line: string): void; cwd: string; git(args: readonly string[], cwd: string): string | null; readFile(path: string): string; realpath(path: string): string }`
  - `export async function runCommand(argv: readonly string[], deps: CommandDeps): Promise<void>`: every command
    in today's `tendb.mjs` header, same names, same arguments, same output lines; `context` and `project` add
    `skillVersion` and `appVersion` from `GET /agent-skill` (Task 4: `{ version, appCommit }`).
  - `connection.ts`: `export function connectionFrom(appDir: string, readFile): { base: string; token: string }`
    and `export function httpApi(conn, skillVersion: string | null, fetchImpl = fetch): CommandDeps['api']`, which
    sends `Authorization: Bearer <token>` and, when non-null, `x-10db-skill-version`. Responses are parsed as JSON
    and a 409 `skill_version` body throws `TendbError(message)` verbatim.
  - `index.ts` exports `runCommand`, `CommandDeps`, `TendbError`, `AGENT_SKILL_SOURCE_DIR` (`resolve(import.meta.dirname, '../skill')`).
  - `main.ts`: production deps; reads `VERSION` beside `import.meta.dirname` (null when missing), prints a
    `TendbError`'s message to stderr and exits 1, any other error as `Unexpected error: <message>`.

- [ ] **Step 1: Write the failing tests.** `commands.test.ts`, table-driven over a fake `api` that records calls and
  answers from fixtures (the network is the boundary; the real API is Task 7):
  - `create` with a draft missing `acceptanceCriteria` throws a `TendbError` whose message contains the zod issue
    for `acceptanceCriteria` and posts nothing; with an unknown area names the project's areas; with a `dependsOn`
    id not in the project says `isn't a task in this project`; `--dry-run` posts nothing and prints `DRY RUN`.
  - `context` prints JSON whose `openTasks[*]` carry `dependsOn`, `rigor`, `effectiveRigor`, `kinds` (keys), and
    top-level `skillVersion`, `appVersion`.
  - `project <name>` resolves by name or id and prints `delivery.label` `Open a pull request` for `pull_request`,
    `landing.label` `Merge into main`, `account.label`, and a `note` only for `local` delivery.
  - `hazards` with additions never sends a hazard list shorter than it read, and refuses a scope change.
  - An unknown command throws `TendbError` with the usage line.
  `connection.test.ts`: missing `daemon.json` → `10db isn't running`; non-integer port → `daemon.json has no port`;
  `httpApi` sends the version header only when given; a 401 → `refused the token (401)`; a 409 `skill_version` →
  its message.
- [ ] **Step 2: Run** `pnpm vitest run --project agent-skill`. Expected: FAIL, modules missing.
- [ ] **Step 3: Implement** `commands.ts` by porting `tendb.mjs`: keep the live checks (areas exist, `dependsOn` in
  the project, kinds from `GET /kinds`) and replace the hand-written field checks with `TaskInput.safeParse` /
  `TaskPatch.safeParse`, reporting each issue as `<path>: <message>`.
- [ ] **Step 4: Run** the same command, plus `pnpm --filter @10db/agent-skill typecheck` and lint of the package.
  Expected: PASS.
- [ ] **Step 5: Commit** `feat(repo): the 10db-task skill's source and cli live in packages/agent-skill`, with a value card.

### Task 2: The build ships the skill with a `VERSION`

**Files:**
- Create: `packages/agent-skill/src/build.ts`; Test: `packages/agent-skill/src/build.test.ts`
- Modify: `apps/daemon/scripts/build.ts` (call `buildAgentSkill(resolve(outDir, 'agent-skill', '10db-task'))`, add
  `'agent-skill'` to the cleanup list), `apps/daemon/package.json` (devDep `@10db/agent-skill` `workspace:*`)
- Modify: `apps/daemon/src/paths.ts`: `export function resolveAgentSkillDir(): string | null` →
  `join(import.meta.dirname, 'agent-skill', '10db-task')` when it holds `VERSION`, else null.

**Interfaces:**
- Produces: `export function skillDigest(files: readonly { path: string; bytes: Uint8Array }[]): string`: sort by
  `path`, hash `path + '\0' + bytes + '\0'` for each with SHA-256, return the first 12 hex digits.
  `export async function buildAgentSkill(outDir: string): Promise<{ version: string }>`: esbuild `src/main.ts` →
  `tendb.mjs` (bundle, node platform, esm, target node22, no sourcemap), copy `skill/SKILL.md` and
  `skill/README.md`, write `VERSION` = `skillDigest` of those three files + `\n`. It removes and rewrites only those
  four names in `outDir`.

- [ ] **Step 1: Failing tests:** `skillDigest` is order-independent and changes when one byte changes;
  `buildAgentSkill(tempDir)` writes exactly `SKILL.md`, `README.md`, `tendb.mjs`, `VERSION`, `VERSION` equals
  `skillDigest` of the other three, and `execFileSync(process.execPath, [tendb.mjs, 'nope'])` exits 2 or 1 with
  `usage:` on stderr (the bundle runs with plain node and no `node_modules`; copy it to a fresh temp dir first).
- [ ] **Step 2: Run** `pnpm vitest run --project agent-skill src/build.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `build.ts`, the `build.ts` call and `resolveAgentSkillDir`.
- [ ] **Step 4: Run** the tests and `pnpm --filter @10db/daemon build -- <scratch dir>`; check
  `<scratch>/agent-skill/10db-task/VERSION` exists. Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): the app carries the 10db-task skill with its version`.

### Task 3: The installer

Small red-first steps: this writes in the builder's home. One commit per behavior.

**Files:**
- Create: `apps/daemon/src/agent-skill/install.ts`, `apps/daemon/src/agent-skill/AGENTS.md`
- Test: `apps/daemon/src/agent-skill/install.test.ts` (real temp home, real symlinks)

**Interfaces:**
- Consumes: `AgentSkillLink`, `AgentSkillLinkState`, `AgentSkillTool` from `@10db/contracts` (Task 1).
- Produces:
  - `export function installedSkillDir(home: string): string`, `export function skillLinkPaths(home: string): readonly { tool: AgentSkillTool; path: string }[]`
  - `export function readSkillVersion(dir: string): string | null` (zod: 12 hex digits, trimmed; anything else null)
  - `export function inspectAgentSkill(home: string): { installedVersion: string | null; links: AgentSkillLink[] }`
  - `export function installAgentSkill(home: string, shippedDir: string): { installedVersion: string; links: AgentSkillLink[] }`
  - `export function uninstallAgentSkill(home: string): void`
  - `export class AgentSkillInstallError extends Error { name = 'AgentSkillInstallError' }` wrapping fs errors.
- States: `linked` (resolves to the installed copy, compared by `realpath` of both), `missing` (only in
  `inspect`), `points_elsewhere` (with `target` = `readlink` text), `in_the_way` (a real folder or file).

- [ ] **Step 1: Failing table test** `installAgentSkill` with one row per state, asserting the row's resulting
  `lstat`/`readlink` and returned state: `missing parent` (no `~/.claude/skills`), `missing`, `ours`,
  `relative to ours` (`../../.10db/skills/10db-task`), `dangling` (absolute to a deleted path → replaced, `linked`),
  `relative dangling` (→ replaced), `elsewhere` (to an existing temp folder → untouched, `points_elsewhere`),
  `in the way folder` and `in the way file` (→ untouched, contents byte-identical after).
- [ ] **Step 2: Run** `pnpm vitest run --project daemon src/agent-skill/install.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** links. Commit `feat(daemon): 10db links its skill only where nothing of yours is`.
- [ ] **Step 4: Failing tests** for the copy: a matching `VERSION` writes nothing (mtime unchanged); a different one
  replaces the folder by rename from a sibling `.10db-task-<random>` temp folder; `half-written` (installed copy
  without `VERSION`, plus a leftover `.10db-task-x` folder) → rewritten and the leftover gone.
- [ ] **Step 5: Implement, run, commit** `feat(daemon): the skill copy is replaced whole or not at all`.
- [ ] **Step 6: Failing tests** for `uninstallAgentSkill`: removes links that resolve to the copy, keeps
  `elsewhere` and `in the way` rows, removes the copy; a second call is a no-op.
- [ ] **Step 7: Implement, run, commit** `feat(daemon): turning the skill off removes only 10db's links`.

### Task 4: Contracts, service, routes, version check, start-up

**Files:**
- Create: `apps/daemon/src/agent-skill/index.ts`
- Modify: `apps/daemon/src/api/app.ts` (routes after `/settings/keep-awake` ~:1803; middleware after auth ~:379;
  `createApp` dep `skillVersion: string | null`), `apps/daemon/src/api/services.ts` (`ApiServices` ~:677),
  `apps/daemon/src/daemon/services.ts` (~:754), `apps/daemon/test/api-stub.ts` (~:65),
  `apps/daemon/src/daemon/start.ts` (`DaemonOptions.agentSkill`, start step after ~:681, `createApp` ~:2414),
  `apps/daemon/src/main.ts` (placement from `resolveAgentSkillDir()` and `dataDir === defaultDataDir()`)
- Test: `apps/daemon/src/api/app.test.ts`, `apps/daemon/src/agent-skill/agent-skill.test.ts`,
  `apps/daemon/test/agent-skill-start.test.ts`

**Interfaces:**
- Consumes: Task 1's `packages/contracts/src/agent-skill.ts`.
- `apps/daemon/src/agent-skill/index.ts`:
  `export type AgentSkillPlacement = { kind: 'installable'; shippedDir: string } | { kind: 'not_installable'; reason: AgentSkillNotInstallable; shippedDir: string | null }`;
  `export function createAgentSkill(deps: { state: StateStore; placement: AgentSkillPlacement; home: string; logger: Logger }): AgentSkill`
  with `status(): AgentSkillStatus`, `setEnabled(enabled: boolean): AgentSkillStatus` (writes `agent_skill_enabled`
  and emits `SettingsChanged` on `app_setting` as keep-awake does, then installs or uninstalls), `atStart(): void`
  (installs when enabled and installable; logs and keeps the error for `status`), `shippedVersion(): string | null`.
  Default placement when `DaemonOptions.agentSkill` is absent: `{ kind: 'not_installable', reason: 'from_source', shippedDir: null }`.
- `ApiServices`: `agentSkill(): AgentSkillStatus; setAgentSkill(enabled: boolean): AgentSkillStatus; agentSkillInfo(): AgentSkillInfo`.
- Routes: `GET /settings/agent-skill`, `PUT /settings/agent-skill` (`AgentSkillInput`), `GET /agent-skill`.
- Middleware: after auth, when the header is present, `skillVersion` is non-null and they differ → the Global
  Constraints 409 body.

- [ ] **Step 1: Failing tests.** `app.test.ts` table for the middleware: header equal → 200; differs → 409 with the
  exact body; absent → 200; app with `skillVersion: null` and any header → 200; `/health` never checked. Route
  rows: GET/PUT `/settings/agent-skill` call the services and parse as `AgentSkillStatus`; a bad PUT body → 400.
  `agent-skill.test.ts` (real SQLite state store, temp home and shipped dir): default `enabled` true; `setEnabled(false)`
  persists across a new `createAgentSkill` on the same database and uninstalls; `not_installable` `atStart` writes
  nothing and `status().installable` is `{ reason }`. `agent-skill-start.test.ts`: `startDaemon` with
  `builderHome` temp and an installable placement links both paths; with `other_data_dir` creates nothing.
- [ ] **Step 2: Run** the three files. Expected: FAIL.
- [ ] **Step 3: Implement**; wire `atStart()` after `addStockHazardCommands` without failing the start.
- [ ] **Step 4: Run** the files plus `vitest related` on the changed files, daemon typecheck and lint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): the skill installs on launch, and a skill of another version is told to restart 10db`.

### Task 5: The skill never comes along into a lane

**Files:** Modify `apps/daemon/src/session-setup/builder-skills.ts` (`findBuilderSkills` ~:56, `judgeEntry` ~:31);
Test: its existing test file (extend the table).

**Interfaces:** Consumes `installedSkillDir(home)` from Task 3.

- [ ] **Step 1: Failing row:** a `~/.claude/skills/10db-task` link to `<home>/.10db/skills/10db-task` is absent from
  `folders` and present in `leftOut` with `why` exactly the Global Constraints reason; a plain skill beside it still
  comes along.
- [ ] **Step 2: Run, see it fail** (today's `leftOut` reason differs or it is absent).
- [ ] **Step 3: Implement** by real path, case-folded as the file already does names.
- [ ] **Step 4: Run, commit** `fix(daemon): 10db's own skill stays out of lanes, saying why`.

### Task 6: Settings › Agent skill

**Files:**
- Create: `apps/desktop/src/views/settings/agent-skill-section.tsx`, `agent-skill-section.test.tsx`
- Modify: `apps/desktop/src/views/settings/sections.ts` (key `AgentSkill`, title `Agent skill`, app-wide, after
  Keep-awake), `section-body.tsx` (case), `apps/desktop/src/daemon/queries.ts` (`queryKeys.agentSkill`,
  `useAgentSkill`, `useSetAgentSkill` as keep-awake's), `apps/desktop/src/daemon/events.ts` (`app_setting` adds
  `queryKeys.agentSkill`)

- [ ] **Step 1: Failing render tests** (`renderWithDaemon`, msw handlers for the two routes): enabled with both
  `linked` shows "Installed, current" and both paths; one `points_elsewhere` shows its target and "left as it is";
  `installable: { reason: 'other_data_dir' }` shows the switch disabled with "This 10db uses another data folder,
  so it installs nothing"; `from_source` says "run from source"; toggling the switch sends `PUT` `{ enabled: false }`.
- [ ] **Step 2: Run** `pnpm vitest run --project desktop agent-skill-section`. Expected: FAIL.
- [ ] **Step 3: Implement** on `lane-permissions-section.tsx`'s `SettingsCard`/`SettingRow`/`Switch` shape.
- [ ] **Step 4: Run** plus desktop typecheck and lint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): settings shows the agent skill, where it is linked, and a switch`.

### Task 7: The skill against the real API

**Files:** Create `apps/daemon/test/agent-skill-api.test.ts` (harness as `apps/daemon/test/lane-permissions-api.test.ts`).

- [ ] **Step 1: Write** rows running `runCommand` from `@10db/agent-skill` with `api` over the real daemon's HTTP
  and a temp repo as `cwd`: `create` posts a task that `GET /projects/:id/tasks` then returns with its `dependsOn`;
  `context` shows that dependency; `project` prints the project's `gateCommand` and `baseBranch`; `edit` changes a
  title; `hazards` add-only round-trips; a skill version differing from the daemon's is refused with the exact
  message.
- [ ] **Step 2: Prove it can go red:** rename a field the skill reads (`dependsOn` in its task mapping, locally,
  not committed) and see the `context` row fail; restore.
- [ ] **Step 3: Run, commit** `test(daemon): the 10db-task skill runs against the real api` with a value card.

### Task 8: Docs

- [ ] `apps/daemon/AGENTS.md` module list gains `agent-skill/`; `packages/agent-skill/AGENTS.md` (word budget);
  `docs/builder-mcp.md` gains one line pointing at the skill as the other channel; the spec's **Status** says
  built. Run `pnpm vitest run --project repo`. Commit `docs: the agent skill is built and where it lives`.

## After merge (not this branch)

The agent-os move (spec §8): once the app on this Mac runs a build with Task 4, an agent-os PR removes
`skills/10db-task/` and its two `links.txt` lines and stops `check.sh` checking them.
