# Evals slice 5: run a suite's live arm from 10db

**Size: Core** (data sent out, spend, recovery, secrets-adjacent: env files). Index plus one card per task; Fable plan
review done (two rounds), then cut to what the builder's real suites need (task 0's spike).
Cards: `2026-11-25-evals-live-run/task-<n>.md`.

## Brief

**What changes for you.** A suite's drawer, and a covered task's Evals block, get **Run**. It opens a confirm window
that shows exactly what will run: the live command, that it runs in your containers, the env files compose may
read, how it stops, its time limit, and what the last run cost ("last run $4.12", or "unknown"). Press Run and 10db
runs that command in your checkout, contained, while the window shows it running with a Stop button. When it ends
you see the exit code and the output's last lines; the new result shows on the page and turns a covered task's
"not run" into passing or regressed. Nothing runs unless you press Run: there is no unattended spend.

**What it buys.** Measuring landed work is one click, from the place that told you it wasn't measured.

**How your suites run (task 0's spike).** Both projects' live evals are `docker compose exec …` into the stack you
already run, and their keys live there: ampsio's OpenRouter key in the stack's env, orgtools' AWS credentials in
its `~/.aws` mount. So 10db passes **no key**: the command gets the Docker socket, the env files compose reads
(orgtools names three: `.env`, `orgtools/backend/.env.dev`, `orgtools/frontend/.env`; ampsio none, since its
Makefile uses `.env.example` under 10db's sandbox), readable and never writable, and nothing else. It opens no
hosts; the containers keep their own network. The window says so in one line. The stack must be up; the window
says that too. Stop and the time limit end 10db's side and run the suite's stop command, which ends the work
inside the container (ampsio's ends `run_eval`).

**What could go wrong, and how we'd know.**
- *The command isn't what you think.* Only you and your own sessions write the manifest (lanes can't reach the
  daemon's token). The window shows the command as stored, and Run refuses if anything it showed changed since.
- *A run spends more than expected.* The cost shown is the last run's, labelled so; Stop works at any time.
- *10db crashes mid-run.* The run's processes are in a ledger, so the next start stops them, runs the suite's stop
  command, and records the run as interrupted; nothing reruns.
- *A report stays inside the container.* Slice 1 reads ampsio's 123 reports from the checkout, so `make eval`
  already writes them where the checkout sees them; the first real Run confirms it.

**Calls you might disagree with.**
1. **No key path yet.** 10db can't hand a key to a suite that calls a provider directly from your Mac; none of
   your suites does. It is an addition later (the earlier plan's `.env`/Keychain/AWS design is in git history).
2. **One live run per project at a time.** Evals share a container or database; a second Run says one is running.
3. **Runs are recorded** (what ran, cost shown, outcome) in a new table, where a per-project spend grant would hang
   later. None is built.
4. **The checkout's command runs, not the base commit's** (the spec's line): results live in the checkout, and slice
   2's marker is the before/after verdict.

**Needed from you.** Nothing. Screenshots of the confirm window come before task 4 is reviewed.

## Global constraints

- `.claude/rules/code-style.md` and `testing.md` bind. zod at every boundary (the manifest's new field, the routes).
- Hard limits (root `AGENTS.md`): no key or other secret is passed to the command; only the suite's `envFiles` open
  for reading (never writing) and only for a Docker suite; no hosts open for a Docker suite and only the suite's
  hosts otherwise; loopback only when both the suite and the project allow it; nothing runs without a click; this
  path never turns a project's Docker switch on.
- A live run uses the **unslotted** gate runner (`verify/AGENTS.md`: one runner, never a second; slotted gates must
  not wait on a paid eval). It passes no `project.id`, so `autoDocker` returns early (`daemon/auto-docker.ts:86`).
- A daemon with no gate sandbox (fake sessions) or no process ledgers refuses a live run (`no_sandbox`).
- Each live run's process group, and its stop command's, is tracked in a process ledger (the preview's pattern).
- Routes use `:projectId` as `api/app.ts` does.
- The migration is generated last, after the final merge of `origin/main` (root `AGENTS.md`).

## Provider parity

| | Claude plan | Bedrock / API key | ChatGPT / Codex plan |
| --- | --- | --- | --- |
| Run, preview, record | the daemon's; no model of 10db's | same | same |
| The model calls | inside the project's containers, on the project's own keys, never 10db's account | same | same |

## Interfaces

```ts
// packages/contracts/src/evals.ts (task 1)
export const EvalHost = z.string().max(253).regex(/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/); // no wildcard over a bare TLD
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
// EvalManifestSuite gains `live: EvalLiveRun.optional()`; the manifest refuses `live` without `liveCommand`.

export const EvalLiveRunState = { Running: 'running', Passed: 'passed', Failed: 'failed', Stopped: 'stopped',
  TimedOut: 'timed_out', Interrupted: 'interrupted' } as const;
export const EvalLiveRefusal = { NoLive: 'no_live', NoSandbox: 'no_sandbox', DockerOff: 'docker_off',
  ManifestChanged: 'manifest_changed', Busy: 'busy' } as const;

export const EvalLiveRunDto = z.object({
  id: EvalLiveRunId, projectId: ProjectId, suiteKey: EvalSuiteKey, state: z.enum(EvalLiveRunState),
  startedAt: z.string(), endedAt: z.string().nullable(), exitCode: z.number().nullable(), tail: z.string(),
  costShownUsd: z.number().nullable(), stopRan: z.boolean(),
});
export const EvalLivePreviewDto = z.object({
  suiteKey: EvalSuiteKey, command: z.string(), stopCommand: z.string().nullable(), docker: z.boolean(),
  hosts: z.array(z.string()), envFiles: z.array(z.string()), loopback: z.boolean(), timeoutMinutes: z.number(),
  lastRunCostUsd: z.number().nullable(), previewHash: z.string(), refusal: z.enum(EvalLiveRefusal).nullable(),
  running: EvalLiveRunDto.nullable(),
});
export const RunEvalLiveBody = z.strictObject({ previewHash: z.string().min(1).max(128) });
// EventType.EvalLiveRunChanged = 'eval.live_run_changed', data { projectId, suiteKey, runId, state }

// Routes (task 3)
// GET  /projects/:projectId/evals/:suiteKey/live          -> EvalLivePreviewDto (classify in render-access.ts)
// POST /projects/:projectId/evals/:suiteKey/live/runs     RunEvalLiveBody -> 201 EvalLiveRunDto | 409 { refusal, message }
// POST /projects/:projectId/evals/live/runs/:runId/stop   -> 204
// GET  /projects/:projectId/evals/live/runs?suite=        -> EvalLiveRunDto[] newest first, 5 (classify)

// apps/daemon/src/sandbox/gate-sandbox.ts, verify/gate-runner.ts (task 2; the spike's 5ef52cb08 started it)
readonly dotEnvReadable?: readonly string[];   // checkout-relative env files open for reading, never writing

// apps/daemon/src/evals/live-runs.ts (task 3)
export function previewHash(suite: EvalManifestSuite, project: Pick<ProjectDto, 'sandboxDocker' | 'sandboxLoopback'>): string;
export interface EvalLiveRuns { preview; start; stop; list; recoverAtStart(): Promise<void>; stopAll(): Promise<void> } // card 3
// packages/db: table eval_live_runs; repository packages/db/src/store/eval-live-runs.ts (card 3)
```

## State table (design, not a test list)

| State \ event | Run click | Stop | Process exits | Timeout | Manifest write | Daemon stop | Daemon start |
| --- | --- | --- | --- | --- | --- | --- | --- |
| none | hash matches, no refusal → `running`; else 409 with the reason, no row | — | — | — | — | — | — |
| `running` | 409 `busy`, no row | abort; stop command if any → `stopped` | exit 0 → `passed`, else `failed` | abort; stop command → `timed_out` | no effect | abort; stop command; await → `interrupted` | — |
| `running` row after a crash | 409 `busy` until start's recovery | — | — | — | — | — | the ledger reap kills the group; the stop command runs if the row has one and the manifest still hashes the same; then `interrupted` |
| finished | as none | 404 | — | — | — | — | — |

Exit 0 means the command succeeded, not that the eval passed; the eval's verdict is the result file it writes, read
by the existing page and by slice 2's marker. A project archived or removed while running: as daemon stop.

## Tracks

- **Task 0 (done):** the spike, `~/Agents/scratch/10db/2026-11-25/evals-2-5/s5/spike.md`, commit `5ef52cb08`.
- **Track A:** task 1, then task 3, then task 4, one implementer, in `../10db-worktrees.noindex/evals-s5` on the
  integration branch `feat/evals-live-run`.
- **Track B:** task 2, one implementer, in its own worktree off `feat/evals-live-run`, merged into it before task 3
  starts.

## Tasks

0. Spike (done). `task-0.md`
1. Contracts and the manifest's `live` field; the assessment step and CLI learn it. `task-1.md`
2. `dotEnvReadable` in the gate sandbox, finished, with a seatbelt test. `task-2.md`
3. The live-run service: preview, hash, click, run, stop, ledger, record, recover, routes; migration last. `task-3.md`
4. The UI: Run in the drawer and the covered-task block, the confirm window, running, done; e2e. `task-4.md`
