# 10db Trust T2, Setup Comes Along: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every lane, pass and Plan session starts with:

- the project's instructions and the builder's own, in its system prompt;
- the builder's skills and installed plugins;
- the project's `.claude/skills|commands|agents`;
- a sandbox that opens exactly those folders, read-only.

Claude lanes and passes on an auto-mode account get the web without a card. Codex gets the same instructions and
skills through its own channels. Settings › Trust switches each of these, on by default, with a per-project
override, and lists what comes along and what was left out.

**Architecture:**

- **`session-setup/`** is a new daemon module. It finds the instructions, the builder's skill folders, Claude Code's
  installed-plugin list and the project's definitions, and builds a plain `SetupInput`.
- **The lane sandbox** decides which real paths it may open (`sandbox/setup-reads.ts`) and collapses them to a few
  entries. It writes a per-session setup dir in its files root (`sandbox/setup-dir.ts`) and adds the opened paths
  to the profile and to the file tools' policy. It returns plugin dirs (Claude) and skill roots (Codex).
- **The adapters** turn `SessionSpec.instructions` and `SessionSpec.setup` into their own options. Claude gets the
  system prompt and `plugins`. Codex gets `developerInstructions` and `skills/extraRoots/set`.
- **The switches** live in two app settings (`trust`, `trust.<projectId>`) and are read when each session starts.

**Tech Stack:** TypeScript, zod 4.6.7, yaml 2.9.1 (frontmatter), `@anthropic-ai/claude-agent-sdk` 0.3.316, Codex
0.167.0 app-server, Vitest, Mantine 9.

**Spec:** `docs/superpowers/specs/2026-11-12-10db-trust-line-design.md` §6, §10, §11, and §12 (the T2 row and "Web
in T2 depends on the judge"). Decision: `docs/architecture/decisions/2026-11-12-10db-trusts-the-developer-and-contains-the-agent.md`.
Research: `docs/architecture/research/2026-11-12-trust-line-research.md`: "Loading the builder's setup through the
Agent SDK", and "Live checks (2026-11-12)" L2, L3 and L4.

## Global Constraints

**Rules and how to work**

- Root `AGENTS.md`, `apps/daemon/AGENTS.md` (the security rule, and the module order under "Modules"),
  `apps/desktop/AGENTS.md`, `packages/contracts/AGENTS.md`, `.claude/rules/code-style.md` and
  `.claude/rules/testing.md`.
- Work on branch `feat/trust-t2` in its own worktree:
  `git worktree add ../10db-worktrees/trust-t2 -b feat/trust-t2 origin/main`.
- Tasks run in order, one commit per task unless the task says otherwise. Fallbacks F2 and F4 run only when their
  trigger holds.
- **T2 lands on today's code, before Sessions M2b** (spec §12). If Sessions M2a has merged when Task 9 starts, the
  Claude options in Task 9 go into M2a's `claudeQueryOptions` for both profiles, with the same test rows.
- Commits are Conventional Commits. Name every path (`git add a b && git commit -m '...'`), use a single-quoted `-m`,
  and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never use `--no-verify`.
- Each newly tested behaviour carries one value card in its commit. A new row in an existing table needs none.
- No AA numbers anywhere in the repo.

**The sandbox**

- **The sandbox is the boundary** (`decisions/2026-10-29-sandbox-is-the-boundary.md`). Tasks 6 and 7 change it, and
  their tests start on the real thing: Seatbelt through srt, and the guard's own judge. Task 15 is the adversarial
  review that decision requires.
- **"Yours" means the builder's home** (`~/.claude`, `~/.agents`), not an account's config dir (spec §6, call 14).
  On the default Claude account (`configDir` null, `environment/launch.ts:197-200`), the session's config dir is
  `~/.claude` itself. Only what Task 6 opens becomes readable there. The rest of `~/.claude` stays closed.
- **What opens** (spec §6, collapsed so the profile stays small). Each setup root opens whole when every child in it
  passes the refusal: `~/.claude/skills`, `~/.agents/skills`, and each loaded plugin's install path. If a root has a
  refused child, that root opens per passing folder instead. Link targets outside the roots open too, collapsed so
  that no entry lies under another. A link under an opened root opens nothing by itself: the kernel judges the real
  path.
- **Nothing lane-writable runs outside the sandbox.**
  - A project definition is copied, not linked.
  - Its frontmatter is re-emitted from an allowlist per kind (**call**).
  - Its `` !`…` `` lines are dropped (**call**). Claude Code runs them when it expands the definition, before the
    model sees anything.
  - A builder skill or plugin whose real path is lane-writable is left out.
- **Plugin MCP servers stay out of every session until T6** (ruling on review finding 4). The left-out note and
  Settings say so.
- **Plugins come along through a generated wrapper, never by `installPath`** (Task 6, Step 6). The wrapper:
  - keeps the plugin's name, so skill names don't change;
  - links its skills, agents, commands and hook scripts;
  - leaves out `.mcp.json` and the manifest's `mcpServers`;
  - re-emits `hooks.json` so that each command hook starts in the plugin's own folder, not the checkout.

  The pinned SDK gives 10db no control over a hook's working directory (`sdk.d.ts` 0.3.316 has no such option).
  The wrapper is the mitigation for a hook that resolves `npx`, `node` or a bin from its working directory.

**State and concurrency**

- The sandbox profile, the plugin list and the instructions are fixed when a session starts. A switch change, a new
  skill or a plugin update applies from the next session (spec §2).
- Each session has its own setup dir, which is removed with its sandbox, so no two sessions share one. A resumed
  session gets a new one.
- Claude Code records a conversation's system prompt on its first request and reuses it on resume until compaction
  (SDK 0.3.316 `sdk.d.ts`, `systemPrompt.snapshot`). A resumed lane keeps the instructions it started with.
- Every switch in the UI says "Applies from the next session".

**Provider parity**

- Each task states its behaviour per provider. Vertex is not an account kind 10db has (`AccountKind`,
  `packages/contracts/src/accounts.ts:10-17`), so no task has Vertex work.
- What a provider lacks after T2 is listed under "Follow-up tasks" at the end. Task 15 files them.

**Live checks this plan rests on**

- **L3 passed** (research, "L3"):
  - `--plugin-dir` with `--setting-sources ''` loads an installed plugin and a generated dir whose `skills/<name>`
    are symlinks, including a folder of symlinks.
  - Plugin hooks run (superpowers' `SessionStart`).
  - Skills arrive namespaced by plugin name.
  - Claude Code lists installed plugins in `~/.claude/plugins/installed_plugins.json` (`version: 2`), and their
    on/off state is in `enabledPlugins` in `~/.claude/settings.json`.
- **L4 partly failed** (research, "L4"), so Task 13 uses `skills/extraRoots/set` and puts every instruction in
  `developerInstructions`. The reasons: `skills.config` adds no folders, `skills/extraRoots/set` does, and Codex
  loads no `AGENTS.md` under `untrusted`.
- **L2 passed on the plan and Bedrock.** The gateway was not run, so Task 12 keeps the gateway carded.
- **Still open, checked by Task 8 before any plugin reaches a session:**
  - **A4:** whether a plugin's `PreToolUse` answer can override 10db's `deny` or `ask`, or rewrite a call's input
    after the guard judged it.
  - **M1:** whether a plugin's `.mcp.json` servers start under `strictMcpConfig: true`. The SDK's typings
    (`sdk.d.ts`, `strictMcpConfig`) say it ignores "plugins" too.
  - Fallback: F2 if A4 fails. Whatever M1 shows, the wrapper never carries a plugin's MCP servers. Task 8 only
    records whether `strictMcpConfig` alone would have kept them out.
- **Read in the pinned SDK while writing this plan:** `sdk.mjs` turns an absent `systemPrompt` into the empty custom
  prompt `""`. So a lane's base prompt today is an empty custom prompt, and Plan's is the `claude_code` preset
  (`claude-shape.ts:109`). Task 9 appends to each without changing its base (ruling on finding 6).
- **Not checked by L4:** whether `thread/start`'s `config` can set `skills.include_instructions`, whether
  `thread/resume` takes `developerInstructions`, and whether a root of linked skill folders lists. Task 13 checks
  them, and F4 covers the first.

## Review Focus

1. **A skill link, or a linked `SKILL.md`, that leads to `~`, to a credential folder, or into a checkout.** It is
   left out and listed, and the kernel never opens it. Rows are in Task 6 (`setupReadRefusal`), Task 3 (the linked
   `SKILL.md`) and Task 6's Seatbelt test.
2. **A project definition that carries power or hides behind a link.** That means frontmatter outside its kind's
   allowlist, a `` !`…` `` line, a second YAML document, an alias, a link anywhere on its path, or a `.env*` file in
   a skill folder. The key or line is dropped, or the file is left out, and each case is listed. Rows are in Task 4.
3. **A switch flipped while a session runs.** The running session keeps what it started with, and the next one
   follows the switch. Test in Task 10.
4. **A plugin removed or updated between Claude Code's list and the session** (its `installPath` is gone). It is left
   out with a note, and the session still starts. Row in Task 6.
5. **A builder with about 200 skills.** The profile stays a handful of entries, and Codex's sandbox still compiles.
   Rows in Task 6 (Seatbelt) and Task 13 (Codex live).

---

### Task 1: The trust switches, stored per app and per project

**Files:**

- Create: `packages/contracts/src/trust.ts`, `packages/contracts/src/trust.test.ts`
- Modify: `packages/contracts/src/index.ts`, and `packages/contracts/src/json-schema.ts` to register the DTOs
- Modify: `packages/contracts/generated/*`, by running `pnpm --filter @10db/contracts generate`
- Create: `apps/daemon/src/permissions/trust-switches.ts`, `apps/daemon/src/permissions/trust-switches.test.ts`
- Modify: `apps/daemon/src/permissions/index.ts`

**Interfaces:**

- Produces, in `@10db/contracts`:
  - `TRUST_SWITCH_KEYS = ['web', 'projectInstructions', 'yourInstructions', 'yourSkills', 'yourPlugins', 'projectSkills'] as const`.
  - `TrustSwitches = z.strictObject({ ...one z.boolean() per key, plugins: z.record(z.string().min(1), z.boolean()) })`.
    `plugins` holds only the plugins the builder switched by hand, keyed by id (`name@marketplace`). A plugin it
    doesn't name follows Claude Code's own `enabledPlugins`.
  - `TRUST_DEFAULTS: TrustSwitches`: every boolean true, `plugins: {}`.
  - `TrustOverrides = TrustSwitches.partial()`.
  - `effectiveTrust(app: TrustSwitches, overrides: TrustOverrides): TrustSwitches`. An override wins per field;
    `plugins` merges key by key, the override's keys winning.
  - `SetupPreviewDto = { skills: string[]; plugins: string[]; leftOut: { what: string; why: string }[] }`.
  - `InstalledPluginDto = { id, name, version: string; enabledInClaude, on: boolean }`.
  - `TrustSettingsDto = { switches: TrustSwitches; plugins: InstalledPluginDto[] }`.
  - `ProjectTrustDto = { overrides: TrustOverrides; effective: TrustSwitches; preview: SetupPreviewDto }`.
- Produces, in `permissions/trust-switches.ts` (following `lane-auto-mode.ts`):
  - `appTrustSwitches(db: DbReader, onInvalid?: (key: string, stored: unknown) => void): TrustSwitches`, from app
    setting `trust`, **parsed key by key** (finding 9). A key that is absent takes its default. A key with a value of
    the wrong type counts as off, and `onInvalid` is told. A stored value that isn't an object counts as every switch
    off. A key added later reads its default from an older stored object.
  - `setAppTrustSwitches(ctx: WriteContext, switches: TrustSwitches): void`.
  - `projectTrustOverrides(db, projectId: ProjectId, onInvalid?): TrustOverrides`, from `trust.<projectId>`, parsed
    the same way. An absent key means no override.
  - `setProjectTrustOverrides(ctx, projectId, overrides: TrustOverrides): void`.
  - `trustSwitchesFor(db, projectId): TrustSwitches`, which is `effectiveTrust(app, overrides)`.

**Per provider:** every account kind has the same switches. What each switch does per provider is in Tasks 9 to 14.

- [ ] **Step 1: Write the failing tests.**

  `trust.test.ts` is a table for `effectiveTrust`:
  - `no overrides is the app's`
  - `an override wins one field`
  - `plugins merge key by key, the override's winning`
  - `an empty plugins override keeps the app's`

  `trust-switches.test.ts` runs on a real SQLite store (`createTestStore`):
  - `starts with every switch on`
  - `keeps what the builder sets`
  - `a stored object missing a key gives that key its default`: store everything but `projectSkills`, and expect
    `projectSkills: true`.
  - `a key of the wrong type is off and named`: store `web: 'yes'`. Expect `web: false`, the rest stored, and
    `onInvalid('web', 'yes')`.
  - `a stored value that is not an object turns every switch off`
  - `a project's overrides apply to it alone`
- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm exec vitest run --project contracts packages/contracts/src/trust.test.ts && pnpm --filter @10db/daemon exec vitest run src/permissions/trust-switches.test.ts`
  Expected: FAIL, because the modules don't exist.
- [ ] **Step 3: Implement both modules, register the DTOs and run `pnpm --filter @10db/contracts generate`.**
- [ ] **Step 4: Run the tests, then typecheck.** Use the same command, then
  `pnpm --filter @10db/contracts typecheck && pnpm --filter @10db/daemon typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add packages/contracts/src/trust.ts packages/contracts/src/trust.test.ts packages/contracts/src/index.ts packages/contracts/src/json-schema.ts packages/contracts/generated apps/daemon/src/permissions/trust-switches.ts apps/daemon/src/permissions/trust-switches.test.ts apps/daemon/src/permissions/index.ts && git commit -m 'feat(daemon): trust switches for what comes along, app-wide and per project

Value: protects=each switch defaults on, a project override wins per field, a bad key turns only itself off;
fails_when=an override leaks to another project, or a newly added key turns every stored switch off;
why_new=no setting for setup exists; lane-auto-mode.test covers one boolean only;
no_claim=that any session reads them (Tasks 10, 11, 13)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 2: The instructions a session starts with

The project's `AGENTS.md`, `CLAUDE.md` and `.claude/rules/*.md` come first, then the builder's `~/.claude/CLAUDE.md`,
as one text. Today `settingSources: []` loads none of them (`sessions/claude-adapter.ts:314` for lanes,
`claude-shape.ts:102` for Plan). Codex under `untrusted` loads no `AGENTS.md` (L4).

**Files:**

- Create: `apps/daemon/src/session-setup/instructions.ts`, `instructions.test.ts`, `left-out.ts`, `index.ts`
- Modify: `apps/daemon/src/sessions/index.ts`: export `readRepoConfigFile`, `RepoConfigFileError` and
  `REPO_CONFIG_MAX_BYTES`.
- Modify: `apps/daemon/AGENTS.md`:
  - In the module order (line 58), add `session-setup` as its own step after `sessions`, `inbox`, `briefing`,
    `team`.
  - Add a `session-setup/` bullet saying what it reads, and that it reads checkout files only through the safe
    reader.

**Interfaces:**

- Produces in `left-out.ts`:
  - `interface LeftOut { readonly what: string; readonly why: string }`.
  - `leftOutNote(items: readonly LeftOut[]): string | null`: one paragraph that starts
    `Note from 10db: left out of this session:`, or null when nothing was left out.
- Produces in `instructions.ts`:
  - `INSTRUCTIONS_MAX_CHARS = 64_000` **(call)**.
  - `interface Instructions { readonly text: string | null; readonly sources: readonly string[]; readonly leftOut: readonly LeftOut[] }`.
  - `readInstructions(input: { checkout: string; home: string; project: boolean; yours: boolean; laneWritable: readonly string[] }): Instructions`:
    - The order is `AGENTS.md`, `CLAUDE.md`, `.claude/rules/*.md` sorted by name, then `~/.claude/CLAUDE.md`.
    - Checkout files go through `readRepoConfigFile`. A link, or a file over 256 KiB, is refused and left out (R8).
    - The builder's file may be a link (a dotfiles repo). Its real path must be a regular file and must not lie
      under `laneWritable`. Otherwise it is left out.
    - Each file becomes a section headed `## <label> (<path relative to the checkout, or ~/.claude/CLAUDE.md>)`.
    - Sections are added whole until the next one would pass `INSTRUCTIONS_MAX_CHARS`. That section and the rest are
      left out, `why: 'over the size 10db puts in a system prompt'`.
    - The text opens with one fixed line: `These are the project's and the builder's own instructions, which Claude
      Code would load itself. Follow them, except where 10db's brief for this session says otherwise: 10db's rules on
      commits, pushes, claims and the gate come first.` **(call: coordination outranks project text, spec §7)**
    - The skill-name line (finding 10) is not here: it applies only to Claude with skills loaded, so the Claude
      adapter adds it (Task 9).
    - `@path` imports are not expanded, and a rule's `paths:` frontmatter doesn't filter it **(call)**.

**Per provider:** one text for every provider. Claude appends it to its system prompt (Task 9). Codex puts it in
`developerInstructions` (Task 13). A gateway account is like any other Claude account here.

- [ ] **Step 1: Write the failing tests.** Use a temp checkout and a temp home (`tempDir` from `test/fixtures`).

  Table `readInstructions`:
  - `both on: AGENTS.md, CLAUDE.md, rules in name order, then yours` (assert the order of the `## ` headings)
  - `project off: only yours`
  - `yours off: only the project's`
  - `nothing to read is null text`
  - `opens with the precedence line`
  - `a CLAUDE.md that is a link is left out, naming why`
  - `a 300 KiB AGENTS.md is left out, and the rest load`
  - `past the cap, whole files are left out from the first that does not fit` (three 30 000-char rules files: two
    load, the third is listed)
  - `the builder's file through a link to a dotfiles folder loads`
  - `the builder's file whose real path is in a checkout is left out`

  `leftOutNote` rows: `none is null`, and `two items, one line each, in order`.
- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm --filter @10db/daemon exec vitest run src/session-setup/instructions.test.ts`
  Expected: FAIL, because the module doesn't exist.
- [ ] **Step 3: Implement `readInstructions` and `leftOutNote`, and export the reader from `sessions`.**
- [ ] **Step 4: Run the tests, typecheck and lint.** Run the same command, then
  `pnpm --filter @10db/daemon typecheck && pnpm exec eslint --max-warnings=0 apps/daemon/src/session-setup apps/daemon/src/sessions/index.ts`.
- [ ] **Step 5: Commit** as `feat(daemon): read the project's and the builder's instructions for a session`, with
  this value card:
  - `protects=` the four sources in order, links and oversized files refused, the cut at a file boundary
  - `fails_when=` a linked CLAUDE.md is followed, or a cut lands mid-file
  - `why_new=` nothing reads instructions today
  - `no_claim=` that a session receives the text (Tasks 9, 13)

---

### Task 3: The builder's skill folders and Claude Code's installed plugins

**Files:**

- Create: `apps/daemon/src/session-setup/builder-skills.ts`, `builder-skills.test.ts`, `installed-plugins.ts`,
  `installed-plugins.test.ts`
- Modify: `apps/daemon/src/session-setup/index.ts`

**Interfaces:**

- Produces in `builder-skills.ts`:
  - `interface SkillFolder { readonly name: string; readonly path: string; readonly skillFile: string }`.
    `path` is the folder as found (it may be a link). `skillFile` is the **real path** of its `SKILL.md` (finding 2).
  - `findBuilderSkills(home: string): { folders: SkillFolder[]; leftOut: LeftOut[] }`. It walks `~/.claude/skills/*`,
    then `~/.agents/skills/*`.
  - An entry counts when it is a directory, or a link to one, whose `SKILL.md` resolves (through any link) to a
    regular file.
  - An entry whose name starts with `.` is skipped silently (`.DS_Store`, `.git`).
  - Every other entry that doesn't count is left out with a reason:
    - `no SKILL.md`;
    - `its SKILL.md leads nowhere`;
    - `a skill named <n> is already loaded from <path>` (the first folder with a name wins).
  - Real paths are not judged here. The sandbox judges the folder's and the `SKILL.md`'s real paths (Task 6).
- Produces in `installed-plugins.ts` (the shape L3 recorded):
  - `interface InstalledPlugin { readonly id: string; readonly name: string; readonly version: string; readonly installPath: string; readonly enabledInClaude: boolean }`.
  - `class InstalledPluginsError extends Error` with `name = 'InstalledPluginsError'`.
  - `readInstalledPlugins(home: string): InstalledPlugin[]`:
    - It zod-parses `~/.claude/plugins/installed_plugins.json` as
      `z.looseObject({ version: z.literal(2), plugins: z.record(z.string(), z.array(z.looseObject({ scope: z.string(), installPath: z.string(), version: z.string() }))) })`.
    - It takes only `scope: 'user'` entries **(call)**.
    - `enabledInClaude` comes from `z.looseObject({ enabledPlugins: z.record(z.string(), z.boolean()).optional() })`
      over `~/.claude/settings.json`. That key alone is read; the file is otherwise never loaded (spec §6, call 5).
      An id the file doesn't name counts as enabled.
    - A missing list gives `[]`. A list that doesn't parse throws `InstalledPluginsError`.

**Per provider:** discovery is the same for every provider. Claude loads plugins whole. Codex takes only their skills
(Task 13), and Settings says so (Task 14).

- [ ] **Step 1: Write the failing tests** over a temp home.

  Table `findBuilderSkills`:
  - `a folder with SKILL.md counts, one without is listed`
  - `a link to a folder outside the home counts, as found`
  - `a folder whose SKILL.md is a link gives that link's real path`
  - `a SKILL.md link that leads nowhere is listed`
  - `the same name under ~/.agents/skills is listed, naming the first`
  - `a dot entry is skipped and not listed`
  - `no skills dirs is empty`

  Table `readInstalledPlugins`:
  - `reads a user-scope plugin with its install path and version`
  - `leaves out project and local scope`
  - `enabledPlugins false marks it off; unnamed counts as on`
  - `no list is empty`
  - `a list of another version throws InstalledPluginsError`
  - `reads no other key of settings.json` (a settings file with odd `env` and `permissions` still parses)
- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm --filter @10db/daemon exec vitest run src/session-setup/builder-skills.test.ts src/session-setup/installed-plugins.test.ts`
- [ ] **Step 3: Implement both.**
- [ ] **Step 4: Run them to see them pass,** then typecheck and lint `apps/daemon/src/session-setup`.
- [ ] **Step 5: Commit** as `feat(daemon): find the builder's skill folders and claude code's installed plugins`, with
  one value card per module.

---

### Task 4: The project's skills, commands and agents, copied with lane-written power removed

The checkout is lane-writable. At session start the daemon copies these files into the session's setup dir, which no
lane can write. A lane's edit applies from the next session. A hook, model switch or shell line a lane wrote never
runs outside the sandbox.

**Files:**

- Modify: `apps/daemon/src/sessions/repo-config-file.ts`. Add `readRepoFileBytes`, a variant on the same
  open-and-`fstat` path (finding 7). Add its rows to `repo-config-file`'s test file, or create
  `repo-config-file.test.ts` if there is none.
- Modify: `apps/daemon/src/sessions/index.ts` (export the variant).
- Create: `apps/daemon/src/session-setup/project-definitions.ts`, `project-definitions.test.ts`,
  `definition-frontmatter.ts`, `definition-frontmatter.test.ts`
- Modify: `apps/daemon/src/session-setup/index.ts`

**Interfaces:**

- `readRepoFileBytes(path: string, maxBytes: number): { readonly bytes: Buffer; readonly mode: number } | null`. It
  opens with `O_NOFOLLOW | O_NONBLOCK`, accepts only a regular file, and refuses anything over `maxBytes` with
  `RepoConfigFileError`. `readRepoConfigFile` keeps its behaviour and becomes a UTF-8 wrapper over it.
- `definition-frontmatter.ts`:
  - `DefinitionKind = { Skill: 'skill', Command: 'command', Agent: 'agent' } as const`.
  - `FRONTMATTER_ALLOWED` **(call; each list is the keys that only describe or narrow)**:
    - skill: `name`, `description`, `when_to_use`, `argument-hint`, `user-invocable`, `disable-model-invocation`,
      `license`, `version`;
    - command: `description`, `argument-hint`, `disable-model-invocation`;
    - agent: `name`, `description`, `tools`, `disallowedTools`, `color`.

    An agent's `tools` stays, because dropping it would let the subagent inherit every tool. Everything else is
    dropped: `hooks`, `mcpServers`, `permissionMode`, `allowed-tools`, `model`, `context`, `agent`, `isolation`,
    `skills`, and any key not listed.
  - `cleanDefinition(kind: DefinitionKind, text: string): { text: string; dropped: string[] } | { refused: string }`:
    - A file that starts with `---` has its frontmatter block parsed by `yaml`'s `parseAllDocuments` with
      `maxAliasCount: 0`.
    - It refuses: more than one document, any alias, a mapping key that isn't a string, or a value that isn't a
      string, boolean or array of strings.
    - The allowed keys are zod-parsed per kind and **re-emitted with `yaml.stringify` from the parsed object**, never
      edited as text.
    - Body lines that hold `` !` `` are dropped (`dropped` names how many).
    - A body that starts with another `---` line is refused.
- `project-definitions.ts`:
  - `interface DefinitionFile { readonly relative: string; readonly content: Buffer; readonly mode: number }`.
    `relative` is under the plugin root: `skills/<name>/<path>`, `commands/<name>.md` or `agents/<name>.md`.
  - `PROJECT_DEFINITIONS_MAX_BYTES = 4 * 1024 * 1024`, `PROJECT_FILE_MAX_BYTES = 256 * 1024` and
    `PROJECT_DEFINITIONS_MAX_FILES = 500` **(call)**.
  - `readProjectDefinitions(checkout: string): { files: DefinitionFile[]; leftOut: LeftOut[] }`:
    - It reads `.claude/skills/<name>/**`, `.claude/commands/*.md` and `.claude/agents/*.md`.
    - A file's directory must have the real path its spelling has under the checkout's real path, checked both
      before and after the read. The file's `fstat` dev and inode must equal an `lstat` of its path taken after the
      second check (finding 19).
    - A skill folder copies whole, binary files included, mode kept and masked with `0o700`.
    - **A file over `PROJECT_FILE_MAX_BYTES` leaves out its whole skill**, and the skill is listed.
    - `.env*` files are never copied, and are listed.
    - `SKILL.md` and each command or agent file go through `cleanDefinition`. A refusal leaves out the definition,
      and anything dropped is listed (`why: 'model, hooks removed; 2 shell lines removed: a lane can write this file'`).
    - Past either cap, the remaining definitions are left out whole.

**Per provider:** Claude gets all three kinds (Task 9). Codex gets `skills/` only, through `skills/extraRoots/set`
(Task 13). Commands and agents are a follow-up there.

- [ ] **Step 1: Write the failing tests.**

  Table `cleanDefinition`:
  - `keeps a skill's name and description`
  - `drops hooks, allowed-tools, model and context, and names them`
  - `drops an unknown key and names it`
  - `keeps an agent's tools; drops its permissionMode and mcpServers`
  - `drops lines holding !\`…\` and counts them`
  - `refuses a second document`
  - `refuses an alias`
  - `refuses a non-string value of an allowed key`
  - `refuses a body that starts with another --- block`
  - `a file with no frontmatter is kept, shell lines dropped`

  Table `readRepoFileBytes`:
  - `reads a binary file byte for byte with its mode`
  - `refuses a link`
  - `refuses past the cap`

  Table `readProjectDefinitions` (with `createTempRepo`):
  - `copies a skill folder with its script and a PNG, bytes and mode kept`
  - `leaves out a skill whose .claude/skills is a link`
  - `leaves out a command that is a link`
  - `leaves out a whole skill when one of its files is over the file cap`
  - `does not copy a .env file inside a skill folder, and lists it`
  - `leaves out a definition whose frontmatter is refused`
  - `leaves out whole definitions past the byte cap`
  - `no .claude dir is empty`
- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm --filter @10db/daemon exec vitest run src/session-setup/definition-frontmatter.test.ts src/session-setup/project-definitions.test.ts src/sessions/repo-config-file.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to see them pass,** along with `src/sessions/project-settings.test.ts`,
  `src/sessions/project-mcp.test.ts` and `src/sessions/mcp-hosts-file.test.ts` unchanged (they use the reader).
- [ ] **Step 5: Commit** as `feat(daemon): copy the project's skills, commands and agents with only describing frontmatter`,
  with two value cards. The first, for `cleanDefinition`:
  - `protects=` a lane-written definition reaches a session with only allowlisted keys and no shell lines
  - `fails_when=` a new frontmatter key, an alias or a second document carries power through
  - `why_new=` nothing copies definitions today
  - `no_claim=` the list matches Claude Code's full key set (Task 15 reviews it)

  The second card covers the copy: no links, no `.env`, and its caps.

---

### Task 5: One session's setup plan

**Files:**

- Create: `apps/daemon/src/sandbox/setup-input.ts` (types only, so the sandbox imports nothing from
  `session-setup`); export it from `sandbox/index.ts`
- Create: `apps/daemon/src/session-setup/plan.ts`, `plan.test.ts`
- Modify: `apps/daemon/src/session-setup/index.ts`

**Interfaces:**

- `setup-input.ts`:
  `interface SetupInput { readonly skills: readonly { readonly name: string; readonly path: string; readonly skillFile: string }[]; readonly plugins: readonly { readonly id: string; readonly path: string }[]; readonly projectFiles: readonly { readonly relative: string; readonly content: Buffer; readonly mode: number }[] }`.
- `plan.ts`:
  - `interface SessionSetupPlan { readonly instructions: Instructions; readonly input: SetupInput; readonly leftOut: readonly LeftOut[] }`.
  - `planSessionSetup(args: { home: string; checkout: string; switches: TrustSwitches; laneWritable: readonly string[] }): SessionSetupPlan`:
    - `yourSkills` off means no builder skills.
    - `yourPlugins` off means no plugins. Otherwise a plugin loads when `switches.plugins[id] ?? enabledInClaude` is
      true.
    - `projectSkills` off means no project files.
    - An `InstalledPluginsError` becomes one left-out item (`Claude Code's plugin list`) and no plugins.
    - Every loaded plugin adds the left-out item `<id>'s MCP servers: until 10db runs your MCP servers (T6)`, unless
      the plugin declares no MCP servers (no `.mcp.json` in its install path, and no `mcpServers` in its manifest).

**Per provider:** the plan is the same for every provider. The adapters pick what they use.

- [ ] **Step 1: Write the failing table** over a temp home and checkout holding one of each kind:
  - `all on loads all`
  - five rows, `each switch off drops only its kind`
  - `a plugin off in Claude Code stays off unless switched on here`
  - `a plugin switched off here stays off though Claude Code has it on`
  - `a plugin list that can't be read is one note and no plugins`
  - `a plugin with a .mcp.json gets the MCP left-out item, one without gets none`
- [ ] **Step 2: Run it to see it fail.** Run: `pnpm --filter @10db/daemon exec vitest run src/session-setup/plan.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it to see it pass.**
- [ ] **Step 5: Commit** as `feat(daemon): plan what comes along into one session from the trust switches`, with a
  value card.

---

### Task 6: The sandbox opens the setup's folders read-only, and writes the session's setup dir

This task changes the kernel sandbox. Each step is small and red first: six commits, one per behaviour.

**Files:**

- Create: `apps/daemon/src/sandbox/setup-reads.ts`, `setup-reads.test.ts`, `setup-dir.ts`, `setup-dir.test.ts`,
  `plugin-wrapper.ts`, `plugin-wrapper.test.ts`
- Create: `apps/daemon/test/setup-reads.seatbelt.test.ts`
- Modify: `apps/daemon/src/sandbox/profile.ts:164-209` (`LaneProfileInput`) and `:309-376` (`buildLaneProfile`);
  `profile.test.ts`
- Modify: `apps/daemon/src/sandbox/lane-sandbox.ts`:
  - `:77-106`, `LaneSession.setup`;
  - `:109-145`, `LaneSessionInput.setup`;
  - `:147-149`, `LaneSandbox.judgeSetup`;
  - `:322-353`, the profile input;
  - `:458-470`, dispose.
- Modify: `lane-sandbox.test.ts`
- Modify: `apps/daemon/src/sandbox/stale-files.ts:17` (sweep `10db-setup-<12 hex>` dirs), `stale-files.test.ts`
- Modify: `apps/daemon/src/sandbox/index.ts`

**Interfaces:**

- `setup-reads.ts`:
  - `setupReadRoots(home: string): string[]` returns `~/.claude/skills`, `~/.claude/plugins` and
    `~/.agents/skills`.
  - `interface SetupReadContext { readonly home: string; readonly protectedReads: readonly string[]; readonly secretFiles: readonly string[]; readonly sandboxRoots: readonly string[]; readonly laneWritable: readonly string[] }`.
  - `setupReadRefusal(real: string, ctx: SetupReadContext): string | null` returns null when the real path may open
    read-only, and otherwise one sentence. It refuses a path that (finding 3):
    1. is `/`, the home, or an ancestor of the home;
    2. lies under the home, under none of `setupReadRoots`, and either
       - is fewer than two levels below the home (`~/x` itself), or
       - lies under `~/Library`, or under any entry of the home whose name starts with `.`.

       This is structural, not a list of secrets: `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.gnupg` and `~/.kube` all
       fall under it, and `~/Projects/my-skills/x` passes.
    3. lies under a protected read and under none of `setupReadRoots`;
    4. is, or holds, a protected read, a secret file or a sandbox root;
    5. is, holds, or lies under a lane-writable root (every checkout, the worktree root, every lane temp root).
  - `collapseReads(paths: readonly string[]): string[]`: sorted, deduplicated, and with every path that lies under
    another removed.
- `setup-dir.ts`:
  - `interface SessionSetup { readonly pluginDirs: readonly string[]; readonly skillRoots: readonly string[]; readonly reads: readonly string[]; readonly loaded: { readonly skills: readonly string[]; readonly plugins: readonly string[] }; readonly leftOut: readonly { readonly what: string; readonly why: string }[] }`.
  - `EMPTY_SETUP: SessionSetup`.
  - `keepSetup(input: SetupInput, refuse: (real: string) => string | null, home: string): { keptSkills; keptPlugins; reads: string[]; leftOut }`.
    It reads the file system and writes nothing. `createSetupDir` and `LaneSandbox.judgeSetup` (the Settings
    preview) share it:
    - A skill is kept when `refuse` passes both the real path of its folder and the folder of its `skillFile`.
    - A plugin is kept when its `installPath` exists and `refuse` passes its real path. A missing one is left out
      (`why: 'its folder is gone; Claude Code may have updated it'`), which is Review Focus 4.
    - A folder inside a kept skill or plugin that can't be listed (for the `.env*` walk below) leaves that skill or
      plugin out, with its reason. It never throws `SandboxProfileError` for the session.
    - `reads` (finding 1, as ruled in round 2):
      - for `~/.claude/skills` and `~/.agents/skills`, the root whole unless a **real directory** directly in it was
        refused. A refused child that is a link doesn't stop the root opening whole, because the kernel judges a link
        by its real path, which stays closed. When a real directory was refused, the root opens as its kept folders,
        one by one;
      - each kept plugin's real `installPath`;
      - the real folder of every kept skill and `skillFile` that lies outside those roots;
      - the `.env*` files that `secretFilesIn` finds under each read, as extra denies;
      - everything through `collapseReads`.
  - `createSetupDir(filesRoot: string, input: SetupInput, refuse, home: string): { setup: SessionSetup; remove(): void }`:
    - It makes `<filesRoot>/10db-setup-<12 hex>/`.
    - `yours/` holds `.claude-plugin/plugin.json` (`{"name":"yours"}`) and a `skills/<name>` symlink to each kept
      folder.
    - `project/` holds `.claude-plugin/plugin.json` (`{"name":"project"}`) and the copied files.
    - `plugins/<name>/` is each kept plugin's wrapper, made by `wrapPlugin` (below).
    - `pluginDirs` is `[yours, project]` (each only when it holds anything), then each wrapper. It is never an
      `installPath`.
    - `skillRoots` is `yours/skills`, `project/skills`, and `<installPath>/skills` where it exists.
    - `reads` is the setup dir plus `keepSetup`'s reads.
    - Dirs are created `0o700`. Files keep their mode, masked with `0o700`.
- `plugin-wrapper.ts` holds the security item from the T6 plan writer. A plugin hook runs in Claude Code's process,
  outside the kernel sandbox, with the checkout as its working directory. A hook that runs `npx`, `node` or a bin
  resolved from that directory would run a lane-written `node_modules` or script, unsandboxed.
  - `wrapPlugin(installPath: string, into: string): { leftOut: LeftOut[] }` writes the wrapper:
    - **The manifest:** `.claude-plugin/plugin.json` is re-emitted from the zod-parsed original. It keeps `name`,
      `version` and `description`. It drops `mcpServers`, and drops `hooks`, `commands`, `agents` and `skills` when
      they are inline or path overrides, since the wrapper lays those out itself.
    - **Links:** a symlink to the original for every top-level entry except `.claude-plugin`, `.mcp.json` and
      `hooks`.
    - **`hooks/`:** a symlink to every file in the plugin's `hooks/` except `hooks.json`.
    - **`hooks/hooks.json`:** re-emitted from the parsed original. Every hook of `type: 'command'` becomes
      `cd "$CLAUDE_PLUGIN_ROOT" && <command>`. Other hook types are kept as written.
    - A `hooks.json` that doesn't parse leaves the plugin's hooks out, listed.
  - `$CLAUDE_PLUGIN_ROOT` is the wrapper. Its links lead back to the install path, so a hook script found by that
    variable still runs.
  - **What this does not cover, stated plainly:** a hook can still read `cwd` or `CLAUDE_PROJECT_DIR` from its input
    or environment and run something in the checkout on purpose. That is the plugin's own code acting as the
    builder, which spec §6 (call 4) accepts. No SDK option lets 10db run plugin hooks inside the sandbox or move
    their working directory. The only full mitigation would be F2: no plugin hooks at all.
- `LaneProfileInput.setupReads: readonly string[]`. `buildLaneProfile` adds them to `allowRead` past the
  protected-read filter, but never past `secretFiles`, `toolchainSecrets` or `sandboxRoots`. In srt a more specific
  deny inside an allowed path still wins (srt README: "allowRead takes precedence over denyRead … a denyRead entry
  that is more specific … still stays denied"). They never go in `allowWrite`.
- `LaneSessionInput.setup?: SetupInput`; `LaneSession.setup: SessionSetup`. `forSession` does these steps in order:
  - It builds `refuse` from the session's `ProjectAccess`: `protectedReads`, `checkoutSecrets`, the toolchain
    secrets, `sandboxRoots`, and `writableRoots` plus the worktree root.
  - It runs `createSetupDir`.
  - It walks each read outside the setup dir with `secretFilesIn` (`project-access.ts`) and adds the `.env*` files
    to the profile's `secretFiles`, as the checkout's are.
  - It passes `setup.reads` as `setupReads` and puts the setup dir in `ownFiles`.
  - Only the lane profile gets them. The gate's (`gate-sandbox.ts`) and the repo MCP servers' (`mcp-sandbox.ts`)
    don't **(call: neither runs a skill)**.
- `LaneSandbox.judgeSetup(project, input: SetupInput): Promise<{ loaded; leftOut }>` runs `keepSetup` against the
  project's access and writes nothing. It is the preview Task 14 shows.

**Per provider:**

- **Claude (plan, API, Bedrock, gateway):** Claude Code's sandbox reads the profile, so its Bash can run a skill's
  scripts.
- **Codex:** `lanePermissions` (`sessions/codex-lane-permissions.ts:66-122`) turns `allowRead` into `read` entries.
  The collapse keeps the list short; Codex repeats every entry in its temp-dir rules
  (`codex-lane-permissions.ts:57-59`), and a long list outgrows macOS's sandbox compiler. Rows are in Tasks 7 and 13.

- [ ] **Step 1: Write the failing `setupReadRefusal` and `collapseReads` tables** in `setup-reads.test.ts`. They are
  pure and exhaustive (`.claude/rules/testing.md`, for the sandbox). Paths are under a temp home.

  Opens:
  - `a skill folder under ~/.claude/skills`
  - `a plugin install path under ~/.claude/plugins/cache`
  - `a folder two levels down in the home, holding nothing protected` (`~/Projects/skills/x`)
  - `a folder outside the home holding nothing protected`

  Refused:
  - `the home`
  - `an ancestor of the home`
  - `/`
  - `a top-level home folder` (`~/Documents`)
  - `~/.ssh`
  - `~/.aws/x`
  - `~/.config/gh`
  - `~/Library/Application Support/x`
  - `~/.claude itself`
  - `~/.claude/projects`
  - `the data dir`
  - `a folder holding ~/.claude.json`
  - `a folder inside a checkout`
  - `a folder that holds a checkout`
  - `the worktree root`
  - `a lane temp root`
  - `a folder holding a sandbox root`
  - `a checkout's .env file`

  `collapseReads`:
  - `drops a path under another`
  - `keeps siblings`
  - `deduplicates`
- [ ] **Step 2: Run it to see it fail.**
  Run: `pnpm --filter @10db/daemon exec vitest run src/sandbox/setup-reads.test.ts`
- [ ] **Step 3: Implement. Run it to see it pass. Commit** as
  `feat(daemon): judge which setup folders a lane sandbox may open`, with this value card:
  - `protects=` only skill and plugin folders open, never the home, credential folders, checkouts or sandbox roots
  - `fails_when=` a skill link to ~ or ~/.ssh, or into a checkout, is opened
  - `why_new=` no rule opens a path under a protected read today
  - `no_claim=` that the kernel honours it (Step 10)
- [ ] **Step 4: The profile field. Write the failing rows** in `profile.test.ts`:
  - `opens setup reads under a protected read, read-only` (`allowRead` holds them, `allowWrite` doesn't, and
    `denyRead` still holds `~/.claude`)
  - `keeps a secret file inside a setup read denied`

  Run the file to see them fail, implement, see them pass, and commit as
  `feat(daemon): the lane profile takes setup reads`, with a value card.
- [ ] **Step 5: The setup dir. Write the failing table** in `setup-dir.test.ts`:
  - `links each kept skill under yours/skills and writes the manifest`
  - `leaves out a skill whose folder the refusal names, with its sentence`
  - `leaves out a skill whose SKILL.md leads into a checkout`
  - `keeps a skill whose SKILL.md leads into another skill folder, and reads that folder`
  - `leaves out a plugin whose folder is gone`
  - `opens ~/.claude/skills whole when every child passes`
  - `200 skills and one refused link still open the root whole`
  - `opens the passing folders one by one when a real directory in the root is refused`
  - `leaves out a skill holding a folder that can't be listed, and does not throw`
  - `collapses link targets outside the roots`
  - `writes the project's copies under project/`
  - `remove() leaves nothing`

  Run the file to see it fail, implement `keepSetup` and `createSetupDir`, see it pass, and commit as
  `feat(daemon): write each session's setup dir from what the refusal keeps`, with a value card.
- [ ] **Step 5b: The plugin wrapper. Write the failing table** in `plugin-wrapper.test.ts` over a temp plugin:
  - `keeps the plugin's name and links its skills, agents and commands`
  - `leaves out .mcp.json and the manifest's mcpServers`
  - `starts every command hook in the plugin's folder`: the re-emitted command is
    `cd "$CLAUDE_PLUGIN_ROOT" && npx thing`.
  - `keeps the hook scripts reachable through CLAUDE_PLUGIN_ROOT`
  - `leaves out the hooks of a hooks.json that does not parse, and lists them`
  - `a command hook run from the wrapper with the checkout as cwd resolves npx from the plugin, not the checkout`.
    This one uses real processes: run the re-emitted command with `/bin/sh -c`, with `cwd` set to a temp checkout
    whose `node_modules/.bin/thing` writes a marker and `CLAUDE_PLUGIN_ROOT` set to the wrapper. Expect no marker.

  Run: `pnpm --filter @10db/daemon exec vitest run src/sandbox/plugin-wrapper.test.ts`. See it fail, implement
  `wrapPlugin` and use it in `createSetupDir`, see it pass, and commit as
  `feat(daemon): plugins come along through a wrapper whose hooks start in the plugin's folder`, with this value
  card:
  - `protects=` a plugin hook never resolves a program from the lane-writable checkout, and no plugin MCP server
    loads
  - `fails_when=` a command hook runs with the checkout as its working directory, or `.mcp.json` survives
  - `why_new=` plugins were passed by install path
  - `no_claim=` a hook that cds into the checkout on purpose (accepted, spec §6 call 4)
- [ ] **Step 6: The wiring. Write the failing rows** in `lane-sandbox.test.ts`:
  - `a session with a setup gets its plugin dirs, its reads in the profile and its setup dir in ownFiles`
  - `a .env file inside an opened skill folder stays denied`
  - `the gate and an MCP server get no setup reads`
  - `dispose removes the setup dir`
- [ ] **Step 7: Run them to see them fail,** then implement the `forSession` wiring and `LaneSandbox.judgeSetup`. Run
  `src/sandbox/lane-sandbox.test.ts` whole to see it pass, and commit as
  `feat(daemon): lane sessions open their setup reads and own their setup dir`, with a value card.
- [ ] **Step 8: The sweep.** Add one table row to `stale-files.test.ts`: `a 10db-setup dir of a dead daemon is
  swept, a live daemon's is kept`. Run it to see it fail, add the pattern, see it pass, and commit as
  `feat(daemon): sweep setup dirs a dead daemon left`.
- [ ] **Step 9: The real kernel. Write `test/setup-reads.seatbelt.test.ts`,** following
  `test/mcp-sandbox.seatbelt.test.ts`: the `SEATBELT` guard, srt from `resolveSandboxRuntime`, and the profile
  through `srtSettings`.
  - The fake home is a `realpathSync(mkdtempSync(...))` folder that no grant opens.
  - The test builds a real `createLaneSandbox` session with a `SetupInput` holding:
    - `s`, a skill folder in `<home>/.claude/skills/s` with a script;
    - `out`, a skill folder linked from outside the home;
    - `ssh`, a skill linked to `<home>/.ssh`, which holds `id`;
    - a plugin under `<home>/.claude/plugins/cache/m/p/1`.
  - Probes:

```ts
expect(results).toEqual({
  'read-skill': 'ok',               // cat <home>/.claude/skills/s/SKILL.md
  'run-skill-script': 'ok',         // sh <home>/.claude/skills/s/run.sh
  'read-linked-skill': 'ok',        // cat <outside>/SKILL.md through the link
  'read-plugin': 'ok',              // cat <plugin>/skills/x/SKILL.md
  'read-claude-settings': 'denied', // cat <home>/.claude/settings.json
  'read-claude-json': 'denied',     // cat <home>/.claude.json
  'read-ssh-link': 'denied',        // cat <home>/.claude/skills/ssh/id
  'list-claude': 'denied',          // ls <home>/.claude
  'write-skill': 'denied',          // touch <home>/.claude/skills/s/x
  'read-skill-env': 'denied',       // cat <home>/.claude/skills/s/.env
  'read-setup-dir': 'ok',           // cat <setupDir>/yours/skills/s/SKILL.md
  'write-setup-dir': 'denied',      // touch <setupDir>/yours/x
});
```

  - A second case, `about 200 skills keep the profile small and every command runs` (Review Focus 5):
    - 200 folders under `<home>/.claude/skills` and 20 links to folders outside the home.
    - Expect at most 25 entries added by the setup, counting the `allowRead` entries and the `.env*` denies, against
      a session without the setup.
    - Expect `read-skill` `ok` for the first and the last folder.
  - Run: `pnpm --filter @10db/daemon exec vitest run test/setup-reads.seatbelt.test.ts`.
  - **Prove both directions red (finding 8):**
    - With Step 4's `buildLaneProfile` change reverted, `read-skill` is `denied`.
    - With `refuse` replaced by `() => null` in `forSession`, `read-ssh-link` is `ok`.

    Restore both. The commit names both mutations.
- [ ] **Step 10: Commit** as `test(daemon): the opened setup reads hold under seatbelt`, with this value card:
  - `protects=` the kernel reads opened skills and plugins and nothing beside them, at 200 skills too
  - `fails_when=` allow-inside-deny stops working, a deny inside a setup read is lost, or a refused link opens
  - `why_new=` profile.test checks the lists, not the kernel
  - `no_claim=` Claude Code's embedded sandbox and Codex's (Task 15 and Task 13 live rows)

---

### Task 7: The file tools and the guard read the opened folders; Codex's profile carries them

**Files:**

- Modify: `apps/daemon/src/sandbox/file-access.ts:14-42` (`FileAccessContext.setupReads`) and `:283-299`
  (`judgeRead`); `file-access.test.ts`
- Modify: `apps/daemon/src/sandbox/beside-the-way.ts`: add `besideTheWays(root, targets)`, which keeps every target
  and its ancestors.
- Modify: `apps/daemon/src/sandbox/lane-sandbox.ts`:
  - `:354-384`, `deniedToFileTools` takes the pictures and the collapsed setup reads;
  - `:388-405`, `fileAccess.setupReads`.
- Modify: `lane-sandbox.test.ts`
- Modify: `apps/daemon/src/shape/confinement.ts:49-74` (`ShapeAccess.setupReads`) and `:182-194`
  (`fileAccessContext`); `confinement.test.ts`
- Create: `apps/daemon/src/sessions/codex-lane-permissions.test.ts`

**Interfaces:**

- `FileAccessContext.setupReads?: readonly string[]`. In `judgeRead`, after the secret-file check and before the
  protected roots, a real path at or under one of them is `'allowed'`. A tree search under one is allowed too, since
  Task 6 refused any setup read that holds a protected path.
- `besideTheWays(root: string, targets: readonly string[]): string[]`.
- `ShapeAccess.setupReads?: readonly string[]`, passed through `fileAccessContext`.

**Per provider:**

- **Claude:** the file tools' `disallowedTools` `Read(...)` rules and the guard's judge both let the setup reads
  through.
- **Codex:** there is no file tool. The test below covers `lanePermissions`.
- **Plan** (Claude only): through `ShapeAccess`.

- [ ] **Step 1: Write the failing rows.**
  - `file-access.test.ts`, in the `readAccess` table:
    - `a file in a setup read under ~/.claude is allowed`
    - `a file beside it in ~/.claude is protected`
    - `a link from a setup read to ~/.claude.json is protected`
  - `lane-sandbox.test.ts`: `keeps the file tools off ~/.claude but for the setup reads`.
  - `confinement.test.ts`: `a Plan session reads a setup read and nothing beside it`.
  - `codex-lane-permissions.test.ts` (pure, over a temp home):
    - `lanePermissions opens a setup read under a denied root and keeps the root denied`;
    - `a collapsed setup of 200 skills adds at most 25 entries`.
- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm --filter @10db/daemon exec vitest run src/sandbox/file-access.test.ts src/sandbox/lane-sandbox.test.ts src/shape/confinement.test.ts src/sessions/codex-lane-permissions.test.ts`

  The Codex rows pass before the change, because `filesystemOf` already keeps the more specific entry. Prove them red
  with a one-line mutation: `put(realOrSelf(path), 'deny')` for every `allowRead` entry under a deny root. Revert it,
  and name it in the commit.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to see them pass.**
- [ ] **Step 5: Commit** as `feat(daemon): the file tools and the guard read the opened setup folders`, with a value
  card.

---

### Task 8: Live check of plugin hooks and plugin MCP servers, before any plugin reaches a session

This must run before Task 9. It records A4, M1 and the hook working directory in the research notes. Its outcome
decides F2.

**Files:**

- Modify: `docs/architecture/research/2026-11-12-trust-line-research.md`: a new subsection, "L3b: plugin hooks against
  10db's guard, and plugin MCP servers".

**Steps:**

- [ ] **Step 1: Run A4** in a plain Mac session, with the pinned Claude Code (`~/Library/Application Support/10db/tools/`)
  and a scratch project. Use `claude -p --setting-sources '' --strict-mcp-config --plugin-dir <scratch plugin>`,
  with an SDK-callback `PreToolUse` standing in for 10db's guard through a small `query()` script.
  - The scratch plugin's `hooks/hooks.json` holds a `PreToolUse` command hook answering
    `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}` for every call.
  - (a) 10db's hook answers `deny` for `Bash(touch denied)`. Pass if the file is not made.
  - (b) 10db's hook answers `ask`. Pass if `canUseTool` is still called.
  - (c) The plugin hook answers `allow` with `updatedInput` changing `touch a` to `touch b`, after 10db's hook
    allowed `touch a`. Record which file is made. Pass if `b` is never made without 10db's hook having seen it.
  - Outcome: if (a), (b) and (c) all pass, plugins load whole. If any fails, run **F2** after Task 9.
- [ ] **Step 2: Run M1.** Use a scratch plugin with a `.mcp.json` declaring one stdio server that writes a marker
  file when it starts. Load it by its own `installPath` with `strictMcpConfig: true` through `query()`, then again
  through Task 6's wrapper. Record both runs. The wrapper run must leave no marker; that is the test of the wrapper
  against the real CLI. The first run shows only whether `strictMcpConfig` alone would have kept the servers out.
  10db relies on the wrapper either way.
- [ ] **Step 3: Run the hook-cwd check.** Use a scratch plugin whose `SessionStart` command hook is `npx thing`, and
  a scratch checkout whose `node_modules/.bin/thing` writes a marker. Load the plugin through the wrapper. Expect no
  marker in the checkout, and record the result.
- [ ] **Step 4: Commit the research notes** as `docs: live check of plugin hooks, plugin mcp servers and hook cwd`.

**Per provider:** Claude only. Codex has no plugin format, and the builder's MCP servers on Codex are T6.

---

### Task 9: Claude sessions take the instructions and the plugin dirs

**Files:**

- Modify: `apps/daemon/src/sessions/types.ts:49-95` (`SessionSpec`) and `:137-185` (`ShapeSessionSpec`)
- Modify: `apps/daemon/src/sessions/claude-adapter.ts:292-388` (`buildQueryOptions`); `claude-adapter.test.ts`
  (`describe('buildQueryOptions')`, `:336`)
- Modify: `apps/daemon/src/sessions/claude-shape.ts:75-212` (`shapeOptions`); `claude-shape.test.ts`

**Interfaces:**

- `SessionSpec` and `ShapeSessionSpec` gain:
  - `readonly instructions?: string | null`;
  - `readonly setup?: { readonly plugins: readonly string[]; readonly skillRoots: readonly string[] }`.
- `buildQueryOptions`:
  - `plugins: [{ type: 'local', path: deps.pluginDir }, ...(spec.setup?.plugins ?? []).map((path) => ({ type: 'local', path }))]`,
    with the harness first.
  - **The base prompt stays what it is today** (ruling on finding 6). Today a lane sends no `systemPrompt`, which
    SDK 0.3.316 turns into the empty custom prompt `""` (`sdk.mjs`, the options mapper: `if (i === void 0) f = ""`).
    With instructions, a lane sends `systemPrompt: { type: 'custom', prompt: spec.instructions }`: still a custom
    prompt, now holding only the instructions. Without instructions, it sends no `systemPrompt` key, as today. A
    lane never gets the `claude_code` preset in T2.
  - `SKILL_NAMES_LINE`, appended to the instructions only when `spec.setup.plugins` is non-empty:
    `Skills here are named <plugin>:<name>: the builder's own are yours:<name>, the project's are project:<name>. A
    skill your instructions name without a prefix is that skill.` (finding 10, L3). Plan adds the same line under the
    same condition. Codex never gets it, because its skills aren't prefixed.
- `shapeOptions`: Plan keeps the preset. `append` becomes `spec.instructions ? \`${spec.systemPrompt}\n\n${spec.instructions}\` : spec.systemPrompt`,
  and `plugins` comes from `spec.setup?.plugins`, absent when empty. Plan still has no harness.

**Per provider:** Claude plan, API, Bedrock and gateway alike. Codex is Task 13.

- [ ] **Step 1: Write the failing rows.**

  In `describe('buildQueryOptions')`:
  - `passes the setup's plugin dirs after the harness`
  - `puts a lane's instructions in its custom prompt, never the preset`
  - `sends no system prompt when there are no instructions` (pins today's base)
  - `adds the skill-name line only when there are plugin dirs`

  In `claude-shape.test.ts`:
  - `appends the instructions after Shape's own prompt, on the preset`
  - `passes the setup's plugin dirs and no harness`
- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/claude-adapter.test.ts src/sessions/claude-shape.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to see them pass.**
- [ ] **Step 5: Commit** as `feat(daemon): claude sessions take the instructions and plugin dirs they are given`,
  with a value card. Its `no_claim=` is "that the model follows them".

---

### Task 10: Lanes and passes start with their setup

**Files:**

- Modify: `apps/daemon/src/runner/runner.ts`:
  - `:310`: `RunnerOptions.builderHome: string` and `RunnerOptions.laneWritableRoots: readonly string[]` (finding 15);
  - before `:2033`: `trustSwitchesFor(db, project.id)` and `planSessionSetup`, with `laneWritable` set to
    `[...allCheckouts(db), opts.worktreeRoot, ...opts.laneWritableRoots]`;
  - `:2033-2044`: pass `setup: plan.input` to `forSession`;
  - `:2062`: append `leftOutNote([...plan.leftOut, ...laneSession.setup.leftOut])` beside `mcpNote`, and log the same
    list as `session setup left out`;
  - `:2335-2350`: `instructions: plan.instructions.text` and
    `setup: { plugins: laneSession.setup.pluginDirs, skillRoots: laneSession.setup.skillRoots }`.
- Modify: `apps/daemon/src/daemon/start.ts`. Pass `builderHome: homedir()` and
  `laneWritableRoots: allSandboxRootsOf(sandboxRoots)`, the lane temp roots, from `:1320`.
- Modify: `apps/daemon/test/engine.ts`: `createTestEngine` passes a temp home and the probe's roots.
- Modify: `apps/daemon/src/briefing/prompts.ts`:
  - `:38-80`: `PromptInput.instructionsLoaded?: boolean` and `PromptInput.setupLine?: string | null`;
  - `:243-249`: with `instructionsLoaded`, the line "Read the repository's agent instructions first…" becomes `The
    repository's agent instructions (AGENTS.md, CLAUDE.md, .claude/rules) and the builder's own are in your system
    prompt.`;
  - `setupLine`, when set, is one rule line: `Loaded for you: <n> of your skills, <plugins>, <n> project skills. Left
    out: <names>, see the note at the end.`
- Test: `apps/daemon/src/runner/runner.test.ts`, inside `describe('the processes a session’s commands start')` and
  its `sandboxProbe` (`:4700-4735`), whose `home` is a temp dir; `apps/daemon/src/briefing/briefing.test.ts`

**Interfaces:** this task consumes Tasks 1, 5, 6 and 9. Without a lane sandbox (`opts.laneSandbox` null, used only by
tests and the fake), there is no setup dir: `setup` is absent, and the instructions still go.

**Per provider:**

- **Claude:** `instructions` and `setup.plugins`.
- **Codex:** the same spec, read by its adapter as `instructions` and `setup.skillRoots` (Task 13). The briefing line
  changes for Codex too, which closes the "a lane spends a read on `AGENTS.md`" gap in `03-trust-boundaries.md`
  §4.13.

- [ ] **Step 1: Write the failing tests.**
  - `runner.test.ts`, `starts a lane with the project's instructions, the builder's skills and the setup reads in its
    profile`:
    - Write `<repo>/AGENTS.md` and `<probe.home>/.claude/skills/s/SKILL.md`, then launch.
    - `spec.instructions` contains the AGENTS text.
    - `spec.setup.plugins[0]` ends in `/yours`, and `readlinkSync(join(it, 'skills/s'))` is the skill folder.
    - `allowRead` contains `<home>/.claude/skills`, opened whole.
    - The prompt holds the instructions line and the `Loaded for you` line.
    - The setup dir is gone after the session ends.
  - `runner.test.ts`, `a switch flipped while a session runs applies from the next one` (Review Focus 3):
    - The first session waits on a signal. Run `setAppTrustSwitches` with `yourSkills: false`, release it, and run
      the next step.
    - The first spec has `skills/s`. The second has no `yours` dir.
  - `runner.test.ts`, `a skill link into a checkout is left out and named in the prompt and the log` (Review Focus 1).
  - `briefing.test.ts`: rows for the instructions line, on and off, and for the setup line.
- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm --filter @10db/daemon exec vitest run src/runner/runner.test.ts -t "instructions|switch flipped|left out" && pnpm --filter @10db/daemon exec vitest run src/briefing/briefing.test.ts`
- [ ] **Step 3: Implement the wiring.**
- [ ] **Step 4: Run them to see them pass, then run the whole runner file.**
  Run: `pnpm --filter @10db/daemon exec vitest run src/runner/runner.test.ts`
- [ ] **Step 5: Commit** as `feat(daemon): lanes and passes start with the project's and the builder's setup`, with
  one value card for the wiring and one for the switch-timing test.

---

### Task 11: Plan conversations start with their setup

**Files:**

- Modify: `apps/daemon/src/daemon/shape-session-tools.ts`: `:160-170` passes `setup` into `forSession`; `:215-226`
  returns `setup` beside `sandbox`.
- Modify: `apps/daemon/src/shape/service.ts`: at `:180-215` the ready type gains `setup: SessionSetup` and
  `instructions`; at `:1122-1145` the spec gets `instructions` and `setup`, and the access gets `setupReads`.
- Modify: `apps/daemon/src/shape/policy.ts`:
  - `:14-21`: add `'Skill'` to `SHAPE_BUILT_IN_TOOLS`;
  - `:58-70`: add `'Skill'` to `SHAPE_ALLOWED_TOOLS`;
  - `:182`: one sentence on skills.
- Modify: `apps/daemon/src/shape/confinement.ts:396-412`. `Skill` is allowed for the session, its code researchers
  and its reviewers. **The web researcher is refused it** (finding 20): it holds nothing of the project, and a project
  skill is project text.
- Test: `apps/daemon/src/shape/confinement.test.ts` and `apps/daemon/src/shape/service.test.ts`

**Interfaces:** Plan's sandbox deps gain `builderHome`. With no Plan sandbox (`ready.sandbox` null), only the
instructions go **(call: with no Bash a skill's scripts can't run, so no folder is opened)**.

**Calls:**

- **Web stays as it is in Plan.** The researcher keeps it until auto mode reaches Plan with T3 and Sessions M4b (spec
  §12).
- **A plugin's agents stay unlaunchable in Plan.** `judgeAgentType` (`confinement.ts:223-263`) launches only Plan's
  own agents until M4b.
- **Plugin `SessionStart` hooks run in Plan** as in lanes (spec §6, call 4). Their `additionalContext` reaches the
  session. Plan's system prompt stays the rule for what it may do: it still writes no code, and its confinement
  refuses every write whatever the context says.

**Per provider:** Plan runs only on Claude accounts (`BRAINSTORM_REFUSED_ON_CHATGPT`). It behaves the same on a plan,
the API, Bedrock and a gateway.

- [ ] **Step 1: Write the failing tests.**
  - `confinement.test.ts`: the rows `Skill is allowed in the session, a code researcher and a reviewer` and `Skill is
    refused to the web researcher`.
  - `service.test.ts`: `a Plan session starts with the instructions and the builder's skills`. Its spec has
    `instructions` and `setup.plugins`, `tools` contains `Skill`, and its access reads the skill folder.
- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm --filter @10db/daemon exec vitest run src/shape/confinement.test.ts src/shape/service.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to see them pass, then `src/shape` and `src/daemon` whole.**
- [ ] **Step 5: Commit** as `feat(daemon): plan conversations start with the project's and the builder's setup`, with
  a value card.

---

### Task 12: Claude lanes and passes on an auto-mode account use the web without a card

Today the guard sends every `WebSearch` and `WebFetch` to the broker, which cards it (`guard/pre-tool-use.ts:27-30`,
`:44-48`, `:116-125`; `briefing/prompts.ts:236-237`). In T2 the web turns on only where a native judge exists (spec
§12). That is Claude Code's auto mode, in a sandboxed lane, on any account kind but a gateway (L2 passed on the plan
and Bedrock; the gateway was not run).

**Files:**

- Create: `apps/daemon/src/sessions/native-judge.ts`, `native-judge.test.ts`; export them from `sessions/index.ts`
- Modify: `apps/daemon/src/guard/judge.ts:32-75`: `GuardInput.webJudged?: boolean`.
- Modify: `apps/daemon/src/guard/pre-tool-use.ts:116-125`: in `brokerAsk`, when `input.webJudged === true` and the
  tool is `WebSearch` or `WebFetch`, return null before `BROKER_JUDGES`.
- Modify: `apps/daemon/src/runner/runner.ts:2355-2385`: `judgePreToolUse` and `buildSessionPrompt` both get
  `webJudged: switches.web && nativeJudge(account.kind, laneMode)`.
- Modify: `apps/daemon/src/briefing/prompts.ts:236-237` (finding 12). With `webJudged`, the rule's last sentence
  becomes: `A dependency change, a loop with no end in the background and repo MCP tools wait on a card from the
  builder. WebSearch and WebFetch go to auto mode's judge, which refuses a fetch that would send the project's code
  or secrets out; if auto mode isn't running for your model, they wait on a card.`
- Test: `apps/daemon/src/guard/pre-tool-use.test.ts` (the table at `:100-135`),
  `apps/daemon/src/briefing/briefing.test.ts`, `apps/daemon/src/runner/runner.test.ts`

**Interfaces:**

- `nativeJudge(kind: SupportedAccountKind, mode: LanePermissionMode | null): boolean` is true only for
  `claude_subscription`, `anthropic_api_key` and `bedrock` in mode `'auto'`. It is the adapters' knowledge, kept in
  `sessions/`, and T3 replaces it with `capabilities.judge`.
- No `WebSearch` or `WebFetch` goes into `allowedTools`: an allow rule would settle a call before the classifier.

**Per provider:**

| Account | Web in a lane or pass |
| --- | --- |
| Claude plan, API or Bedrock, in auto mode | Judged by Claude Code's classifier, with no card. |
| The same with "Lanes decide routine permissions" off | A card, as today. |
| An unsupported model | Claude Code runs `default`, so the call reaches `canUseTool` and is carded. The prompt says so. |
| Claude gateway | A card, as today, until T5. Settings says so. |
| Codex | `web_search: 'disabled'` (`codex-home.ts:67`), unchanged until T5. Settings says so. |

With the Web switch off, the web is carded everywhere. It is not removed. Settings says so (Task 14).

- [ ] **Step 1: Write the failing rows.**
  - `native-judge.test.ts`: every kind in `auto` and in `default`.
  - `pre-tool-use.test.ts`:
    - `WebSearch, judged` gives `allow`;
    - `WebFetch, judged` gives `allow`;
    - `mcp__repo__x, judged` gives `ask`.
  - `briefing.test.ts`: two rows.
  - `runner.test.ts`:
    - `a gateway lane with web on still cards WebFetch`;
    - `a subscription lane in auto mode runs WebFetch without a card`.
- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/native-judge.test.ts src/guard/pre-tool-use.test.ts src/briefing/briefing.test.ts && pnpm --filter @10db/daemon exec vitest run src/runner/runner.test.ts -t "WebFetch"`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to see them pass.**
- [ ] **Step 5: Commit** as `feat(daemon): claude lanes in auto mode use the web without a card`, with this value card:
  - `protects=` the web goes to auto mode only where it runs, and is carded elsewhere
  - `fails_when=` a gateway or default-mode lane loses its web card
  - `why_new=` the pre-tool-use rows cover only the card
  - `no_claim=` what the classifier decides (L2)

---

### Task 13: Codex takes the instructions and the skills

L4 settled the channels: `skills/extraRoots/set`, one app-server request before the first turn, and
`developerInstructions`. Codex runs one app-server per session (`codex-session.ts:819`), so the roots belong to that
session.

**Files:**

- Modify: `apps/daemon/src/sessions/codex-session.ts`:
  - `:461-466`, the `startThread` params;
  - `:842-845`, a `skills/extraRoots/set` call after `checkGuardHook` and before `startThread`.
- Modify: `apps/daemon/src/sessions/codex-lane-config.ts:39-61`. When `spec.setup?.skillRoots` is non-empty,
  `codexThreadConfig` adds `skills: { include_instructions: true }`. `codex-home.ts:82` keeps `false` for every other
  thread.
- Modify: `apps/daemon/src/sessions/codex-protocol.ts`: the response schema.
- Test: `apps/daemon/src/sessions/codex-session.test.ts`, `apps/daemon/test/codex.live.test.ts`

**Interfaces:**

- `thread/start` gains `developerInstructions: spec.instructions` when it is set. `thread/resume` gains it too, if
  Step 1 shows its params take it. Otherwise a resumed thread keeps the instructions it started with, which matches
  "fixed at session start". Record the result in `03-trust-boundaries.md` §4.13.
- `ask('skills/extraRoots/set', { extraRoots: [...spec.setup.skillRoots] }, SkillsExtraRootsResponse)` runs when the
  list is non-empty. If Codex refuses it, the start ends `sandbox_refused` with `Codex refused the session's skill
  folders.` and no prompt is sent.

**Per provider:** Codex (ChatGPT plan) only.

- Plugins reach it as their `skills/` folders.
- Commands, agents and hooks don't reach it. They are follow-ups, and Settings says so.
- The web is unchanged.
- Same-named skills across roots: Codex lists each with its path. Codex has no namespacing, so this is a follow-up.

- [ ] **Step 1: Read the pinned protocol** in a plain Mac session. Use the pinned binary
  (`~/Library/Application Support/10db/tools/`; see `agent-pins.ts`) to run
  `codex app-server generate-json-schema --out "$TMPDIR/codex-schema"`, then run
  `grep -rl developerInstructions "$TMPDIR/codex-schema"` and `grep -rl extraRoots "$TMPDIR/codex-schema"`.

  Expected: `ThreadStartParams` names `developerInstructions`, and a `SkillsExtraRootsSetParams` exists. Also record
  whether `ThreadResumeParams` names `developerInstructions`, and whether thread config takes
  `skills.include_instructions`. If thread config doesn't take it, run F4 after this task.
- [ ] **Step 2: Write the failing rows** in `codex-session.test.ts`:
  - `passes the instructions as developer instructions on start` (and `on resume`, if Step 1 found the parameter)
  - `sets the session's skill roots before the thread starts`, with the method order
    `[…, 'hooks/list', 'skills/extraRoots/set', 'thread/start']`
  - `sets no roots and no skill instructions when the session has none`
  - `refuses the start when Codex refuses the roots, and sends no prompt`
- [ ] **Step 3: Run them to see them fail.**
  Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/codex-session.test.ts`
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run them to see them pass.**
- [ ] **Step 6: Add live rows** to `test/codex.live.test.ts`. They are manual and never run in CI.
  - `lists a builder skill linked into yours/skills and reads its SKILL.md, and still cannot read auth.json`. L4 tested
    real folders under a root; this tests a root of links (finding 17).
  - `runs node and git with about 200 skills in the setup` (Review Focus 5: Codex's sandbox still compiles).

  Run: `TENDB_LIVE_CODEX=1 pnpm --filter @10db/daemon exec vitest run test/codex.live.test.ts -t "skill"`.
  If the first row fails because Codex doesn't follow linked folders in an extra root, `createSetupDir` copies the
  kept builder skills for Codex instead. Use the Task 4 caps, add a row to `setup-dir.test.ts`, and commit that
  separately.
- [ ] **Step 7: Commit** as `feat(daemon): codex sessions take the instructions and the setup's skills`, with a value
  card.

---

### Task 14: Settings › Trust and the project's Trust

A vertical slice: routes, services and two sections, run against the real backend before review.

**Files:**

- Modify: `apps/daemon/src/api/services.ts:521`. Add:
  - `trustSettings(): TrustSettingsDto`;
  - `setTrustSwitches(s: TrustSwitches): TrustSettingsDto`;
  - `projectTrust(id: ProjectId): Promise<ProjectTrustDto>`;
  - `setProjectTrust(id, o: TrustOverrides): Promise<ProjectTrustDto>`.
- Modify: `apps/daemon/src/api/app.ts:1408-1413`. Add `GET|PUT /settings/trust` and `GET|PUT /projects/:projectId/trust`,
  following the `shape-jev` routes (`:358-368`), with each body parsed by its schema.
- Modify: `apps/daemon/src/daemon/services.ts:612-617`.
  - `trustSettings` lists `readInstalledPlugins(deps.builderHome)`, the same injected home the runner uses (finding
    14), with `on = switches.plugins[id] ?? enabledInClaude`. An `InstalledPluginsError` gives an empty list.
  - `projectTrust` adds `preview`: `planSessionSetup` for the project's checkout, then `laneSandbox.judgeSetup` for
    the refusals. With no sandbox, the preview is the plan alone.
- Modify: `apps/daemon/src/daemon/start.ts` (`builderHome` in the services deps)
- Create: `apps/daemon/test/trust-api.test.ts`. Use the `lane-permissions-api.test.ts` harness with a temp home that
  holds one installed plugin and one skill, through `builderHome`.
- Modify: `apps/desktop/src/daemon/queries.ts`: add `useTrust`, `useSetTrust`, `useProjectTrust` and
  `useSetProjectTrust`.
- Modify: `apps/desktop/src/views/settings/sections.ts`: add `Trust: 'trust'` (Global, labelled "Trust") and
  `ProjectTrust: 'project-trust'` (Project, labelled "Trust"). Then `settings-nav.tsx` (icons) and
  `settings-view.tsx` (routes).
- Create in `apps/desktop/src/views/settings/`: `trust-section.tsx`, `trust-section.test.tsx`,
  `project-trust-section.tsx`, `project-trust-section.test.tsx`, `trust-rows.ts`
- Modify: `apps/desktop/AGENTS.md` (the settings sections list)

**Interfaces:**

- `trust-rows.ts` exports `TRUST_ROWS`, one entry per key in `TRUST_SWITCH_KEYS`: `{ key, label, description, providers }`.
  The labels are spec §9's: "Web", "Your instructions", "Your skills", "Your plugins", "Project instructions", and
  "Project skills, commands and agents".
- The exact `providers` copy:
  - **Web:** `On: Claude in auto mode judges each search and fetch, with no card. Claude through a gateway, and
    Codex, still card it until 10db's judge comes. Off: every search and fetch waits on a card.`
  - **Your plugins:** `Claude: skills, agents, commands and hooks; their MCP servers wait for 10db's support for your
    MCP servers. Their hooks start in the plugin's own folder. Codex: skills only.` Use the F2 wording instead if
    F2 ran.
  - **Your skills:** `A skill kept directly in your home (~/x), under a hidden folder (~/.something) or in a project
    folder is left out; Comes along says why.`
  - **Project skills, commands and agents:** `Codex: skills only.`
- Every row's description ends `Applies from the next session.`
- Settings › Trust shows one `Switch` per row, then the installed plugins, each with a `Switch` and its version. A
  plugin that is off in Claude Code shows "Off in Claude Code" until the builder switches it here.
- The project's Trust shows one `SegmentedControl` per row and per plugin (`As app` / `On` / `Off`). "As app" removes
  the key from the overrides.
- It then shows a read-only **Comes along** list from `preview`: the skills and plugins that would load into the
  project's next session, and each left-out item with its reason (finding 11).

**Per provider:** every row shows its per-provider note. What each switch does per provider is in Tasks 10 to 13.

- [ ] **Step 1: Write the failing tests.**
  - `trust-api.test.ts`:
    - `starts with every switch on and lists the installed plugin with its Claude state`
    - `keeps the switches the builder sets`
    - `a project's override shows in its effective switches and not in another project's`
    - `the project's preview lists the skill, and a skill linked into a checkout as left out with its reason`
    - `refuses a body that is not the shape with 400`
  - `trust-section.test.tsx` (msw, `renderApp('/settings/trust')`):
    - `shows every row on, with its per-provider note, and sends a change`
    - `lists a plugin off in Claude Code as off, and switches it`
  - `project-trust-section.test.tsx`:
    - `As app clears the override; Off sends web: false`
    - `lists what comes along and what was left out, with reasons`
- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm --filter @10db/daemon exec vitest run test/trust-api.test.ts && pnpm exec vitest run --project desktop apps/desktop/src/views/settings/trust-section.test.tsx apps/desktop/src/views/settings/project-trust-section.test.tsx`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to see them pass, then typecheck, lint and knip.**
  Run: `pnpm --filter @10db/daemon typecheck && pnpm --filter @10db/desktop typecheck && pnpm exec eslint --max-warnings=0 apps/daemon/src/api apps/daemon/src/daemon apps/desktop/src/views/settings && pnpm knip`
- [ ] **Step 5: Run it before review.** Run `pnpm dev`, and with `/browse` open Settings › Trust and a project's
  Trust.
  - The Comes along list matches `~/.claude/skills`.
  - Turn "Your skills" off for the project and start a task. Its prompt's `Loaded for you` line names no skill of
    yours, and the daemon log's session line has no `yours` dir.
  - Set it back to "As app". The next task has your skills again.
  - The console shows no errors.
- [ ] **Step 6: Commit** as `feat(desktop): settings › trust switches what comes along, with a per-project override`.
  Include the daemon routes and services, and value cards for the API contract, the preview and the two sections.

---

### Task 15: The threat model, the rules, follow-ups, and the adversarial review

**Files:**

- Modify: `docs/architecture/03-trust-boundaries.md`:
  - **§4.3** "Settings" and "Built, for every lane": the instructions in a lane's custom prompt and Plan's preset
    append; the setup's plugin dirs; plugin hooks running in Claude Code's process, outside the kernel sandbox (spec
    §6, call 4); plugin MCP servers out until T6 (Task 8's outcome); and the web judged in auto mode. Also the tool
    table row for WebFetch and WebSearch (`:203`).
  - **§4.4:** the setup reads, the collapse, what `setupReadRefusal` refuses, and the `.env*` denies inside them.
    Also the plugin wrapper, and its hooks starting in the plugin's folder.
  - **§4.13:** developer instructions, `skills/extraRoots/set`, and Task 13's resume finding. Remove the `AGENTS.md`
    read from "Known gaps".
  - **§4.14:** Plan's `Skill` (not the researcher's) and its setup.
  - **§6:**
    - R3: setup reads open read-only;
    - R4: the file tools follow them;
    - R7: repo definitions are re-emitted from an allowlist, without `` !`…` `` lines.
  - **§7, "Known and accepted":**
    - the builder's plugin hooks run unsandboxed;
    - a builder skill can read what its folder holds;
    - a skill kept directly at `~/x`, under a dot folder of the home or in a project folder is refused, with the
      reason shown in Settings › Trust › Comes along;
    - a plugin hook can still act on the checkout on purpose (through `cwd` or `CLAUDE_PROJECT_DIR`), outside the
      sandbox. The wrapper only stops a working-directory resolution it didn't ask for;
    - a `besideTheWays` list is a snapshot for the file tools only, with the guard and the kernel behind it;
    - **skills that write under the home or need hosts the project doesn't list fail in the sandbox** (for example
      `~/.gstack`, `browse`). The builder sees the failure only through the agent's handoff, until T4's skip list.
      This is finding 11's recorded gap.
- Modify: `apps/daemon/AGENTS.md`:
  - The security rule names its exceptions, each of which the builder installed: plugin hooks, and the builder's
    skills and plugins read by Claude Code.
  - A `sandbox/` sentence for the setup reads and the setup dir.
- Modify: `apps/daemon/test/lane-sandbox.live.test.ts`: a canary row, `reads an opened skill and none of ~/.claude
  beside it, with Claude Code's own sandbox`. It is manual and never runs in CI.

**Follow-up tasks** (spec parity: the feature runs everywhere and says what it lacks):

1. Codex: project commands and agents, and plugin agents, commands and hooks.
2. The web for gateway Claude and for Codex (T5).
3. Namespacing same-named skills across Codex roots.
4. Plan's own web and plugin agents in Plan (T3 / Sessions M4b).
5. Plan on a ChatGPT account (it is refused today; the Sessions plans own it).
6. Your MCP servers, plugin servers included (T6).

**Steps:**

- [ ] **Step 1: Write the docs. Commit** them as `docs: the trust boundaries after setup comes along`.
- [ ] **Step 2: Run the live row by hand.**
  Run: `TENDB_LIVE_CLAUDE=1 pnpm --filter @10db/daemon exec vitest run test/lane-sandbox.live.test.ts -t "opened skill"`.
  Expected: PASS. Record the result in the PR body.
- [ ] **Step 3: File the follow-ups** as 10db tasks with the `10db-task` skill, one per item above, and name them in
  the PR body.
- [ ] **Step 4: Dispatch the adversarial review** to the `code-reviewer` agent (opus). Give it this plan, Tasks 4, 6,
  7, 8, 9 and 13, and the base commit, and tell it which round it is. It returns findings and edits nothing. The
  attack list:
  1. A link anywhere in `~/.claude/skills`, `~/.agents/skills`, a plugin's install path or the project's `.claude/`
     that opens something `setupReadRefusal` should refuse: `~`, `~/.ssh`, a checkout, a sandbox root, or a link
     that changes after the check.
  2. A root opened whole: a child added mid-session that the kernel then reads.
  3. A lane-written definition that reaches Claude Code with power after the copy:
     - a key on the allowlist that runs code or widens permissions;
     - YAML tricks (merge keys, tags, anchors);
     - a race between the real-path check and the open;
     - `` !`…` `` written another way.
  4. Plugin hooks, against Task 8's recorded outcome.
  5. Plugin MCP servers, against Task 8's recorded outcome.
  6. The setup dir: can a lane write it, swap it, or read another session's? Does the sweep remove a live daemon's?
  7. Claude Code's file-tool rules: a `besideTheWays` list that leaves a credential readable through `Read`.
  8. Codex: an extra root that makes app-server read a lane-writable file.
  9. Plugin hooks run outside the kernel sandbox with the checkout as their working directory. Look for any way a
     wrapped hook still runs a lane-written `node_modules`, script or bin:
     - `PATH` entries;
     - `npm`'s prefix lookup;
     - a hook type other than `command`;
     - a hook whose script itself `cd`s to `CLAUDE_PROJECT_DIR`;
     - a manifest path override the wrapper missed.
- [ ] **Step 5: Fix each blocking finding** as its own red-first commit. Blocking means critical, data-loss,
  stuck-state, security, a broken rule, or a user-visible spec finding. The rest become follow-up tasks. A second
  round checks only those findings and what the fixes broke, with at most two fix rounds.

---

### Fallback F2 (Task 8's A4 fails): plugins come along without their hooks

**Trigger:** a plugin's `PreToolUse` answer overrides 10db's `deny` or `ask`, or applies an `updatedInput` the guard
never judged.

- `wrapPlugin` stops writing `hooks/`, so the wrapper carries no hooks at all. Everything else is as in Task 6.
- Settings' "Your plugins" note becomes: `Skills, agents and commands; plugin hooks don't run in 10db sessions yet.`
  Hooks join the follow-ups.
- Files: `plugin-wrapper.ts`, `plugin-wrapper.test.ts` (row: `no hooks dir`), and `trust-rows.ts`. One commit with a
  value card.

### Fallback F4 (Task 13 Step 1: thread config can't set `skills.include_instructions`)

- `codex-home.ts:82` sets `skills: { include_instructions: true }` in the account template, and Task 13's per-thread
  key is removed.
- A thread with no extra roots then lists only Codex's own system skills. Record that in `03-trust-boundaries.md`
  §4.13.
- Files: `codex-home.ts`, `codex-home.test.ts`. One commit.
