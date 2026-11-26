# apps/daemon/src/app-start

- `app-start/` (`decisions/2026-11-26-10db-brings-the-dev-stack-up-before-a-picture-or-a-sign-in.md`):
  `createAppStart` answers `ensureUp(projectId, signal)` for `pictures/` (a capture, a sign-in, `shootNow`, through
  `PicturesDeps.ensureApp`). With no app address or no `appStartCommand` it answers up at once; when the address
  answers (`preview/`'s `appAnswers`) it clears the project's card; otherwise it runs the start command once through
  the unslotted gate runner (no project id, `sandboxDocker` true) and waits for the address. One run per project at a
  time is shared by every ask; a caller's abort frees only that caller.
- Docker Desktop is opened (`docker-desktop.ts`, `open -a Docker`) only when no engine socket answers and the project
  uses Docker (`usesDocker`: the switch is on, or `commandCallsDocker` sees the command call docker in
  `origin/<base>`).
- A failure raises `inbox/app-start-card.ts`'s one status card and is remembered by command and address for
  `retryAfterMs`; asks in that time get its words and run nothing. `stop()` aborts a run in flight without a card.
