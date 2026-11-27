# Task 2: `modelEnv` in the gate sandbox (Track B) — Core: the sandbox

**Files:** `apps/daemon/src/sandbox/gate-sandbox.ts`, `apps/daemon/src/verify/gate-runner.ts`,
`apps/daemon/src/sandbox/AGENTS.md`, `apps/daemon/src/verify/AGENTS.md`, `apps/daemon/test/gate-sandbox.seatbelt.test.ts`.

**Implements** on `GateRunInput` and `GateRequest`:

```ts
/** The live run's model env: set after the allowlist; the name is checked again here. */
readonly modelEnv?: { readonly name: string; readonly value: string };
```

- Added to `commandEnv` after `allowlisted(…)`, `TMPDIR`, `prepareCommandEnv` and `PATH`, and only when the name
  passes `isReservedEnvName` from contracts and is not any key already in `commandEnv`; otherwise
  `SandboxProfileError('modelEnv', …)`, and nothing runs. The value must match `^[A-Za-z0-9._/:@,-]{1,1100}$`
  (the second check behind task 3's).
- Passed through `shellAssignments` like every other name, so it is quoted the same way.
- Only the live-run path passes it (task 3); document that in both AGENTS.md files.
- One check that `isReservedEnvName` covers every name the allowlist passes and every name `commandEnv` sets
  (a pure test over the exported allowlist, since a drift here would let the model env replace one).

**Rows:** none directly.

**Tests (core: the sandbox):** extend `gate-sandbox.seatbelt.test.ts` (real srt) with one case: a command
`printenv MODELS` given `modelEnv: { name: 'MODELS', value: 'google/x,openai/y' }` prints that value; a request
naming `PATH` or `TMPDIR` is refused before spawn; a value with a space or `;` is refused. Prove red first.

**Index sections:** Global constraints ("The model env is the only addition…").
