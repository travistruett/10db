# 10db Lane Sandbox, Slice 1, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Behind `TENDB_LANE_SANDBOX=on`, a lane's Bash runs under Claude Code's Seatbelt sandbox with a deny-`/` read policy, its own temp directory and no login credentials. The broker then stops asking about ordinary commands: cards remain for hazards, new network hosts and file-tool reads outside the checkout.

**Architecture:**

- **A new `sandbox/` module** in `apps/daemon/src`, on the first layer beside `guard` and `permissions` (it imports `guard` for path resolution and nothing above it). It builds the lane profile from one source: the protected reads, the toolchain reads and the project's additions. It validates the profile against a strict schema, makes the per-session temp directory and decides file-tool access on real paths. It never imports the SDK. The adapter maps its plain object onto `Options.sandbox`.
- **The runner asks a `LaneSandbox` factory** (injected; `null` when the switch is off) for a `LaneSandboxSpec` per session. The spec is the sandbox settings, extra env, `disallowedTools`, `ask` rules and the temp directory, and it goes on `SessionSpec.sandbox`. A profile or temp-dir failure refuses the session with a card that says why (`SessionEndReason.SandboxRefused` → the `refused` outcome).
- **A sandboxed session loads no repo settings and never runs in auto mode.** `settingSources` becomes `[]`
  (D4), so a lane-written `.claude/settings.json` can't add a hook, an allow rule or a sandbox block, and the
  briefing points the lane at the repo's agent instructions instead. `permissionMode` is `default` whatever
  `TENDB_LANE_PERMISSION_MODE` says: auto mode's classifier would decide reads outside the checkout in place of
  the broker, and with the sandbox on, ordinary Bash no longer cards, which was auto mode's reason.
- **The broker and the guard** get a `FileAccessContext` (checkout, protected reads, read list, own tool-results directory). The guard refuses protected real paths and `.git/` writes before Claude Code's rules apply. The broker allows sandboxed Bash unless the guard's hazard rules match. It denies unlisted hosts at once and records each on a non-blocking card, and it decides reads outside the checkout on the real path.

**Tech Stack:** TypeScript (Node 26), zod 4, vitest, `@anthropic-ai/claude-agent-sdk` 0.3.300 (types only outside `sessions/claude-adapter.ts`), Claude Code 2.1.310. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-25-10db-lane-sandbox-design.md` (D1, D2, D3, D4 for sandboxed sessions, D5 for Bash children, D8, D14, D15). The facts it rests on are `docs/architecture/research/spike-13-sandbox.md` and `docs/architecture/research/spike-14-sandbox-policy.md`. Threat model: `docs/architecture/03-trust-boundaries.md`.

**Built on:** `main` at `162a6f8` (PR #63: `TENDB_LANE_PERMISSION_MODE`, escalated calls always card). `feat/accounts` is not merged. Where this plan names an account config directory, it means the login shell's `CLAUDE_CONFIG_DIR` and `~/.claude`. The accounts merge adds each account's directory to `protectedReads`' input.

## Travis's decisions

| #   | Question                         | Decided                                                                                                                         |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Cards (D3)                       | Hazards and new hosts only.                                                                                                     |
| 2   | Read policy (D2)                 | Deny user data, allow named paths. Spike 14 showed deny `/` works, so the profile uses it.                                     |
| 3   | Lane temp (D14)                  | Isolated per session. Spike 14: `CLAUDE_CODE_TMPDIR` of at most 44 bytes moves Bash's `TMPDIR`. Without isolation, hold the sandbox. |
| 4   | Dependency installs (check 9)    | Per-project caches, never the shared ones.                                                                                      |
| 5   | Loopback (D15)                   | Off by default; `TENDB_LANE_SANDBOX_LOOPBACK=on` for 10db's own dogfood.                                                        |
| 6   | `.env*` (D16)                    | Denied in every profile.                                                                                                        |

## Global Constraints

- Code style and testing rules: `.claude/rules/code-style.md`, `.claude/rules/testing.md`, `apps/daemon/AGENTS.md`. Constants are `as const` objects; errors are named `Error` subclasses; zod at boundaries; no `as` casts outside a validated boundary.
- Only `sessions/claude-*.ts` import the SDK, and only `claude-adapter.ts` at runtime. `sandbox/` defines its own `LaneSandboxSettings` type with the SDK's field names, structurally assignable to the SDK's `SandboxSettings`; `sessions/types.ts` imports that type from `../sandbox` (`sessions` sits above the first layer). No `as` cast.
- Tests run on CI's Linux gate too (`.claude/rules/testing.md`). Every function that touches `/private/tmp` takes its root as a parameter and tests pass a temp root; rows that depend on APFS case folding or Unicode normalization use `it.skipIf(process.platform !== 'darwin')`, and the comparison folds by the `CASE_INSENSITIVE` constant in `guard/paths.ts`, not by platform name inline.
- `src/env.ts` is the only env parser. New variables: `TENDB_LANE_SANDBOX` (`on` | `off`, default `off`), `TENDB_LANE_SANDBOX_LOOPBACK` (`on` | `off`, default `off`). Both go in `apps/daemon/.env.example` with a comment.
- With the switch off, nothing a session gets changes: the same `allowedTools`, env, settings and broker answers as on `main`. Every task keeps the existing tests green unchanged.
- Base sandbox fields, exactly: `enabled: true`, `failIfUnavailable: true`, `allowUnsandboxedCommands: false`, `allowAppleEvents: false`, `autoAllowBashIfSandboxed: false`.
- The lane temp directory path is at most 44 bytes (`Buffer.byteLength`), under `/private/tmp`, mode `0700`, created per session and removed when the session ends.
- No schema change. "Always allow this host" is a `permission_rules` row with `toolName: 'SandboxNetworkAccess'` and the host as `pattern`; "always allow this path" is a row with `toolName: 'Read'` and the real path as `pattern`.
- The profile names no regular expression or glob in any sandbox field: an invalid sandbox value makes Claude Code drop the whole sandbox without an error (spike 14 check 11).
- Tests use real temp directories, real symlinks and real `app.request()`; the only model boundary is the fake adapter. Test red first, every row. No sleeps. Every git call in test code passes an isolated env.
- Commits: Conventional Commits, scope `daemon` or `docs`, header ≤ 100 chars, body lines ≤ 100, explicit paths in `git add`, footer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A checkout path with a link in it** (`~/Projects` itself a link, or the repo opened through one). Profile paths and the file-access judge must use the checkout's real path, or `allowRead` misses and every command fails. Task 2 has a row that builds from a linked checkout and expects the real path in `allowRead`.
2. **A session that resumes or restarts** must get a fresh temp directory and leave none behind. A crash between creating and starting must not leak one either. Task 8 has a row where the adapter throws on start and expects the directory gone.
3. **An unlisted host asked twice in one session** must raise one card, not two. Answering "allow once" must let exactly the next request for that host through. Task 7 has both rows.
4. **A Read outside the checkout with `~` or a relative path** (`../other/x`, `~/.ssh/id_rsa`) is judged on the expanded real path, never on its text. Task 4 has both rows.
5. **Case and Unicode spellings of a protected path** (`~/.CLAUDE.json`, a decomposed `é` in a project path) are refused like the canonical spelling. Task 4 has both rows.

---

### Task 1: The switches

**Files:**

- Modify: `apps/daemon/src/env.ts`, `apps/daemon/.env.example`
- Test: `apps/daemon/src/env.test.ts`

**Interfaces:**

- Produces: `export const Switch = { On: 'on', Off: 'off' } as const` and `type Switch`, from `env.ts`. `DaemonEnv` gains `TENDB_LANE_SANDBOX: Switch` and `TENDB_LANE_SANDBOX_LOOPBACK: Switch`, both defaulting to `'off'`.

- [ ] **Step 1: Write the failing tests.** In `env.test.ts`, as table rows: unset → both `'off'`; `on`/`off` round-trip; `TENDB_LANE_SANDBOX=yes` throws `EnvError` whose `issues` include `TENDB_LANE_SANDBOX: invalid_value` and never the value.
- [ ] **Step 2: Run** `pnpm --filter @10db/daemon exec vitest run src/env.test.ts`. Expected: FAIL (unknown keys stripped, defaults missing).
- [ ] **Step 3: Implement.** Add both to `DaemonEnv` with `z.enum(Switch).default(Switch.Off)` and a comment each. `.env.example`: `TENDB_LANE_SANDBOX=` (Bash runs under Claude Code's sandbox; cards only for hazards and new hosts) and `TENDB_LANE_SANDBOX_LOOPBACK=` (lets sandboxed commands bind and connect on localhost; opens every local port to the lane).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): add the lane sandbox switches` with `apps/daemon/src/env.ts apps/daemon/src/env.test.ts apps/daemon/.env.example`.

### Task 2: The lane profile

**Files:**

- Create: `apps/daemon/src/sandbox/profile.ts`, `apps/daemon/src/sandbox/protected-reads.ts`, `apps/daemon/src/sandbox/env-allowlist.ts`, `apps/daemon/src/sandbox/index.ts`
- Test: `apps/daemon/src/sandbox/profile.test.ts`, `apps/daemon/src/sandbox/env-allowlist.test.ts`
- Modify: `apps/daemon/AGENTS.md` (module list: `sandbox` on the first layer; one bullet on what it owns)

**Interfaces:**

- Produces (all from `sandbox/index.ts`):
  - `type LaneSandboxSettings`: a plain object with the SDK field names: `enabled`, `failIfUnavailable`, `allowUnsandboxedCommands`, `allowAppleEvents`, `autoAllowBashIfSandboxed`, `filesystem: { denyRead, allowRead, allowWrite }`, `network: { allowedDomains, allowLocalBinding?, allowMachLookup, allowUnixSockets }`, `credentials: { envVars: { name: string; mode: 'deny' }[] }`.
  - `const LaneSandboxSettingsSchema`: zod `strictObject` of exactly that shape. Every path is absolute, with no `*`, `?`, `[`, `{` or newline; every domain matches `^(\*\.)?[a-z0-9.-]+$`; every env name matches `^[A-Za-z_][A-Za-z0-9_]*$`.
  - `interface LaneProfileInput { checkout: string; tmpDir: string; home: string; protectedReads: readonly string[]; secretFiles: readonly string[]; toolchainReads: readonly string[]; packageCacheDir: string; allowedDomains: readonly string[]; readList: readonly string[]; loopback: boolean; deniedEnvNames: readonly string[] }`
  - `function buildLaneProfile(input: LaneProfileInput): LaneSandboxSettings`: validates with the schema and throws `SandboxProfileError` (name `SandboxProfileError`, message names the field, never a value it can't print).
  - `function protectedReads(input: { home: string; dataDir: string; configDirs: readonly string[] }): string[]`: `dataDir`, each config dir, `~/.claude`, `~/.claude.json`, `~/Library/Keychains` and `/usr/bin/security`, all absolute and deduplicated.
  - `function toolchainReads(home: string, path: string): string[]`: the fixed list from spike 14 check 5 (`~/.local/share/mise`, `~/.config/mise`, `~/.local/state/mise`, `~/.cache/mise`, `~/Library/pnpm`, `~/Library/Caches/pnpm`, `~/Library/Preferences/pnpm`, `~/.cargo`, `~/.rustup`), plus each `PATH` entry under `home` (the entry itself, never its parent: `~/.docker/bin` must not open `~/.docker`). Never `home` itself, never a protected read or anything under one.
  - `function deniedEnvNames(env: Readonly<Record<string, string>>): string[]`: every name in `env` that is not on the D5 allowlist. The allowlist: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `LANG`, `LC_*`, `TZ`, `TMPDIR`, `MISE_*`, `PNPM_HOME`, `CARGO_HOME`, `RUSTUP_HOME`, `JAVA_HOME`, `GOPATH`, `GOROOT`, `CLAUDE_CODE_TMPDIR`, `GIT_CONFIG_GLOBAL`, `npm_config_cache`, `pnpm_config_*`.
  - `const SYSTEM_READS`: `/usr`, `/bin`, `/sbin`, `/System`, `/Library`, `/private/etc`, `/private/var/db`, `/private/var/run`, `/private/var/select`, `/dev`, `/opt/homebrew`, `/Applications/Xcode.app`, and the root links `/tmp`, `/var`, `/etc`.

The profile, exactly:

- `filesystem.denyRead`: `['/', ...protectedReads, ...secretFiles]`.
- `filesystem.allowRead`: `[...SYSTEM_READS, tmpDir, realpath(checkout), ...toolchainReads, packageCacheDir, ...readList]`, minus any entry equal to or under a protected read.
- `filesystem.allowWrite`: `[tmpDir, packageCacheDir]`. The checkout is the working directory, which the sandbox writes by default.
- `network`: `allowedDomains`, `allowMachLookup: ['com.apple.FSEvents']`, `allowUnixSockets: [tmpDir]`, and `allowLocalBinding: true` only when `loopback`.
- `credentials.envVars`: `deniedEnvNames` with `mode: 'deny'`.

- [ ] **Step 1: Write the failing tests** (table-driven, `profile.test.ts`, real temp directories):
  - `builds the base fields exactly`: the five base fields equal the Global Constraints values.
  - `denies slash and every protected read`: `denyRead[0] === '/'`, and each `protectedReads` entry is present.
  - `allows back the system paths, the checkout's real path and the temp dir`: with `checkout` given through a symlink to a temp repo, `allowRead` contains `realpathSync(checkout)`, not the link (Review Focus 1).
  - `drops a read-list entry under a protected read`: `readList: [join(home, '.claude', 'x')]` is absent from `allowRead`.
  - `loopback only when asked`: `allowLocalBinding` is undefined for `false` and `true` for `true`.
  - `refuses a glob or a relative path`: `secretFiles: ['/r/.env*']` and `readList: ['rel/x']` each throw `SandboxProfileError` naming `filesystem.denyRead` and `filesystem.allowRead`.
  - `refuses a bad domain`: `allowedDomains: ['https://x']` throws naming `network.allowedDomains`.
  - `toolchainReads`: `PATH=/usr/bin:<home>/.local/share/mise/installs/node/26/bin:<home>` yields the fixed list plus `<home>/.local/share/mise/installs/node/26/bin`, and not `<home>`; `PATH=<home>/.docker/bin` yields `<home>/.docker/bin` and not `<home>/.docker`.
  - `env-allowlist.test.ts`: `{ PATH, HOME, LANG, LC_ALL, GH_TOKEN, AWS_SECRET_ACCESS_KEY, SSH_AUTH_SOCK, TENDB_X, MISE_SHELL }` yields exactly `['AWS_SECRET_ACCESS_KEY', 'GH_TOKEN', 'SSH_AUTH_SOCK', 'TENDB_X']` (sorted).
- [ ] **Step 2: Run** `pnpm --filter @10db/daemon exec vitest run src/sandbox`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the four files. `buildLaneProfile` builds the object, then `LaneSandboxSettingsSchema.safeParse` it, turning each issue into `SandboxProfileError` with `issue.path.join('.')`.
- [ ] **Step 4: Run** the same command. Expected: PASS. Then `pnpm --filter @10db/daemon typecheck`.
- [ ] **Step 5: Commit** `feat(daemon): build the lane sandbox profile from one source`.

### Task 3: The lane temp directory and package caches

**Files:**

- Create: `apps/daemon/src/sandbox/temp-dir.ts`, `apps/daemon/src/sandbox/package-cache.ts`
- Test: `apps/daemon/src/sandbox/temp-dir.test.ts`, `apps/daemon/src/sandbox/package-cache.test.ts`
- Modify: `apps/daemon/src/sandbox/index.ts`

**Interfaces:**

- Produces:
  - `const MAX_SANDBOX_TMP_BYTES = 44`
  - `function createLaneTempDir(root?: string): string`: `mkdtempSync(join(root ?? '/private/tmp', '10db-'))` (an 11-byte name under `/private/tmp`, 24 bytes in all), then `chmodSync(0o700)`. Returns the real path. Throws `SandboxTempDirError` when the result is over 44 bytes (and removes it) or the create fails.
  - `function removeLaneTempDir(dir: string, root = '/private/tmp'): void`: `rmSync(dir, { recursive: true, force: true })` only when `dirname(dir) === root` and its basename starts with `10db-`; otherwise it throws `SandboxTempDirError`.
  - `function packageCacheEnv(cacheDir: string): Record<string, string>`: `npm_config_cache: <cacheDir>/npm`, `pnpm_config_store_dir: <cacheDir>/pnpm-store`, `pnpm_config_state_dir: <cacheDir>/pnpm-state`, `pnpm_config_cache_dir: <cacheDir>/pnpm-cache`.
  - `function projectCacheDir(home: string, projectId: ProjectId): string`: `<home>/Library/Caches/10db/projects/<projectId>`, created with mode `0700`.

- [ ] **Step 1: Write the failing tests:** `creates a short private directory` (length ≤ 44, mode `0o700`, exists); `refuses a root that makes the path too long` (a root of 40 `a`s under a temp dir throws `SandboxTempDirError`, and leaves nothing behind); `removes only its own directories` (`removeLaneTempDir('/private/tmp')` throws, and its own directory is gone after a remove); `packageCacheEnv` (the four exact keys and values); `projectCacheDir` (path and mode).
- [ ] **Step 2: Run** `pnpm --filter @10db/daemon exec vitest run src/sandbox/temp-dir.test.ts src/sandbox/package-cache.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files, using `Buffer.byteLength` for the limit.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): give each sandboxed lane its own short temp directory`.

### Task 4: File-tool access on real paths

**Files:**

- Create: `apps/daemon/src/sandbox/file-access.ts`
- Test: `apps/daemon/src/sandbox/file-access.test.ts`
- Modify: `apps/daemon/src/guard/paths.ts` (export `realPathOf`, the existing `resolveThroughLinks` under a public name), `apps/daemon/src/guard/index.ts`, `apps/daemon/src/sandbox/index.ts`

**Interfaces:**

- Consumes: `realPathOf(p: string): string` from `guard` (resolves every existing component through links; it does not need the path to exist).
- Produces:
  - `interface FileAccessContext { checkout: string; home: string; protectedReads: readonly string[]; readList: readonly string[]; configDir: string; providerSessionId: string | null }`.
  - `function isOwnToolResult(realPath: string, ctx: FileAccessContext): boolean`: true only when `providerSessionId` is set and the real path's components under `<configDir>/projects/` are `[<slug>, <providerSessionId>, 'tool-results', ...rest]` with `rest` non-empty. A resumed session's id is its `resumeProviderSessionId` until `started` says otherwise.
  - `type ReadAccess = 'inside' | 'allowed' | 'protected' | 'ask'`
  - `function readAccess(path: string, ctx: FileAccessContext): { access: ReadAccess; realPath: string }`. It expands `~`, resolves against the checkout, then takes `realPathOf`. It compares with `normalize('NFC')`, lower-cased when `CASE_INSENSITIVE`. Order: `isOwnToolResult` → `allowed`; then `protected`; then `inside`; then `readList` → `allowed`; else `ask`. A path that can't be resolved (`realPathOf` throws on EACCES or ENOTDIR) is `ask`, never `inside`.
  - `function readPathsOf(toolName: string, input: unknown): string[]`. For `Read`, `file_path`. For `Grep`, `path`, defaulting to the checkout. For `Glob`, `path`, plus the pattern's leading literal directories before its first glob character (`../../x/*` gives `../../x`).
  - `type WriteAccess = 'ok' | 'git-internal' | 'claude-protected'`
  - `function writeAccess(path: string, ctx: FileAccessContext): { access: WriteAccess; realPath: string; viaLink: boolean }`. `git-internal` is a real path under `<checkout>/.git/`. `claude-protected` is a real path that is `.claude/settings.json`, `.claude/settings.local.json`, `.claude/hooks/**`, `.claude/skills/**`, `.claude/agents/**`, `.claude/commands/**`, `.mcp.json`, `.vscode/**` or `.idea/**` in the checkout, or `~/.zshrc`, `~/.zprofile`, `~/.bashrc`, `~/.bash_profile`, `~/.profile` or `~/.gitconfig`. `viaLink` is true when the real path differs from the plain resolved path.

- [ ] **Step 1: Write the failing tests** (table-driven, real temp dirs and `symlinkSync`). One row each for `readAccess`:
  - a file in the checkout → `inside`;
  - a link in the checkout to `<home>/.claude.json` → `protected`;
  - `~/.CLAUDE.json` → `protected` (Review Focus 5; darwin only);
  - a protected dir whose name is spelled in NFD → `protected` (Review Focus 5; darwin only);
  - `../other/secret` → `ask`, with `realPath` the sibling's real path (Review Focus 4);
  - `~/.ssh/id_rsa` → `ask` (Review Focus 4);
  - a path in `readList` → `allowed`;
  - `<configDir>/projects/x/<ownId>/tool-results/a.txt` → `allowed`;
  - `<configDir>/projects/x/<otherId>/tool-results/a.txt` → `protected`;
  - the same own path with `providerSessionId: null` → `protected`;
  - a path under a directory the test makes unreadable (`chmod 000`) → `ask`.

  `readPathsOf` rows: Read, Grep with and without `path`, Glob `../../x/*`. `writeAccess` rows: `.git/config` → `git-internal`; a link `x -> .git/hooks/pre-commit` → `git-internal`, `viaLink` true; `.claude/settings.json` → `claude-protected`; `src/a.ts` → `ok`.
- [ ] **Step 2: Run** `pnpm --filter @10db/daemon exec vitest run src/sandbox/file-access.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `file-access.ts`, and export `realPathOf` from `guard`.
- [ ] **Step 4: Run** the same command and `src/guard`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): decide sandboxed file-tool access on real paths`.

### Task 5: The guard's resolved-path check

**Files:**

- Modify: `apps/daemon/src/guard/judge.ts` (`GuardInput` gains `fileAccess?: FileAccessJudge`), `apps/daemon/src/guard/index.ts`
- Test: `apps/daemon/src/guard/judge.test.ts`

The guard is below `sandbox` in the dependency order, so it takes the judge as a function and doesn't import `sandbox`:

**Interfaces:**

- Produces in `guard`: `interface FileAccessJudge { read(toolName: string, input: unknown): 'ok' | { refuse: string }; write(path: string): 'ok' | { refuse: string } }`.
- `sandbox` produces `function fileAccessJudge(ctx: FileAccessContext): FileAccessJudge`. `read` refuses when any `readPathsOf` path is `protected`, with "`<path>` is a protected path; 10db never lets a lane read it." `write` refuses `git-internal` with "`.git/` internals are never edited; use the commit tool." It also refuses `claude-protected` with `viaLink` true, with "Edit `<real path>` by its own path, not through a link."
- `judgeToolUse` calls `fileAccess.read` for `Read`, `Grep`, `Glob` and `LS`, and `fileAccess.write` for the file-writing tools, before the claims check. With `fileAccess` undefined nothing changes.

- [ ] **Step 1: Write the failing tests** in `judge.test.ts`, with a stub `FileAccessJudge` and one real-judge row: Read refused with the judge's message; Edit `.git/config` refused; Grep allowed when the judge says ok; `fileAccess` undefined → today's verdicts for the same inputs.
- [ ] **Step 2: Run** `pnpm --filter @10db/daemon exec vitest run src/guard src/sandbox`. Expected: FAIL.
- [ ] **Step 3: Implement** both sides.
- [ ] **Step 4: Run** the same command. Expected: PASS, and every existing `judge.test.ts` row unchanged.
- [ ] **Step 5: Commit** `feat(daemon): refuse protected real paths and git internals in the guard`.

### Task 6: Scoped allow rules and rule patterns

**Files:**

- Modify: `apps/daemon/src/permissions/rules.ts`, `apps/daemon/src/permissions/index.ts`, `apps/daemon/src/inbox/service.ts:105-135`, `apps/daemon/src/sessions/fake-adapter.ts` (only through `matchesAllowedTool`)
- Test: `apps/daemon/src/permissions/rules.test.ts`, `apps/daemon/src/inbox/inbox.test.ts`

**Interfaces:**

- Produces:
  - `allowedToolsFor(project, tools, opts?: { sandboxed?: { checkout: string } })`. When `sandboxed`, the bare `Read`, `Glob`, `Grep` and `LS` entries become `Read(//<realCheckout>/**)`, `Glob(//<realCheckout>/**)`, `Grep(//<realCheckout>/**)` and `LS(//<realCheckout>/**)`. Without `opts`, the output is unchanged.
  - `matchesAllowedTool` accepts `Read(//<dir>/**)` (and the same for Glob, Grep and LS), with `readsInsideRepo(input, <dir>)`.
  - `function rulePattern(toolName: string, summary: string): string | null | undefined`. For Bash it is `commandPrefix(summary)`, and `undefined` (no rule can be stored) when that is null. For `SandboxNetworkAccess` it is the host, lower-cased. For `Read`, `Grep` and `Glob` it is the real path the summary names, and the rule is stored with `toolName: 'Read'` whichever of the three asked, so one approval covers all three and joins the read list. For `Edit`, `Write`, `MultiEdit` and `NotebookEdit` it is the real path of `file_path` (or `notebook_path`), matched exactly: one "always allow" on `.vscode/settings.json` never covers `.claude/hooks/x`. Otherwise it is `null`.
  - `matchPermissionRule`: a `SandboxNetworkAccess` rule matches when its `pattern` equals `input.host`, lower-cased. A `Read` rule with a pattern matches a `Read`, `Grep` or `Glob` request when every `readPathsOf` real path equals the pattern or is under it with `/`. An edit-tool rule with a pattern matches only the same tool on the same real path. A `null` pattern keeps today's meaning for every other tool.
- `inbox/service.ts` uses `rulePattern` in place of its inline `toolName === 'Bash' ? commandPrefix(summary) : null`.

- [ ] **Step 1: Write the failing tests:** `allowedToolsFor` with `sandboxed` (exact list) and without (equal to today's); `matchesAllowedTool` rows for an inside and an outside Read under a scoped entry; `matchPermissionRule` rows for a host rule matching `{ host: 'Registry.NPMJS.org' }`, not matching `evil.com`, and a Read path rule; an Edit rule on `.vscode/settings.json` doesn't match an Edit of `.claude/hooks/x`; a Grep approval is stored as `toolName: 'Read'`; in `apps/daemon/src/inbox/inbox.test.ts` (where the inbox and broker rows live), answering AllowProject on a `SandboxNetworkAccess` card stores `pattern: 'registry.npmjs.org'`, read back with `listPermissionRules`.
- [ ] **Step 2: Run** `pnpm --filter @10db/daemon exec vitest run src/permissions src/inbox/inbox.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command, then `src/sessions/fake-adapter.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): scope read allow rules to the checkout and store host rules`.

### Task 7: The broker's sandboxed decisions

**Files:**

- Modify: `apps/daemon/src/inbox/permission-broker.ts`
- Test: `apps/daemon/src/inbox/inbox.test.ts` (the broker rows at `:344-490` show the setup: real SQLite state, the real inbox service)

**Interfaces:**

- Consumes: `FileAccessContext`, `readAccess`, `readPathsOf` (Task 4); `rulePattern`, `matchPermissionRule` (Task 6); `hazardFor(command: string, hazards: readonly HazardDef[]): string | null`, a new export from `guard`. It walks every segment and the same `sh -c` and `eval` nesting `judgeShell` walks (`guard/judge.ts:105-156`), comparing `commandForms(words).bare` as `judgeShell` does, so `sh -c 'pnpm add x'` is a hazard too. `judgeShell` calls it in place of its own loop.
- `BrokerContext` gains `sandbox?: { fileAccess: FileAccessContext; hazards: readonly HazardDef[] }`. Without it the broker behaves exactly as on `main`.
- With `sandbox`, before `askPermission`:
  - **Bash**, not `escalated`: `hazardFor(command, hazards)` null → `allow`, no card. A hazard → today's `askPermission`.
  - **`SandboxNetworkAccess`** `{ host }`: a stored rule or this session's one-time allowance for the host → `allow` (the allowance is used up). Otherwise `deny` at once with "10db asked the builder about `<host>`. Retry after the card is answered, or work without it." and, once per host per session, `inbox.ask` a card (`kind: 'permission'`, title `Allow network access to <host>?`, options AllowOnce, AllowProject and Deny, `detail: { toolName: 'SandboxNetworkAccess', summary: host }`). The broker doesn't await the card. When the answer arrives, AllowOnce adds the host to the session's one-time set, and AllowProject is stored by the inbox (Task 6). The one-time set is the session's: the runner closes the session's open host cards when the session ends (Task 8), so no answer lands on a dead session. The card's body says: "The command was refused. Allow the host, and the lane retries."
  - **A `deps` hazard command whose head is `pnpm`** gets the card body "pnpm 12 can't install inside the lane sandbox yet (spike 14 check 9). Approving lets the command run; it will fail on pnpm's store lock. Run it yourself, or use npm." until the later pnpm task lands.
  - **Read, Grep, Glob, LS**: any path `protected` → `deny`, no card. All `inside` or `allowed`, or a stored path rule → `allow`. Otherwise `askPermission`, with summary set to the first real path that needs asking.
  - Everything else (MCP tools, WebFetch, WebSearch, Edit under an `ask` rule) → today's `askPermission`.

- [ ] **Step 1: Write the failing tests:**
  - `allows a sandboxed non-hazard command without a card`: `pnpm test`, no inbox item.
  - `cards a hazard command`: `pnpm add zod`.
  - `cards an escalated call`.
  - `denies an unlisted host at once and raises one card`: two requests for `example.com` → two denies, exactly one inbox item (Review Focus 3).
  - `allow once lets exactly the next request through`: answer AllowOnce, then allow, then deny with no new card (Review Focus 3).
  - `allows a host with a stored rule`.
  - `cards a hazard hidden in sh -c`: `sh -c 'pnpm add x'`.
  - `refuses a protected read with no card`.
  - `cards a read outside the checkout`.
  - `allows a read-list path`.
  - `without sandbox context, behaves as before`: today's rows, unchanged.

  Follow the existing broker rows in `inbox.test.ts`.
- [ ] **Step 2: Run** `pnpm --filter @10db/daemon exec vitest run src/inbox/inbox.test.ts src/guard`. Expected: FAIL.
- [ ] **Step 3: Implement.** Extract `hazardFor` from `judgeShell`'s hazard loop, with no change to the guard's behavior.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): let sandboxed lanes run without cards except hazards and new hosts`.

### Task 8: Wiring the session

**Files:**

- Create: `apps/daemon/src/sandbox/lane-sandbox.ts`
- Modify: `apps/daemon/src/sessions/types.ts`, `apps/daemon/src/sessions/claude-adapter.ts` (`buildQueryOptions` and the pre-`init` exit mapping only), `apps/daemon/src/runner/runner.ts` (session start, the `started` event, and the end of a session), `apps/daemon/src/briefing/prompts.ts`, `apps/daemon/src/daemon/start.ts` (`DaemonOptions`), `apps/daemon/src/main.ts`
- Test: `apps/daemon/src/sandbox/lane-sandbox.test.ts`, `apps/daemon/src/sessions/claude-adapter.test.ts`, `apps/daemon/src/runner/runner.test.ts`, `apps/daemon/src/briefing/briefing.test.ts`

**Interfaces:**

- `sessions/types.ts`:
  - `SessionSpec.sandbox: LaneSandboxSpec | null`, where `interface LaneSandboxSpec { settings: LaneSandboxSettings; env: Readonly<Record<string, string>>; disallowedTools: readonly string[]; askRules: readonly string[] }`. `LaneSandboxSettings` is imported as a type from `../sandbox`.
  - `SessionEndReason.SandboxRefused: 'sandbox_refused'`.
- `sandbox/lane-sandbox.ts`:
  - `interface LaneSandbox { forSession(input: { project: ProjectDto; env: Readonly<Record<string, string>>; rules: readonly PermissionRuleDto[]; resumeProviderSessionId: string | null }): LaneSession }`
  - `interface LaneSession { spec: LaneSandboxSpec; fileAccess: FileAccessContext; tmpDir: string; setProviderSession(id: string): void; dispose(): void }`
  - `function createLaneSandbox(deps: { home: string; dataDir: string; loopback: boolean; loginConfigDir: string | null; tmpRoot?: string; gitDirs: (repoPath: string) => { gitDir: string; commonDir: string } }): LaneSandbox`. `gitDirs` comes from `git/`, which runs `git rev-parse --absolute-git-dir --git-common-dir`; `sandbox` itself runs no git.

  `forSession`:

  - lists the checkout's secret files by exact path: `.env*` at any depth, skipping `node_modules` and `.git`;
  - makes the temp dir under `tmpRoot` (Task 3) and the project cache dir;
  - builds the profile (Task 2). The hosts come from `SandboxNetworkAccess` rules and the read list from `Read` path rules. When the checkout is a linked worktree (its `commonDir` is outside it), `commonDir` joins `allowRead` and the worktree's own `gitDir` joins `allowWrite`;
  - starts `fileAccess.providerSessionId` at `resumeProviderSessionId`. `setProviderSession` replaces it.

  It returns:

  - `spec.env`: `packageCacheEnv`, `CLAUDE_CODE_TMPDIR: tmpDir`, `GIT_CONFIG_GLOBAL: '/dev/null'`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1'`.
  - `disallowedTools`: `Read(//<p>)` and `Read(//<p>/**)` for each protected read other than the config dir (the guard and broker hold that one, so the session's own tool results stay readable), and `Read(//<secret file>)` for each secret file.
  - `askRules`: `Edit(//<realCheckout>/<p>)` and `Write(//<realCheckout>/<p>)` for each checkout `claude-protected` path in Task 4.
  - `dispose`: removes the temp dir.
- `buildQueryOptions`, when `spec.sandbox` is set:
  - `sandbox: spec.sandbox.settings` and `env: { ...spec.env, ...spec.sandbox.env }`;
  - `disallowedTools`, and `settings: { autoCompactEnabled: true, permissions: { ask: askRules } }`;
  - `settingSources: []` (D4, closing threat model check 3) and `permissionMode: 'default'`, whatever `deps.permissionMode` is.

  `startSession` skips `projectSettingsBillingProblem` and the settings re-check hooks then, since nothing loads that file. With `spec.sandbox` null the options are exactly as before.
- `claude-adapter.ts`: when `spec.sandbox` is set and the query throws before the first `init`, with a message containing `Error processing settings`, the session ends `SandboxRefused` with "The lane sandbox could not start: <first line of the message>". The runner maps `SandboxRefused` like `BillingRefused`, to `refused`, with no retries.
- Runner: `RunnerOptions.laneSandbox?: LaneSandbox | null`.
  - **Start.** It calls `forSession` before `insertSession`, passing `listPermissionRules(db, project.id, id)` from `@10db/db` (the broker's own query). It wraps `forSession`, `insertSession` and `adapter.start` in one `try`. A `SandboxProfileError` or `SandboxTempDirError` disposes, writes no session row and ends as `{ kind: 'refused', message: 'The lane sandbox could not start: <message>' }` through `fail`. Any other throw disposes and rethrows (Review Focus 2).
  - **What it passes.** `sandbox: laneSession.spec`, and `allowedTools: allowedToolsFor(project, step.tools, { sandboxed: { checkout: project.repoPath } })`. Into `judgeToolUse`, `fileAccess: fileAccessJudge(laneSession.fileAccess)`. Into the broker, `sandbox: { fileAccess, hazards: project.hazards }`.
  - **`started`.** It calls `setProviderSession`.
  - **End.** The existing `finally` (`runner.ts:1025-1036`) calls `dispose()` and closes the session's open `SandboxNetworkAccess` cards. That needs a new `InboxService.cancelForSession(sessionId, toolName)`, built like `cancelForWorkstream`.
- Briefing (`briefing/prompts.ts`), only when the session is sandboxed, beside the plain-commands line:
  - "Read the repository's agent instructions first: `AGENTS.md`, or `CLAUDE.md` where the repo uses it.";
  - "Make temp files with `mktemp \"$TMPDIR/x.XXXXXX\"`; a bare `mktemp` fails in the sandbox.";
  - "A command that fails with `Operation not permitted` hit the sandbox: say which path in your handoff, and don't retry it another way."
- `daemon/start.ts` `DaemonOptions` gains `laneSandbox?: LaneSandbox | null`. `main.ts` builds `createLaneSandbox` when `env.TENDB_LANE_SANDBOX === 'on'`, else `null`, where it builds the adapter from `env`.

- [ ] **Step 1: Write the failing tests:**
  - `lane-sandbox.test.ts` (temp root, temp repo):
    - `.env` and `apps/x/.env.local` are in `denyRead` and `disallowedTools`, and `node_modules/.env` is skipped;
    - host rules become `allowedDomains`;
    - a linked worktree's common dir is in `allowRead`;
    - `dispose` removes the temp dir.
  - `claude-adapter.test.ts`:
    - `buildQueryOptions` with a sandbox spec sets `sandbox`, `env`, `disallowedTools`, `settings.permissions.ask`, `settingSources: []` and `permissionMode: 'default'`, with `permissionMode: 'auto'` in deps;
    - with `null`, it deep-equals today's options;
    - a sandboxed query that throws `Error processing settings: ENOTDIR` before `init` ends `sandbox_refused`.
  - `runner.test.ts` (fake adapter):
    - a session with a stub `LaneSandbox` gets `spec.sandbox`;
    - a `forSession` that throws `SandboxProfileError` fails the workstream with a flag starting "The lane sandbox could not start", and writes no session row;
    - an `adapter.start` that throws leaves no temp dir;
    - an open host card is cancelled when the session ends;
    - `laneSandbox: null` gives `spec.sandbox === null` and today's `allowedTools`.
  - `briefing.test.ts`: the three lines appear for a sandboxed session only.
- [ ] **Step 2: Run** `pnpm --filter @10db/daemon exec vitest run src/sandbox src/sessions/claude-adapter.test.ts src/runner/runner.test.ts src/briefing`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command, then `pnpm --filter @10db/daemon test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): run lanes under the sandbox when TENDB_LANE_SANDBOX is on`.

### Task 9: The live check

**Files:**

- Create: `apps/daemon/src/sandbox/lane-sandbox.live.test.ts` (skipped unless `TENDB_LIVE_CLAUDE=1`, like `claude-adapter.live.test.ts`)

This test runs the real `claude` once, through `createClaudeAdapter`, with the exact spec Task 8 builds (on haiku, effort `low`, `maxBudgetUsd: 0.5`). Canaries are random-token files only:

- in a temp home-like directory beside the checkout;
- in `/Users/Shared`;
- in a second lane temp dir;
- in the checkout's `.env`;
- in a protected-read directory whose name has a space (standing in for `~/Library/Application Support/10db`).

It asserts:

- each `cat` of a canary prints no token;
- a Read tool call on the space-named canary is refused;
- `echo $TMPDIR` starts with the lane temp dir;
- `env | grep -c '^GH_TOKEN='` prints `0` with a fake `GH_TOKEN` in the session env;
- `git status` exits 0;
- a Read of a link in the checkout to a canary is refused;
- a repo `.claude/settings.json` holding `permissions.allow: ["Read"]` and `sandbox.filesystem.allowRead: ["/Users"]` widens nothing.

It removes every canary in a `finally`. This test is how D1's validation is proven: a profile Claude Code silently dropped would leak the first canary.

- [ ] **Step 1: Write the test.** It goes red first by passing `sandbox: null`, which leaks the canary. Record that run.
- [ ] **Step 2: Run** `TENDB_LIVE_CLAUDE=1 pnpm --filter @10db/daemon exec vitest run src/sandbox/lane-sandbox.live.test.ts` with the sandbox spec. Expected: PASS.
- [ ] **Step 3: Commit** `test(daemon): prove the built lane profile against the real Claude Code`.

### Task 10: Docs

**Files:**

- Modify: `docs/architecture/03-trust-boundaries.md` (§3 and §4.3 and §4.4 "Built" where slice 1 holds behind the switch; §6 R3, R4, R6, R10, R11 Built `behind TENDB_LANE_SANDBOX`, R1 `partly: Bash children; the claude process still holds the login env until D5 lands with accounts`; §8 checks 5, 9, 10, 11 and 12 answered with a pointer to spike 14, and check 3 closed for sandboxed sessions by D4; R7 Built `behind TENDB_LANE_SANDBOX`), `docs/superpowers/specs/2026-10-25-10db-lane-sandbox-design.md` (D14: the `CLAUDE_CODE_TMPDIR` mechanism and its 44-byte limit; D1: the profile is validated and proven live, because an invalid value drops the sandbox; check 9 consequence: per-project caches, and pnpm 12's lock is open), `docs/architecture/decisions.md` (row 104: lanes run under the sandbox behind `TENDB_LANE_SANDBOX`, with the mechanisms above and the builder's per-project-cache choice), `apps/daemon/AGENTS.md` (the `sandbox/` bullet, the switches).
- [ ] **Step 1: Edit** the docs; mark each row **built** or **designed**, as the root `AGENTS.md` asks.
- [ ] **Step 2: Run** `pnpm exec vitest run --project repo`. Expected: PASS (decision numbering, research list).
- [ ] **Step 3: Commit** `docs(docs): record the lane sandbox slice in the threat model and decisions`.

### Task 11: The gate

- [ ] **Step 1: Run** `make gate`. Expected: `GATE PASS`. A failure is fixed in the task that owns it, and the gate is run again.

---

## Later tasks (step 3, a separate plan revision before they run)

Each gets its own task block, written against the code once slice 1 has merged.

- **D13, the daemon's git.** Every `git/` call in the checkout passes `-c core.fsmonitor=false -c core.hooksPath=<empty dir in the data dir>`. `gh` gets the same through `GIT_CONFIG_COUNT`. Before fetch or push, the local config is read with `git config --local --list -z` and refused with a card on the keys D13 lists. The push goes to the URL recorded at batch start, with `--no-verify`.
- **D11, the safe reader.** `delivery/pr-template.ts` reads through a reader that opens with `O_NOFOLLOW | O_NONBLOCK`. It then checks `realpath(path) === path`, that `fstat` matches `lstat`'s device and inode, `nlink === 1`, a regular file and the size cap. Data-dir writes use `O_NOFOLLOW`, and the data dir is `0700`.
- **D16, the secret scan.** `gitleaks git --log-opts=<base>..<head>` with 10db's pinned config (never the repo's) before every push. A finding is a card that names the file and rule. The system check warns when `gitleaks` is missing.
- **D17, the CI card.** A batch whose `git diff --name-only <base>..<head>` touches `.github/workflows/**` or `.github/actions/**` stops before the push with a card listing those paths.
- **D6 and D9, the gate under `srt`.** The gate profile comes from Task 2's source (the same protected reads, toolchain reads and per-run temp dir, plus loopback, `com.apple.FSEvents` and unix sockets in the temp dir), written as an `srt` config. The gate and the daemon's `git commit` and `git switch` run under it. 10db's `ps`-exec tests skip when `TENDB_SANDBOX=1`, and the e2e fixture repo moves under the temp dir. The exit criterion is threat model check 15.
- **pnpm 12's store lock** inside the sandbox (spike 14 check 9), so an approved pnpm dependency change can run in a lane.
