# Task 3: the live-run service — Core: spend, data sent out, recovery

**Files:** `apps/daemon/src/evals/live-runs.ts` (new), `apps/daemon/src/evals/live-runs.test.ts` (new),
`apps/daemon/src/evals/index.ts`, `apps/daemon/src/api/app.ts` (routes), `apps/daemon/src/api/services.ts` and
`apps/daemon/src/daemon/services.ts` (the service methods; `archiveProject` at `daemon/services.ts:493` and project
removal stop the project's run), `apps/daemon/src/daemon/start.ts` (wiring: the unslotted gate runner, the process
ledgers, `recoverAtStart` after the ledger reap and before routes serve, `stopAll` in `stop()`),
`apps/daemon/src/screens/render-access.ts` (the two GETs), `packages/db/src/schema.ts`,
`packages/db/src/store/eval-live-runs.ts` (new) and its export, the migration (generated last, after merging
`origin/main`), `apps/daemon/src/evals/AGENTS.md`.

**Implements:**

```ts
export function previewHash(suite: EvalManifestSuite,
  project: Pick<ProjectDto, 'sandboxDocker' | 'sandboxLoopback'>): string;
export interface EvalLiveRunsDeps {
  readonly gates: GateRunner;                 // the unslotted runner
  readonly ledgers: PreviewLedgers | null;    // null (or no sandbox) refuses `no_sandbox`
  readonly sandboxed: boolean;                // false in a fake-session daemon
  readonly dataDir: string;
  readonly clock: Clock;
}
export interface EvalLiveRuns {
  preview(projectId: ProjectId, suiteKey: EvalSuiteKey): Promise<EvalLivePreviewDto>;
  start(projectId: ProjectId, suiteKey: EvalSuiteKey, previewHash: string): Promise<EvalLiveRunDto>; // throws EvalLiveRefused
  stop(projectId: ProjectId, runId: EvalLiveRunId): Promise<void>;
  list(projectId: ProjectId, suiteKey: EvalSuiteKey | null): EvalLiveRunDto[];
  recoverAtStart(): Promise<void>;
  stopAll(): Promise<void>;
}
export class EvalLiveRefused extends Error {
  override readonly name = 'EvalLiveRefused';
  readonly refusal: EvalLiveRefusal;
}
// packages/db/src/store/eval-live-runs.ts
insertEvalLiveRun(tx, row): EvalLiveRunRow; finishEvalLiveRun(tx, id, patch): void;
listEvalLiveRuns(tx, projectId, suiteKey | null, limit): EvalLiveRunRow[];
runningEvalLiveRun(tx, projectId): EvalLiveRunRow | null; interruptRunningEvalLiveRuns(tx, at): EvalLiveRunRow[];
// table eval_live_runs: id, project_id, suite_key, command, stop_command, preview_hash, docker, hosts_json,
// env_files_json, state, started_at, ended_at, exit_code, tail, cost_shown_usd, stop_ran, log_path
```

**Calls:** `GateRunner.run(request: GateRequest): Promise<GateResult>` (`verify/gate-runner.ts`, with task 2's
`dotEnvReadable`); `openPreviewLedger(deps: PreviewLedgers, onError): PreviewLedger`, `PreviewLedger.track(pid)` and
`.end()` (`preview/preview-ledger.ts:22-40`; import it through `preview`'s entry point, or move it to a shared
module named for what it does if `preview` shouldn't export it).

- **Preview:** the stored manifest's suite (404 if none); `refusal` without starting anything: `no_live` (no `live`
  or no `liveCommand`), `no_sandbox`, `docker_off` (`live.docker` and the project's `sandboxDocker` off), `busy`
  (with `running` set). `lastRunCostUsd` is the suite's newest run's `costUsd` (`evals/run-summary.ts`), null when
  unknown.
- **`previewHash`:** sha256 over the command, stop command, docker, hosts, env files, loopback, timeout and the
  project's Docker and loopback switches. `start` recomputes it from the manifest as stored now and refuses
  `manifest_changed` on a mismatch. The POST is the click; there is no other way to start.
- **Start:** refusals throw `EvalLiveRefused` (409 with the refusal and a message) and write no row. The `running`
  check and insert are one write, so two clicks can't both start. `GateRequest`:
  - `project` = `{ repoPath, sandboxLoopback: live.loopback && project.sandboxLoopback, sandboxDocker: live.docker &&
    project.sandboxDocker }`, with no `id`;
  - `rules` = only `live.hosts` as `{ toolName: 'SandboxNetworkAccess', pattern }` (none for a Docker suite), not the
    project's stored rules;
  - `checkouts` = every registered checkout, as a gate's; `env` = the project env; `dotEnvReadable` = `live.envFiles`;
    `timeoutMs` from `timeoutMinutes`; `logPath` = `<dataDir>/logs/evals/<runId>.log`; `signal` from the run's
    `AbortController`; `onSpawn` = `ledger.track(pid)`.
- **Stop, timeout, daemon stop, archive:** abort, then, when the suite has a `stopCommand`, run it once through the
  same runner with the run's whole request but the command (2-minute limit), tracked in the same ledger, and set
  `stopRan`. Stop → `stopped`; timeout → `timed_out`; daemon stop and archive → `interrupted`. `ledger.end()` once
  the run and any stop command have settled.
- **Finish:** exit 0 → `passed`, else `failed`; the tail stored; `eval.live_run_changed` on every state change, and
  the project's change event at the end so the page refetches.
- **Recovery:** start's ledger reap (`reapLaneProcessLedgers`) stops a crashed run's group; then `recoverAtStart`
  marks every `running` row `interrupted` and, for a row with a `stop_command` whose suite's current manifest entry
  still hashes to the row's `preview_hash`, runs it as Stop does (else `stopRan` stays false and the drawer says the
  work in the containers may still be running). It never starts the live command.

**Rows:** all of the index's state table.

**Tests (core: spend, recovery; a real SQLite file in a temp dir, the real gate runner over the gate sandbox with
`FAKE_SRT`, `apps/daemon/test/fake-srt.ts`):** one test through the wiring: a start with a stale `previewHash` is
refused `manifest_changed` and runs nothing; a second start while one runs is refused `busy`; a run of a suite whose
command calls `docker` leaves the project's `sandbox_docker` off; a `running` row left by a crash is `interrupted`
after `recoverAtStart`. Red first.

**Spec:** "Slice 5"; the index's brief and Global constraints.
