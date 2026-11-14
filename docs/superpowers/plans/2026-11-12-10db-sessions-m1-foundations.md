# 10db Sessions M1, Foundations: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mantine 9.8 under the UI and the docs server, Codex's app-server types generated from the pinned binary and
checked by a stamp, tests that hold 10db's runtime Codex schemas to them, and a Codex account on GCP that no longer
breaks the account read.

**Architecture:** A daemon script fetches the pinned Codex through the pin's own checksum code
(`ensureAgent`), runs `codex app-server generate-ts` and `generate-json-schema`, and writes a subset into
`apps/daemon/src/sessions/codex-generated/` with a `STAMP` (version and hash). The daemon's `drift` script checks only
the stamp, so CI and lane gates never run the darwin binary. `codex-protocol.ts` stays the loose runtime validator;
a type test and a fixture test hold it to the generated output.

**Tech Stack:** TypeScript, zod 4.6.7 (`z.fromJSONSchema`), Vitest 5 (`expectTypeOf`), tsx, Mantine 9.8.0, Codex
0.167.0.

**Spec:** `docs/superpowers/specs/2026-11-11-10db-sessions-design.md` §5.5, §12 (M1), §14 (M1). Research:
`docs/architecture/research/2026-11-11-sessions-research.md` T2 (generation) and T4 §2 (Mantine).

## Global Constraints

- Root `AGENTS.md`, `apps/daemon/AGENTS.md`, `apps/desktop/AGENTS.md`, `.claude/rules/code-style.md`,
  `.claude/rules/testing.md`. Add no product rule the spec doesn't state.
- Branch `feat/sessions-m1` in its own worktree:
  `git worktree add ../10db-worktrees/sessions-m1 -b feat/sessions-m1 origin/main`. Tasks in order.
- Commits are Conventional Commits, name every path (`git add a b && git commit -m '...'`), single-quoted `-m`, and end
  with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `--no-verify`.
- Pins are exact. Codex is `CODEX_VERIFIED_ON = '0.167.0'` (`apps/daemon/src/environment/agent-pins.ts:10`). Mantine
  is `9.8.0`. `pnpm-workspace.yaml` holds every version for 1440 minutes after it is published.
- Generated output is never edited by hand. Only `pnpm --filter @10db/daemon generate:codex`, run on a Mac, writes
  `apps/daemon/src/sessions/codex-generated/`.
- **`generate:codex` runs in a plain Mac session, never in a sandboxed 10db lane.**
  - It needs the network: the npm registry, on the first run.
  - It writes outside the worktree. The pinned copy goes to the live tests' tools folder
    (`~/Library/Application Support/10db/live-tests/tools`), and the generator runs in a temp dir.
  - A lane that reaches its step in Task 3 or Task 4 stops there and hands the step to the builder or the
    coordinator.
- zod at every boundary: a JSON file the script or a test reads from disk is parsed before use; an `as` cast is
  allowed only at that validated boundary, with a comment.
- Each newly tested behaviour carries one value card in its commit message. A new row in an existing table needs
  none.
- **A test of code that already works** (Task 4) proves red by a one-line mutation of the code under test, reverted
  before the commit. The commit says which mutation.
- No AA numbers anywhere in the repo.

## Review Focus

1. **A Codex pin bump with no regeneration.** `make gate` fails at `drift` with a line naming both versions and
   `pnpm --filter @10db/daemon generate:codex`. Test in Task 3.
2. **A hand edit, an added file or a removed file inside `codex-generated/`.** The hash check fails. Tests in Task 3.
3. **A field 10db requires that Codex makes optional or nullable, or a variant Codex adds.** The fixture test fails,
   because fixtures carry only required fields and one instance per union branch and enum value. Tests in Task 4.
4. **ts-rs writes a 64-bit integer as `bigint`, but the wire carries a JSON number.** The type test reads generated
   types through `Wire<T>` (bigint as number), so `HooksListResponse.timeoutSec` doesn't fail falsely. Row in Task 4.
5. **A Mantine 9.8 change on a screen no e2e covers** (Settings, Inbox cards, Knowledge). Click-through in Task 1.

---

### Task 1: Mantine 9.8.0, and the Mantine docs server pinned to it

**Files:**

- Modify: `apps/desktop/package.json:23-24`, `.mcp.json:5`, `.codex/config.toml:17`, `pnpm-lock.yaml` (by
  `pnpm install`)

**Interfaces:** none. Leave the `@mantine/mcp-server@9.7.2` strings in daemon test fixtures
(`daemon/start.test.ts:1360,1397`, `inbox/mcp-approval.test.ts`, `runner/runner.test.ts`) as they are: they are data
about a repo's `.mcp.json`, not pins.

- [ ] **Step 1: Check the versions are published and past the release hold.**

Run: `npm view @mantine/core time --json`, and read its `"9.8.0"` key. Then:
`npm view @mantine/hooks@9.8.0 version && npm view @mantine/mcp-server@9.8.0 version && npm view mantine-datatable@9.4.0 peerDependencies --json`

Expected:
- The `9.8.0` time is over 24 hours ago.
- `@mantine/hooks` and `@mantine/mcp-server` each print `9.8.0`.
- `mantine-datatable` 9.4.0's peer ranges for `@mantine/core` and `@mantine/hooks` admit 9.8.0. They were `>=9.0`
  when this plan was written. If they don't, stop and report.

**(call)** If `@mantine/mcp-server@9.8.0` is not published, pin the newest published `9.8.x` of it and say so in the
PR.

- [ ] **Step 2: Bump.** `@mantine/core` and `@mantine/hooks` to `9.8.0` in `apps/desktop/package.json`; the
  `@mantine/mcp-server` argument in `.mcp.json` and `.codex/config.toml` to the version from Step 1. Then
  `pnpm install`.

  **(call)** `@mantine/code-highlight` and `@mantine/spotlight` (research T4 §2) are not added here. knip fails on an
  unused dependency; each is added in the milestone with its first import (M3 for `Diff`, M8 for `Spotlight`).

- [ ] **Step 3: Run the desktop's checks.**

Run: `pnpm --filter @10db/desktop typecheck && pnpm exec eslint --max-warnings=0 apps/desktop && pnpm exec vitest run --project desktop && pnpm --filter @10db/desktop build && pnpm knip`
Expected: all pass.

- [ ] **Step 4: Run it before review: the e2e against the real daemon, then a click-through.**

Run: `pnpm --filter @10db/desktop e2e`
Expected: every spec passes.

Then `pnpm dev` and, with the `/browse` skill, open Factory, the Board, a task's Workbench, Plan, Inbox, Knowledge and
every Settings tab. Expected: no console errors, and no layout change against `main` (compare one screenshot of each
against the same screen on a `main` checkout).

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/package.json .mcp.json .codex/config.toml pnpm-lock.yaml && git commit -m 'build(deps): mantine 9.8.0, with the mantine docs server pinned to it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 2: A Codex account on GCP is refused by its credentials, not by a failed read

The hand-typed `Account` union (`apps/daemon/src/sessions/codex-protocol.ts:13-21`) lacks Codex 0.167.0's
`{ type: 'gcp' }`, so `AccountReadResponse` throws on a GCP home. `readSeenAccount`
(`codex-account-read.ts:32`) already turns any non-ChatGPT account into `apiProvider: account.type`, which
`checkAccount` refuses as `WrongCredentials` (`account-check.ts:148-153`).

**Files:**

- Modify: `apps/daemon/src/sessions/codex-protocol.ts:13-21`
- Test: `apps/daemon/src/sessions/codex-adapter.test.ts` (the `probeAccount` describe, after `:150`),
  `apps/daemon/src/sessions/codex-session.test.ts` (beside the start-check table at `:211`)

**Interfaces:**

- Produces: `AccountReadResponse` accepts `account: { type: 'gcp' }`. `readSeenAccount` returns
  `{ ...NOTHING, apiProvider: 'gcp' }` for it.

- [ ] **Step 1: Write the failing tests.**

```ts
// codex-adapter.test.ts, in the probeAccount describe
it('reports a home signed in on GCP as a provider the ChatGPT check refuses', async () => {
  const server = fakeAppServer({
    ...SIGNED_IN,
    'account/read': { account: { type: 'gcp' }, requiresOpenaiAuth: false },
  });
  const seen = await adapterOn(server).probeAccount(probe);
  expect(seen.apiProvider).toBe('gcp');
  expect(checkAccount(expectation(null), seen)).toMatchObject({
    problem: AccountProblem.WrongCredentials,
  });
  expect(server.sent().map((m) => m.method)).not.toContain('account/rateLimits/read');
});

// codex-session.test.ts, in describe('the start checks') after its table (the table checks the reason only)
it('refuses a session whose home is signed in on GCP, naming the provider', async () => {
  const { handle, server } = startWith({
    'account/read': { account: { type: 'gcp' }, requiresOpenaiAuth: false },
  });
  const ended = (await collect(handle)).at(-1);
  expect(ended).toMatchObject({ type: 'ended', reason: 'account_refused' });
  expect(ended?.type === 'ended' ? ended.message : '').toContain('apiProvider gcp');
  expect(methods(server)).not.toContain('turn/start');
});
```

- [ ] **Step 2: Run them to see them fail.**

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/codex-adapter.test.ts src/sessions/codex-session.test.ts`
Expected: FAIL. The probe rejects (the parse of `account/read` throws on `type: 'gcp'`), and the session's message
names the failed read, not `apiProvider gcp`.

- [ ] **Step 3: Add `z.looseObject({ type: z.literal('gcp') })` to `Account`.**

- [ ] **Step 4: Run them to see them pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/daemon/src/sessions/codex-protocol.ts apps/daemon/src/sessions/codex-adapter.test.ts apps/daemon/src/sessions/codex-session.test.ts && git commit -m 'fix(daemon): a codex account on gcp is refused as the wrong credentials, not by a failed read

Value: protects=a Codex home signed in on GCP is read and refused as WrongCredentials;
fails_when=the account union drops a variant Codex sends and the read throws;
why_new=the probe and start tests cover chatgpt, signed out and failed reads, never another provider;
no_claim=a GCP account working as a 10db account (no such kind exists)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 3: `generate:codex` writes the generated types and a stamp, and `drift` checks the stamp

**Files:**

- Create: `apps/daemon/scripts/codex-closure.ts`, `apps/daemon/scripts/codex-closure.test.ts`
- Create: `apps/daemon/scripts/codex-stamp.ts`, `apps/daemon/scripts/codex-stamp.test.ts`
- Create: `apps/daemon/scripts/codex-stamp-check.ts` (entry), `apps/daemon/scripts/codex-generate.ts` (entry)
- Create (generated): `apps/daemon/src/sessions/codex-generated/ts/**`, `apps/daemon/src/sessions/codex-generated/STAMP`
- Modify: `apps/daemon/package.json` (scripts), `.prettierignore`, `eslint.config.js:12-30` (`globalIgnores`),
  `knip.json` (`ignore`)
- Modify: `tests/repo/src/test-report.ts:7` and its table in `tests/repo/src/test-report.test.ts:47`
- Modify: `tests/repo/src/check-changed.test.ts:170-175` (a daemon change now drifts the daemon)
- Modify: `renovate.json:54-56` (Codex `prBodyNotes`) and `tests/repo/src/governance.test.ts` (a new `it` after the
  pin table at `:555-631`)
- Modify: `AGENTS.md` (the "Generated files are never edited by hand" bullet), `apps/daemon/AGENTS.md:106` (the
  `sessions/` bullets)

**Interfaces:**

- Produces in `scripts/codex-closure.ts`:
  - `class ClosureError extends Error` with `name = 'ClosureError'`.
  - `importClosure(read: (path: string) => string, seeds: readonly string[]): string[]`: every file the seeds reach
    through `from "./…"` and `from "../…"`, seeds included. Paths are POSIX, relative to the output root, end in
    `.ts`, and are sorted. An import that names no readable file throws `ClosureError` naming both files.
- Produces in `scripts/codex-stamp.ts`:
  - `STAMP_FILE = 'STAMP'`, `GENERATED_DIR` (absolute path of `src/sessions/codex-generated`).
  - `interface Stamp { readonly version: string; readonly sha256: string }`.
  - `hashTree(files: ReadonlyMap<string, Buffer>): string`: sha256 hex over the files sorted by path, each as
    `path`, a NUL byte, its bytes, a NUL byte.
  - `formatStamp(stamp: Stamp): string` is `version=<v>\nsha256=<hex>\n`; `parseStamp(text: string): Stamp` throws
    `StampError` (`name = 'StampError'`) on anything else.
  - `readTree(dir: string): Map<string, Buffer>`: every file under `dir` except `STAMP`, keyed by POSIX relative path.
  - `stampProblem(dir: string, pinned: string): string | null`: null when `STAMP` names `pinned` and its hash
    matches `readTree(dir)`; otherwise one line saying what differs and naming
    `pnpm --filter @10db/daemon generate:codex`.
- Produces in `apps/daemon/package.json`: `"generate:codex": "tsx scripts/codex-generate.ts"` and
  `"drift": "tsx scripts/codex-stamp-check.ts"` (the gate's `drift` step runs `pnpm -r --if-present run drift`).
- `CODEX_SEED_TYPES` in `codex-generate.ts` **(call: spec §5.5's subset)**: the roots `ClientRequest`, `ServerRequest`,
  `ServerNotification`, plus the response types 10db reads, which no root reaches: `InitializeResponse`, and in `v2/`
  `GetAccountResponse`, `GetAccountRateLimitsResponse`, `LoginAccountResponse`, `CancelLoginAccountResponse`,
  `ModelListResponse`, `ConfigReadResponse`, `HooksListResponse`, `ThreadStartResponse`, `ThreadResumeResponse`,
  `ThreadTurnsListResponse`, `TurnStartResponse`, `TurnSteerResponse`, `TurnInterruptResponse`. On 0.167.0 the closure
  is about 430 of the 761 files (about 240 KB). The roots import every request and notification, so M2c's streaming
  notifications and M5b's `thread/compact/start` and `review/start` are already in it.

- [ ] **Step 1: Write the failing pure tests.**

```ts
// codex-closure.test.ts: an in-memory reader over these files
const files = {
  'A.ts': 'import type { B } from "./B";\nimport type { C } from "./v2/C";',
  'B.ts': 'export type B = string;',
  'v2/C.ts': 'import type { B } from "../B";\nimport type { D } from "./D";',
  'v2/D.ts': 'export type D = number;',
  'E.ts': 'export type E = boolean;',
};
it.each([
  ['a seed with no imports is itself', ['B.ts'], ['B.ts']],
  ['follows ./ and ../ imports, once each, sorted', ['A.ts'], ['A.ts', 'B.ts', 'v2/C.ts', 'v2/D.ts']],
  ['leaves out what no seed reaches', ['A.ts'], expect.not.arrayContaining(['E.ts'])],
])('%s', (_n, seeds, want) => expect(importClosure(read, seeds)).toEqual(want));
const read = (path: string): string => {
  const text = (files as Record<string, string | undefined>)[path];
  if (text === undefined) throw new Error(`no ${path}`);
  return text;
};
it('throws ClosureError naming the importer and the missing file', () => {
  const broken = (path: string) => (path === 'X.ts' ? 'import type { G } from "./Gone";' : read(path));
  expect(() => importClosure(broken, ['X.ts'])).toThrow(ClosureError);
  expect(() => importClosure(broken, ['X.ts'])).toThrow(/X\.ts.*Gone\.ts/);
});

// codex-stamp.test.ts
const tree = (): Map<string, Buffer> =>
  new Map([['ts/A.ts', Buffer.from('a')], ['ts/v2/B.ts', Buffer.from('b')], ['fixtures/C.json', Buffer.from('[]')]]);
it('hashes the same files the same in any insertion order', () => {
  expect(hashTree(new Map([...tree()].reverse()))).toBe(hashTree(tree()));
  expect(hashTree(tree())).toMatch(/^[0-9a-f]{64}$/);
});
it.each([
  ['a changed byte', (t: Map<string, Buffer>) => t.set('ts/A.ts', Buffer.from('b'))],
  ['an added file', (t: Map<string, Buffer>) => t.set('ts/New.ts', Buffer.from(''))],
  ['a removed file', (t: Map<string, Buffer>) => t.delete('ts/A.ts')],
  ['a renamed file', (t: Map<string, Buffer>) => { t.set('ts/Z.ts', Buffer.from('a')); t.delete('ts/A.ts'); }],
])('changes the hash for %s', (_n, change) => {
  const changed = tree();
  change(changed);
  expect(hashTree(changed)).not.toBe(hashTree(tree()));
});
it('round-trips formatStamp through parseStamp, and refuses a stamp with a missing line', () => {
  const stamp = { version: '0.167.0', sha256: 'a'.repeat(64) };
  expect(formatStamp(stamp)).toBe(`version=0.167.0\nsha256=${'a'.repeat(64)}\n`);
  expect(parseStamp(formatStamp(stamp))).toEqual(stamp);
  expect(() => parseStamp('version=0.167.0\n')).toThrow(StampError);
});

// On a real temp dir (the repo's `tempDir` fixture), written with node:fs. `stamped(dir, version)` writes
// ts/A.ts and ts/v2/B.ts, then STAMP = formatStamp({ version, sha256: hashTree(readTree(dir)) }).
it('passes a folder whose STAMP names the pin and its hash, ignoring STAMP itself', () => {
  stamped(dir, '0.167.0');
  expect(stampProblem(dir, '0.167.0')).toBeNull();
});
it('fails a folder stamped for another release, naming both versions and the command', () => {
  stamped(dir, '0.167.0');
  expect(stampProblem(dir, '0.168.0')).toMatch(
    /0\.167\.0.*0\.168\.0.*pnpm --filter @10db\/daemon generate:codex/s,
  );
});
it('fails a folder with a file changed after stamping, naming the command', () => {
  stamped(dir, '0.167.0');
  writeFileSync(join(dir, 'ts/A.ts'), 'edited');
  expect(stampProblem(dir, '0.167.0')).toMatch(/pnpm --filter @10db\/daemon generate:codex/);
});
it('fails a folder with no STAMP, naming the command', () => {
  writeFileSync(join(dir, 'A.ts'), 'a');
  expect(stampProblem(dir, '0.167.0')).toMatch(/STAMP.*pnpm --filter @10db\/daemon generate:codex/s);
});
```

- [ ] **Step 2: Run them to see them fail.**

Run: `pnpm --filter @10db/daemon exec vitest run scripts/codex-closure.test.ts scripts/codex-stamp.test.ts`
Expected: FAIL, the modules don't exist.

- [ ] **Step 3: Implement `codex-closure.ts` and `codex-stamp.ts` to the Interfaces above.** Read with `node:fs`; no
  network, no child process.

- [ ] **Step 4: Run them to see them pass.** Same command. Expected: PASS.

- [ ] **Step 5: Write the two entry scripts.**
  - `codex-stamp-check.ts`: `stampProblem(GENERATED_DIR, CODEX_VERIFIED_ON)`, imported from `../src/environment`;
    prints the problem and exits 1, or exits 0 silently.
  - `codex-generate.ts`:
    1. Refuses to run unless `process.platform === 'darwin'`, saying the pinned build is darwin-arm64.
    2. `ensureAgent(AgentTool.Codex)` from `../src/environment`, which fetches into the live tests' tools folder and
       checks the pin's checksum (`environment/pinned-tools.ts:96-101`).
    3. Runs `<codex> app-server generate-ts --out <tmp>/ts` and `<codex> app-server generate-json-schema --out
       <tmp>/schema` with `execFile`, in a fresh `mkdtemp` dir, with env `{ PATH: '/usr/bin:/bin', HOME: <tmp>,
       CODEX_HOME: <tmp>/home }` **(call: the generator never sees the builder's Codex home)**. If the binary asks for
       an experimental flag, pass the one its `--help` names.
    4. Replaces `codex-generated/ts/` with `importClosure` over `CODEX_SEED_TYPES`, copied byte for byte.
    5. Writes `STAMP` with `formatStamp({ version: CODEX_VERIFIED_ON, sha256: hashTree(readTree(GENERATED_DIR)) })`.
    6. Removes the temp dir.

    **(call)** The layout is `codex-generated/ts/` (generate-ts output, `v2/` kept), later `schema/` and `fixtures/`
    (Task 4), and `STAMP`.

- [ ] **Step 6: Generate, and check.**

Run: `pnpm --filter @10db/daemon generate:codex && pnpm --filter @10db/daemon drift && pnpm --filter @10db/daemon typecheck`
Expected: the folder is written, `drift` exits 0, and the generated files compile. If `tsc` rejects a generated
file, stop and report it: never edit it.

- [ ] **Step 7: Keep the tools off the folder.** Add `apps/daemon/src/sessions/codex-generated/` to
  `.prettierignore` and `knip.json`'s `ignore`, and `'apps/daemon/src/sessions/codex-generated/**'` to
  `eslint.config.js`'s `globalIgnores` (the existing `**/generated/**` doesn't match `codex-generated`).

Run: `pnpm format:check && pnpm exec eslint --max-warnings=0 apps/daemon && pnpm knip`
Expected: PASS.

- [ ] **Step 8: Write the failing repo tests.**

```ts
// test-report.test.ts: a row in the path-kind table at :47
['generated codex types', 'apps/daemon/src/sessions/codex-generated/ts/v2/Account.ts', 'other'],

// governance.test.ts: a new it after the pin table
it('names the command that regenerates the Codex types in the Codex PR note', () => {
  const own = renovate.packageRules.find((r) => r.matchPackageNames?.includes('@openai/codex'));
  expect(own?.prBodyNotes?.join('\n')).toContain('pnpm --filter @10db/daemon generate:codex');
});

// check-changed.test.ts:170: the existing row 'checks a daemon change and its dependents only' expects
// plan.drift toEqual([]). The daemon now has a drift script, so a daemon change drifts it:
expect(plan.drift).toEqual(['@10db/daemon']);
```

  Steps 1 to 7 already added the daemon's `drift` script, so revert that one line of `apps/daemon/package.json`
  while you run this, to see the `check-changed` row fail for the right reason.

Run: `pnpm exec vitest run --project repo tests/repo/src/test-report.test.ts tests/repo/src/governance.test.ts tests/repo/src/check-changed.test.ts`
Expected: FAIL on all three.

- [ ] **Step 9: Make them pass.**
  - Restore the daemon's `drift` script.
  - Add `'apps/daemon/src/sessions/codex-generated/'` to `GENERATED_PREFIXES` (`test-report.ts:7`).
  - Append to the Codex note in `renovate.json`: "Then, on a Mac, run `pnpm --filter @10db/daemon generate:codex` and
    commit `apps/daemon/src/sessions/codex-generated/`: the drift check fails until its STAMP names this release."

Run: the Step 8 command. Expected: PASS.

- [ ] **Step 10: Docs.**
  - Root `AGENTS.md`, the generated-files bullet: add `apps/daemon/src/sessions/codex-generated/`, written only by
    `pnpm --filter @10db/daemon generate:codex` on a Mac, whose `STAMP` `make gate` checks.
  - `apps/daemon/AGENTS.md`, beside the `sessions/` bullets near `:106`: one bullet saying what the folder holds, that
    `codex-protocol.ts` stays the runtime validator, and that a Codex pin bump needs `generate:codex` before `drift`
    passes.

- [ ] **Step 11: Commit.**

```bash
git add apps/daemon/scripts/codex-closure.ts apps/daemon/scripts/codex-closure.test.ts apps/daemon/scripts/codex-stamp.ts apps/daemon/scripts/codex-stamp.test.ts apps/daemon/scripts/codex-stamp-check.ts apps/daemon/scripts/codex-generate.ts apps/daemon/src/sessions/codex-generated apps/daemon/package.json .prettierignore eslint.config.js knip.json tests/repo/src/test-report.ts tests/repo/src/test-report.test.ts renovate.json tests/repo/src/governance.test.ts tests/repo/src/check-changed.test.ts AGENTS.md apps/daemon/AGENTS.md && git commit -m 'feat(daemon): codex protocol types generated from the pinned binary, checked by a stamp

Value: protects=the checked-in Codex types are, byte for byte, what the pinned release generates;
fails_when=a pin bump lands without regenerating, or a generated file is edited, added or removed by hand;
why_new=no check covered generated Codex output before; the closure and stamp are pure, so they are tested pure;
no_claim=that the runtime schemas agree with the types (Task 4)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 4: The runtime Codex schemas read every shape the pinned Codex can send

**Files:**

- Create: `apps/daemon/scripts/codex-samples.ts`, `apps/daemon/scripts/codex-samples.test.ts`
- Modify: `apps/daemon/scripts/codex-generate.ts` (writes `schema/` and `fixtures/`)
- Create (generated): `apps/daemon/src/sessions/codex-generated/schema/*.json`,
  `apps/daemon/src/sessions/codex-generated/fixtures/*.json`, and a new `STAMP`
- Create: `apps/daemon/src/sessions/codex-protocol.test.ts`
- Modify, only if a fixture row shows drift: `apps/daemon/src/sessions/codex-protocol.ts`

**Interfaces:**

- Consumes: `importClosure`, `hashTree`, `formatStamp`, `readTree` (Task 3); `CODEX_VERIFIED_ON`.
- Produces in `scripts/codex-samples.ts`:
  - `class SampleError extends Error` with `name = 'SampleError'`.
  - `sampleInstances(document: unknown): unknown[]`. `document` is a per-type JSON schema read from disk; each node
    is parsed with a loose zod node schema as it is walked. Returns a base instance, then one instance for each
    alternative a `oneOf` or `anyOf` branch or an `enum` value offers anywhere, with every other choice at its first
    option. Duplicates are dropped and the order is stable.
    - An object gets only its `required` properties.
    - An array gets one sampled item.
    - `string` is `"x"`, `integer` and `number` are `0`, `boolean` is `false`, and `null` is `null`.
    - `type: [T, "null"]` is two choices.
    - `const` is its value. `$ref` resolves within `definitions`. `allOf` merges its parts' samples.
    - Any other keyword that shapes a value (`not`, `if`, `patternProperties`, a `$ref` outside the document) throws
      `SampleError` naming it.
- `RUNTIME_SCHEMAS` in `codex-generate.ts`: the generated type of each runtime schema, which the generator copies to
  `schema/<Type>.json` (the per-type file; `InitializeResponse` is under `v1/` in the output) and samples into
  `fixtures/<Type>.json` (a JSON array, 2-space indent):

  | Runtime export (`codex-protocol.ts`) | Generated type |
  | --- | --- |
  | `InitializeResponse` | `InitializeResponse` |
  | `AccountReadResponse` | `v2/GetAccountResponse` |
  | `RateLimitsReadResponse` | `v2/GetAccountRateLimitsResponse` |
  | `RateLimitsUpdated` | `v2/AccountRateLimitsUpdatedNotification` |
  | `ModelListResponse` | `v2/ModelListResponse` |
  | `ConfigReadResponse` | `v2/ConfigReadResponse` |
  | `HooksListResponse` | `v2/HooksListResponse` |
  | `ThreadResponse` | `v2/ThreadStartResponse`, `v2/ThreadResumeResponse` |
  | `TurnStartResponse` | `v2/TurnStartResponse` |
  | `TurnStarted` | `v2/TurnStartedNotification` |
  | `TurnCompleted` | `v2/TurnCompletedNotification` |
  | `TokenUsageUpdated` | `v2/ThreadTokenUsageUpdatedNotification` |
  | `ItemCompleted` | `v2/ItemCompletedNotification` |
  | `ThreadTurnsPage` | `v2/ThreadTurnsListResponse` |

  **(call)** The fixtures are sampled from the generated JSON schema, not recorded from a live session. A live
  recording can't show a variant 10db's own account doesn't have (a GCP account), and sampling is deterministic, so
  the stamp covers the fixtures too. The schemas in `codex-connect.ts` (login) and `codex-mapping.ts` (items) are
  narrow on purpose (a login of another type is refused) and are left out.

- [ ] **Step 1: Write the failing sampler tests** (`codex-samples.test.ts`, one table, a row per rule):

```ts
it.each([
  ['an object keeps only required properties',
    { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a'] },
    [{ a: 'x' }]],
  ['a nullable string offers null', { type: ['string', 'null'] }, ['x', null]],
  ['an enum offers each value', { type: 'string', enum: ['completed', 'failed'] }, ['completed', 'failed']],
  ['oneOf offers each branch',
    { oneOf: [{ type: 'object', properties: { type: { enum: ['chatgpt'] } }, required: ['type'] },
              { type: 'object', properties: { type: { enum: ['gcp'] } }, required: ['type'] }] },
    [{ type: 'chatgpt' }, { type: 'gcp' }]],
  ['a $ref resolves in definitions', { definitions: { N: { type: 'integer' } }, $ref: '#/definitions/N' }, [0]],
  ['an array gets one item, whose branches vary',
    { type: 'array', items: { type: ['boolean', 'null'] } }, [[false], [null]]],
  ['allOf merges its parts',
    { allOf: [{ type: 'object', properties: { a: { const: 1 } }, required: ['a'] },
              { type: 'object', properties: { b: { const: 2 } }, required: ['b'] }] },
    [{ a: 1, b: 2 }]],
  ['a nested choice varies while the others stay first',
    { type: 'object', required: ['s', 't'],
      properties: { s: { enum: ['a', 'b'] }, t: { type: ['string', 'null'] } } },
    [{ s: 'a', t: 'x' }, { s: 'b', t: 'x' }, { s: 'a', t: null }]],
])('%s', (_n, schema, want) => expect(sampleInstances(schema)).toEqual(want));
it.each([['not', { not: { type: 'string' } }], ['an outside $ref', { $ref: 'other.json#/X' }]])(
  'throws SampleError on %s', (_n, schema) => expect(() => sampleInstances(schema)).toThrow(SampleError));
```

Run: `pnpm --filter @10db/daemon exec vitest run scripts/codex-samples.test.ts`
Expected: FAIL, the module doesn't exist.

- [ ] **Step 2: Implement `sampleInstances`, and run the Step 1 command.** Expected: PASS.

- [ ] **Step 3: Extend the generator, and regenerate.** It writes `schema/` and `fixtures/` for `RUNTIME_SCHEMAS`
  before the stamp. It refuses to write any file over 1 MB, in `schema/` as much as in `fixtures/`, naming it: the
  pre-commit hygiene check (`scripts/hooks/hygiene.mjs`) refuses such a file. A per-type schema embeds every
  definition it reaches. On 0.167.0 the largest is `ThreadStartResponse.json` at about 84 KB. If one goes over the
  limit, stop and report it: never split or trim a generated file by hand.

Run: `pnpm --filter @10db/daemon generate:codex && pnpm --filter @10db/daemon drift`
Expected: the new folders are written, and `drift` passes on the new `STAMP`.

- [ ] **Step 4: Write the type and fixture tests** (`codex-protocol.test.ts`).

```ts
import { expectTypeOf } from 'vitest';
import type { z } from 'zod';
import type { GetAccountResponse } from './codex-generated/ts/v2/GetAccountResponse';
// … one type import per generated type in the RUNTIME_SCHEMAS table

/** JSON carries every integer as a number; ts-rs writes a 64-bit one as bigint. */
type Wire<T> = T extends bigint
  ? number
  : T extends readonly (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

// Everything the pinned Codex can send for a method, 10db's schema accepts.
// One line per table row; ThreadResponse gets two.
expectTypeOf<Wire<GetAccountResponse>>().toExtend<z.input<typeof AccountReadResponse>>();
expectTypeOf<Wire<HooksListResponse>>().toExtend<z.input<typeof HooksListResponse>>(); // timeoutSec is bigint in TS

describe('the runtime Codex schemas', () => {
  it.each(ROWS)('read every payload the generated schema allows for $type', ({ type, runtime }) => {
    // ROWS: { type: 'v2/GetAccountResponse', runtime: AccountReadResponse }, … as in the table
    const generated = z.fromJSONSchema(schemaFile(type)); // schemaFile parses the JSON at the boundary
    for (const payload of fixtureFile(type)) {
      expect(generated.safeParse(payload).success, JSON.stringify(payload)).toBe(true);
      expect(runtime.safeParse(payload).success, JSON.stringify(payload)).toBe(true);
    }
  });
  it('has a fixture file for every row, and a row for every fixture file', ...);
  it('names in MODEL_ITEMS only item types the pinned Codex has, apart from the ones known absent', () => {
    // itemTypes: every `type` value of a ThreadItem branch in schema/ItemCompletedNotification.json
    expect([...MODEL_ITEMS].filter((t) => !itemTypes.has(t) && !ABSENT_FROM_PIN.has(t))).toEqual([]);
    // A name listed absent that the pin now has comes off the list.
    expect([...ABSENT_FROM_PIN].filter((t) => itemTypes.has(t))).toEqual([]);
  });
});
```

  `ABSENT_FROM_PIN` is a set declared in this test, empty unless Step 6 finds a name.

- [ ] **Step 5: Prove the tests catch the GCP bug.** Temporarily remove the `gcp` branch Task 2 added.

Run: `pnpm --filter @10db/daemon typecheck; pnpm --filter @10db/daemon exec vitest run src/sessions/codex-protocol.test.ts`
Expected: both FAIL: `tsc` on the `GetAccountResponse` line, and vitest on the `{ "account": { "type": "gcp" }, … }`
fixture. Restore the branch.

- [ ] **Step 6: Run them on the real code.** Same command. Expected: both PASS.

  If a row fails for any reason other than `gcp`, that is drift Codex already shipped. **(call)** Loosen the runtime
  schema in `codex-protocol.ts` to accept what the generated schema allows (never narrow it), rerun every
  `src/sessions/codex-*.test.ts`, and list each change in the PR body. If loosening would change what 10db does with
  the value, stop and report it instead.

  **Never change `MODEL_ITEMS` to make the test pass.** It decides when a message counts as consumed. If the
  `MODEL_ITEMS` row fails because a name is absent from 0.167.0:
  1. Keep the name in `MODEL_ITEMS`.
  2. Add it to `ABSENT_FROM_PIN`, with a comment naming the pinned version.
  3. Report it in the PR body, for the builder to decide.

- [ ] **Step 7: Run the daemon's sessions tests, lint and knip.**

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions scripts && pnpm exec eslint --max-warnings=0 apps/daemon && pnpm knip`
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add apps/daemon/scripts/codex-samples.ts apps/daemon/scripts/codex-samples.test.ts apps/daemon/scripts/codex-generate.ts apps/daemon/src/sessions/codex-generated apps/daemon/src/sessions/codex-protocol.test.ts && git commit -m 'test(daemon): the runtime codex schemas read every shape the pinned codex can send

Red by: the gcp branch of Account removed (tsc and the fixture test both failed).

Value: protects=codex-protocol.ts accepts every payload the pinned Codex may send for the methods 10db reads;
fails_when=a pin bump adds a variant or enum value, makes a required field optional or nullable, or renames a field 10db requires;
why_new=the codex tests feed hand-written payloads, which never hold a variant 10db forgot;
no_claim=fields 10db reads as optional that Codex renamed, and the narrow login and item schemas

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

Add `apps/daemon/src/sessions/codex-protocol.ts` to the `git add` if Step 6 changed it.

---

### Task 5: The decision record, then the PR

**Files:**

- Create: `docs/architecture/decisions/./2026-11-12-codex-protocol-types-are-generated-and-stamped.md`

- [ ] **Step 1: Write the record** in the README's format (`docs/architecture/decisions/README.md`). Title: "Codex
  protocol types are generated from the pinned binary and checked by a stamp". **Decision**, specific enough to
  check the code against:
  - `pnpm --filter @10db/daemon generate:codex`, run on a Mac, verifies the pinned tarball through `ensureAgent` and
    runs `codex app-server generate-ts` and `generate-json-schema`.
  - It writes `apps/daemon/src/sessions/codex-generated/`:
    - `ts/`: the import closure of the three root unions and the responses 10db reads
    - `schema/` and `fixtures/`: per-type JSON schemas and sampled payloads for the types `codex-protocol.ts` reads
    - `STAMP`: the version and a sha256 of the rest
  - The folder is checked in. Prettier, ESLint and knip ignore it.
  - The daemon's `drift` script, and so `make gate`, checks only that `STAMP` names `CODEX_VERIFIED_ON` and that its
    hash matches.
  - `codex-protocol.ts` stays the loose runtime validator. A type test checks that every generated type (bigint read
    as number) is assignable to its schema's input. A fixture test checks that every sampled payload passes the
    generated schema and the runtime one.
  - Renovate's Codex PR note names the command.

  **Why:**
  - The hand types went stale: the `gcp` account variant.
  - The darwin binary can't run in CI's Linux shards or a lane's gate.
  - `z.fromJSONSchema` at runtime is strict on objects and gives no static types (research T2).
  - codex-acp was turned down: it loses receipts and adds a second pin (research T2).
  - The type test's direction (generated to runtime input, not runtime output to generated) is what a tolerant reader
    needs. The other direction fails on every field 10db reads loosely, and misses a variant Codex adds.

- [ ] **Step 2: Run the repo's doc tests.**

Run: `pnpm exec vitest run --project repo tests/repo/src/architecture-docs.test.ts && pnpm format:check`
Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add docs/architecture/decisions/./2026-11-12-codex-protocol-types-are-generated-and-stamped.md && git commit -m 'docs: codex protocol types are generated from the pinned binary and checked by a stamp

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

- [ ] **Step 4: Gate, push, PR.** Run `make gate` once. Expected: the last line is `GATE PASS …`. Then
  `git push -u origin feat/sessions-m1` and `gh pr create` with:
  - Title: `feat: codex protocol types are generated and stamped, mantine 9.8, and a codex account on gcp no longer breaks`
  - Body:
    - what the builder sees: nothing, except that a Codex home on GCP is refused with a clear card
    - the click-through result from Task 1
    - any schema Task 4 loosened
    - the mcp-server version if Step 1 of Task 1 changed it
    - any `MODEL_ITEMS` name in `ABSENT_FROM_PIN`
    - ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

---

## Review round 1: where each finding went

| Finding | Where |
| --- | --- |
| F1: the 1 MB hygiene limit covers `schema/` too | Task 4 Step 3: the generator refuses any file over 1 MB, in `schema/` and `fixtures/` alike, and stops |
| F2: a `MODEL_ITEMS` name absent from 0.167.0 | Task 4 Step 4 (`ABSENT_FROM_PIN` in the test), Step 6 (keep the name, list it, report it; never edit `MODEL_ITEMS`), Task 5 PR body |
| F3: the publish time and `mantine-datatable`'s peer range | Task 1 Step 1: `npm view @mantine/core time --json`, read `"9.8.0"`; `mantine-datatable@9.4.0` peer check |
| F4: placeholder tests | Task 2 Step 1 (`codex-session.test.ts`, written out on `startWith` and `collect`); Task 3 Step 1 (closure and stamp tests, written out) |
| F5: `generate:codex` writes outside the worktree and needs the network | Global Constraints: it runs in a plain Mac session, never a sandboxed lane |
| Line ref: `WrongCredentials` | Task 2 intro: `account-check.ts:148-153` |
