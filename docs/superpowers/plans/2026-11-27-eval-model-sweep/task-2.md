# Task 2: `modelEnv` in the gate sandbox — Core: the sandbox

**Files:** `apps/daemon/src/sandbox/gate-sandbox.ts`, `apps/daemon/src/sandbox/env-allowlist.ts` (export a
`looksSecret(name)` over its `SECRET_LOOKING`), `apps/daemon/src/verify/gate-runner.ts`, the `AGENTS.md` of both
directories, `apps/daemon/test/gate-sandbox.seatbelt.test.ts`, `apps/daemon/src/sandbox/gate-sandbox.test.ts`.

**Implements:** `modelEnv` on `GateRequest` and `GateRunInput` (index, Interfaces).

- It is added to `commandEnv` last and is **refused when reserved**: `SandboxProfileError('modelEnv', …)` and
  nothing runs (Design › The manifest's sandbox rule). The value must match `^[A-Za-z0-9._/:@,-]{1,1100}$`, a
  second check behind task 3's.
- It goes through `shellAssignments` like every other name. Document that only the live-run path passes it.

**Tests (core: the sandbox):**
- `gate-sandbox.test.ts` (FAKE_SRT): requests naming `PATH`, `TMPDIR`, `OPENAI_API_KEY` or an allowlisted name are
  refused before spawn, and so is a value with a space or `;`.
- `gate-sandbox.seatbelt.test.ts` (real srt): `printenv MODELS` prints the value.

Prove each red first.

**Index sections:** Global constraints; Design › The manifest.
