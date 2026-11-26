# Task 2: `dotEnvReadable` in the gate sandbox, finished (Track B) — Core: secrets

The spike (commit `5ef52cb08`) added `dotEnvReadable?: readonly string[]` to `GateRunInput` and `GateRequest`, and
`--docker` and `--dot-env <file>` to `apps/daemon/scripts/sandboxed-gate.ts`, with no tests or docs. Finish it.

**Files:** `apps/daemon/src/sandbox/gate-sandbox.ts`, `apps/daemon/src/verify/gate-runner.ts`,
`apps/daemon/scripts/sandboxed-gate.ts`, `apps/daemon/src/sandbox/AGENTS.md`, `apps/daemon/src/verify/AGENTS.md`,
`apps/daemon/test/gate-sandbox.seatbelt.test.ts`.

**Implements:** on both `GateRunInput` (`sandbox/gate-sandbox.ts:58`) and `GateRequest` (`verify/gate-runner.ts:37`):

```ts
/** Checkout-relative env files open for reading, never writing: a Docker live run's, whose compose reads them. */
readonly dotEnvReadable?: readonly string[];
```

- Each named file is realpath'd and must stay inside the checkout and be a regular file; one that isn't is refused
  (`SandboxProfileError`), never opened by a link.
- Only the named files open for reading; every other `.env*` that `secretFilesIn` finds stays closed
  (`gate-sandbox.ts:298-342`, `splitSecrets`), and every `.env*`, the opened ones included, stays in `denyWrites`
  (`gate-sandbox.ts:343`): an untracked `.env` truncated is lost for good.
- Review the spike's code against these rules (it was written in a hurry) and fix what doesn't hold.
- Docs: the sandbox notes say what `dotEnvReadable` opens and who passes it (only a live eval run, task 3).

**Rows:** none directly; task 3 relies on this.

**Tests (core: the sandbox):** extend `test/gate-sandbox.seatbelt.test.ts` (real srt, macOS) with one case: a run
with `dotEnvReadable: ['.env', 'sub/.env.dev']` in a checkout that also holds `sub/.env.local` reads `.env` and
`sub/.env.dev`, can't read `sub/.env.local`, and can't write or truncate `.env`; a name that is a link out of the
checkout is refused. Prove red first (before the change, `.env` can't be read).

**Spec:** "Slice 5"; the index's "How your suites run".
