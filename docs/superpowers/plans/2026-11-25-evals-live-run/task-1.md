# Task 1: contracts and the manifest's `live` field (Track A)

**Files:** `packages/contracts/src/evals.ts`, `packages/contracts/src/events.ts`, `packages/contracts/src/ids.ts`
(`EvalLiveRunId`, through the ID module), regenerated `packages/contracts/generated/`, the `10db-task` skill
(`packages/agent-skill`, "Assess a project's evals") and the `evals` CLI's help, `apps/daemon/src/evals/AGENTS.md`.

**Implements (the index's Interfaces, quoted):**

```ts
export const EvalHost = z.string().max(253).regex(/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/);
export const EvalEnvFile = z.string().min(1).max(300)
  .refine((p) => /(^|\/)\.env[^/]*$/.test(p) && !p.startsWith('/') && !p.split('/').includes('..'));
export const EvalLiveRun = z.strictObject({
  docker: z.boolean().default(false),
  hosts: z.array(EvalHost).max(10).default([]),
  envFiles: z.array(EvalEnvFile).max(5).default([]),
  loopback: z.boolean().default(false),
  stopCommand: z.string().min(1).max(300).optional(),
  timeoutMinutes: z.number().int().min(1).max(240).default(60),
})
  .refine((l) => !l.docker || l.hosts.length === 0, 'a Docker suite opens no hosts')
  .refine((l) => l.docker || l.envFiles.length === 0, 'only a Docker suite reads env files');
```

plus `EvalLiveRunState`, `EvalLiveRefusal` (as `as const` objects with derived types), `EvalLiveRunDto` (declared
before) `EvalLivePreviewDto`, `RunEvalLiveBody`, and `EventType.EvalLiveRunChanged = 'eval.live_run_changed'` (data
`{ projectId, suiteKey, runId, state }`), exactly as the index writes them.

- `EvalHost` is stricter than `isSandboxDomain` (`apps/daemon/src/sandbox/profile.ts:135`), which allows `*.com`; say
  where the daemon's rule lives in a comment, since contracts can't import the daemon.
- `EvalManifestSuite` gains `live: EvalLiveRun.optional()`; `EvalManifest` refuses a suite with `live` and no
  `liveCommand`. The manifest recording (`apps/daemon/src/evals/service.ts`) refuses an `envFiles` entry that is not
  a regular file in the checkout (it is untracked, so check the working tree, `lstat`, no link), as it refuses an
  untracked definition path.
- The skill's assess step records `live` for a suite with a live arm: `docker: true` when the command reaches
  containers (`docker compose exec …`), with the env files its compose files' `env_file:` entries and the project's
  `.env` name (only those compose needs under 10db's sandbox, `TENDB_SANDBOX=1`; ampsio's Makefile switches to
  `.env.example`, so it needs none); a `stopCommand` that ends the work inside the container; `hosts` only for a
  non-Docker suite; `loopback` only for a command that calls a local server. When unsure, leave `live` out: a suite
  without it has no Run. The skill's ampsio and orgtools examples come from task 0's report
  (`~/Agents/scratch/10db/2026-11-25/evals-2-5/s5/spike.md`).

**Rows:** none (shapes only). **Tests:** none; task 3's wiring test exercises the shapes.

**Spec:** "Slice 5: run the live arm from 10db"; "The manifest" under Slice 1.
