# apps/daemon/src/pictures

- `pictures/`'s browser (`decisions/2026-11-10-task-pictures-come-from-a-pinned-chromium-and-stay-on-the-mac.md`): only
  `pictures/playwright.ts` and `pictures/playwright-camera.ts` touch `playwright-core`, and only `playwright.ts`
  loads it at runtime (a dynamic import). The browser is Chrome for Testing's headless shell at `BROWSER_PIN`
  (`browser-pin.ts`), which must be the build the pinned `playwright-core`'s `browsers.json` names (a test fails
  when they part); it is fetched, checked and locked down by `environment/pinned-install.ts` (`PinnedRelease`,
  `extractZipWithTar`). `browser-host.ts` launches it on first use with the renderer sandbox on, `HOME` and
  `TMPDIR` only, artifacts under `<data dir>/browser/artifacts`, and every request, loopback included, through
  `app-proxy.ts`'s proxy as Chromium's own switches (`launchOptions`); it runs one shot or sign-in at a time,
  holds the browser's processes in a lane process ledger (`browser-ledger.ts`: the browser is the daemon's child
  whose executable, by its real path, is the pinned one; `ps`'s `comm` on macOS, `/proc/<pid>/exe` on Linux, whose
  `comm` is a cut name), refuses to launch with no ledger sweep, and closes after five idle minutes. The proxy
  forwards only the app's origin and a `CONNECT` to its host and port (`origin-guard.ts`, `proxyAllows`), and,
  for a shot of 10db's own dev UI, reads of the daemon's exact origin (`decisions/2026-11-12-the-pictures-browser-reads-the-daemon-for-10dbs-own-ui.md`);
  Playwright's routing (`requestAllowed`) is a first check only, because it never sees a redirect's next hop.
  `shotOutcome` and `OVERLAY_SELECTORS` are pure. `src/pictures/browser.live.test.ts` runs the real headless
  shell behind `TENDB_LIVE_BROWSER=1`, never in CI; a bump of `BROWSER_PIN` or `playwright-core` passes it first.
- `pictures/`'s service (Workbench spec §10-§13): `startPictures` (`pictures.ts`) starts after recovery and drives
  one capture queue (`capture-queue.ts`, a pure step over §3.2 of the plan: one load at a time; a newer turn
  picture replaces the waiting one; the page's next turn, a take-out, a pass entering CLOSING or ABANDONING and a
  changed app address abort a load, and nothing of an aborted load is written; a closing or abandoning pass's
  afters wait until it leaves that state; while the browser downloads only befores wait). It follows the bus:
  `pass.opened` and `pass.changed` (befores for open pages with none; the pass's state), `pass.turn_started` and a
  turn that ended not Ready (abort), `pass.page_ready` (a turn picture when `turnChangedSomething`: a new kept
  commit, or a shared change of the task's own held in the turn), `pass.page_signed_off` (the after),
  `task.changed` with `leftPassId` (a take-out), `workstream.changed` to DONE (the after of a Your-folder task
  naming a routed page) and `project.changed` (an app address set starts `BrowserHost.prepare`; a changed one
  aborts). Start-up removes half-written picture files, asks befores for open pages with none and afters for
  Your-folder tasks done in the last hour with none. Which tasks and routes: `picture-routes.ts` (a pass page,
  or a Your-folder task naming a page area whose route loads, no `[`/`:` segment; every route × the project's
  matrix). The before rule (`before-rule.ts`): a before is asked only while the task has no pass turn (a pass
  page) or no session (any other task) and no kept work, and dropped when a session of the task reported a
  Write, Edit, MultiEdit, NotebookEdit or any Bash call (Codex's `command` and `apply_patch`) at or before the shot's end, or when a Codex session of the task started by then (Codex reports a call only once it ran); the write check runs when the before is asked too, so none that could never be kept is asked or waited on. A task's first launch
  waits for its before at most `BEFORE_WAIT_MS` (20 s) through `RunnerOptions.awaitBeforePicture`, before its
  session exists; a stop ends the wait. Files (`picture-files.ts`): `<data dir>/screens/<2 hex>/<sha256>.png`,
  0600 (directories 0700), written under a temporary name and renamed before the row; a turn picture the store
  does not keep (the same hash as the last) leaves no file. The dev login (`sign-in.ts`) runs the project's
  command through the unslotted gate runner under the gate sandbox with no project id, so it never turns Docker
  on, for at most 60 s; its log holds a token, so it is `<data dir>/browser/<project id>/login-<ms>.log`, made
  0600 before the command writes it and deleted once read; the address is never logged. The storage state is
  `<data dir>/browser/<project id>/state.json` (0600, temp and rename), read back through zod
  (`storage-state.ts`). The state is forgotten when the app address or the dev login command changes. A capture signs in when no state is kept, and once again when a page lands elsewhere; a
  page still elsewhere says so once on the task's thread (`ELSEWHERE_NOTICE`) and on the status line. A route still elsewhere after a fresh sign-in is not signed in for again for that task, and a dev login stopped with its capture leaves the last sign-in as it was. No picture is taken before the API listens (`PicturesDeps.daemonPort`), nor of an app address on its port, checked again before each sign-in and shot. A refused fetch of the browser is tried again on the next ask after ten minutes, or when a pass opens. Start-up holds back the afters of a pass it finds closing or being abandoned, and removes dev login logs a stopped daemon left. Each
  capture logs its route, outcome, milliseconds and bytes. `GET /tasks/:taskId/screens`, `GET
/screens/:screenId` (a PNG, private and immutable; 404 once pruned) and `GET /projects/:projectId/pictures`
  are refused to screens. `DaemonOptions.pictures` is `{ kind: 'pinned' }` from the entry point; tests give a
  camera (`test/fake-camera.ts`); absent, the daemon takes no pictures and fetches nothing. No picture is
  uploaded or sent to a model.
- The broken preview (Workbench spec §8.2, §8.4,
  `decisions/2026-11-10-a-broken-preview-is-read-from-the-page-load-that-takes-the-picture.md`): each capture of
  a pass page judges the load of its page route (`pageRoute`, its viewports and themes as one, `routeLoad`) by
  the pure rule `pictures/preview-rule.ts` and writes it in one write (`pictures/preview-marks.ts`
  `judgePreview`): `passes.preview` (the last judged load, pass-wide), the page's mark (`pass_preview_marks`)
  with a thread notice offered with Send to Agent (`PREVIEW_NOTICE`, never sent), the header's `preview` notice
  when no turn is named, and on two broken turns running Move to a Separate Copy once per mark where copies are
  allowed (`askMoveToCopy` takes a hazard or a route cause). A load while the page works again or another page
  holds a shared area, or that the browser itself failed (`Shot.cameraFailed`), counts for nothing; a marked page
  is shot after every Ready turn; a mend takes back the offer, withdraws the mark's Move card and logs the
  minutes broken and the task. A Move card's Not Now holds for its own cause (hazard or preview).
  `pass.preview_broken` and `pass.preview_mended` are pass events; `passView` fills `PassPageDto.preview` and
  `PassViewDto.preview`.
- Pruning (`pictures/prune.ts`, `decisions/2026-11-10-turn-pictures-are-pruned-14-days-after-their-task-is-done.md`):
  at start and every 24 h, turn pictures of a task done or cancelled 14 days ago are marked pruned, and every
  file only pruned rows name is deleted, a failed removal included; befores and afters are kept. `TaskScreensDto.fromGoal` holds, for a task in
  a goal, the newest after (else before) each other task of the goal kept on its page route.
