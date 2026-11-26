# Task 4: the UI and the e2e (Track A)

**Files:** `apps/desktop/src/views/evals/live-run-modal.tsx` (new), `apps/desktop/src/views/evals/suite-drawer.tsx`,
slice 2's Evals block in the task drawer (#888; find it under `apps/desktop/src/views/board/`),
`apps/desktop/src/daemon/evals-queries.ts`, `apps/desktop/src/daemon/events.ts` (the invalidation for
`eval.live_run_changed`), `apps/desktop/src/views/evals/AGENTS.md`, `apps/desktop/e2e/project-trust.spec.ts`.

**Calls (index Interfaces):** `GET /projects/:projectId/evals/:suiteKey/live` → `EvalLivePreviewDto`;
`POST /projects/:projectId/evals/:suiteKey/live/runs` `{ previewHash }` → `EvalLiveRunDto` | 409
`{ refusal, message }`; `POST /projects/:projectId/evals/live/runs/:runId/stop`;
`GET /projects/:projectId/evals/live/runs?suite=` → `EvalLiveRunDto[]`. `encodeURIComponent` the suite key.

- **Run** beside the live command in the suite drawer, and "Run now" in a covered task's Evals block. A suite with no
  `live` shows the command with "The assessment hasn't said how this command runs" and Copy the Ask, no Run.
- The confirm window (a Mantine `Modal`): the command in a code block; for `docker`: "Runs in your containers, with
  their keys and network. Needs your stack running." and, when `envFiles` is not empty, "Compose may read: <files>";
  otherwise "May reach: <hosts>" or "No hosts"; the stop line ("Stop also runs: <stopCommand>", or for a Docker
  suite with none, "Stop ends 10db's side; work in your containers may keep running"); "Stops after <n> minutes";
  "Last run $x" or "Last run cost unknown". A refusal shows its reason and its way out (Settings › Allow Docker for
  `docker_off`) and no Run. Run posts the preview's `previewHash`; a `manifest_changed` 409 reloads the preview and
  says the window now shows what changed.
- Running: elapsed time and Stop; then the state in words (text, never a pill), the exit code and the tail in a code
  block. The window can close while it runs; the drawer shows the running run with Stop, and its last five runs; an
  interrupted run whose stop didn't run says the work in the containers may still be running.
- **Before review:** click through preview → Run → running → Stop, and preview → Run → done, on the Mac's real daemon
  (a dev daemon from this worktree on ports 4337/1437 with its own data dir under `.dev/`, `TENDB_DEV_UI_TOKEN` of 32+
  characters) with an `echo` suite (`live: {}`), and save screenshots of the confirm window, running and done states
  to `~/Agents/scratch/10db/2026-11-25/evals-2-5/s5/screens/`.

**Rows:** the UI side of every row (Run click, Stop, refusals, busy, manifest changed).

**Tests:** extend the evals flow in `project-trust.spec.ts`: a manifest with a `live` suite (`echo done`); the e2e
daemon has no sandbox, so the window shows the `no_sandbox` refusal with no Run; a suite without `live` shows no Run.
No component test.

**Spec:** "Slice 5"; the index's brief.
