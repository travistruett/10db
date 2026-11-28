# apps/daemon/src/pictures

- `pictures/`'s browser (`decisions/2026-11-10-task-pictures-come-from-a-pinned-chromium-and-stay-on-the-mac.md`): only
  `pictures/playwright.ts`, `pictures/playwright-camera.ts` and `lane-browser/playwright-driver.ts` touch `playwright-core`, and only `playwright.ts`
  loads it at runtime (a dynamic import). The browser is Chrome for Testing's headless shell at `BROWSER_PIN`
  (`browser-pin.ts`), which must be the build the pinned `playwright-core`'s `browsers.json` names (a test fails
  when they part); it is fetched, checked and locked down by `environment/pinned-install.ts` (`PinnedRelease`,
  `extractZipWithTar`). `browser-host.ts` launches it on first use with the renderer sandbox on, `HOME` and
  `TMPDIR` only, artifacts under `<data dir>/browser/artifacts`, and every request, loopback included, through
  `app-proxy.ts`'s proxy as Chromium's own switches (`launchOptions`); it runs one shot or sign-in at a time,
  holds the browser's processes in a lane process ledger (`browser-ledger.ts`, one lock for every browser, pictures' and each lane's, `createBrowserLaunches`: a launch marks the daemon's children first and a ledger never takes a marked or held root: the browser is the daemon's child
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
  afters wait until it leaves that state; while the browser is fetched or checked, as start-up does when a live
  project has an app address, befores and afters wait and a turn picture is not asked; the first waiting before
  starts ahead of every other request, since its task's launch waits on it only so long; an after dropped by a
  refused browser or a stop is logged, and once a fetch works after a refusal the last hour's missed afters are
  asked again,
  `decisions/2026-11-26-an-after-picture-waits-for-the-browser-fetch.md`). It follows the bus:
  `pass.opened` and `pass.changed` (befores for open pages with none; the pass's state), `pass.turn_started` and a
  turn that ended not Ready (abort), `pass.page_ready` (a turn picture when `turnChangedSomething`: a new kept
  commit, or a shared change of the task's own held in the turn), `pass.page_signed_off` (the after),
  `task.changed` with `leftPassId` (a take-out), `workstream.changed` to DONE (the after of a Your-folder task
  naming a routed page; a local copy's task is skipped there) and `batch.updated` to SHIPPED (the afters of the tasks a local
  copy finished that name a routed page, once the change is in the project) and `project.changed` (an app address set starts `BrowserHost.prepare`; a changed one
  aborts). Start-up removes half-written picture files, asks befores for open pages with none and afters for
  Your-folder tasks done in the last hour with none, and for the tasks of a local copy whose batch shipped in the
  last hour (`taskInLocalCopy`, `copy-task.ts`). Which tasks and routes: `picture-routes.ts` (a pass page,
  or a Your-folder task or a task of a local copy naming a page area whose route loads, no `[`/`:` segment; every route × the project's
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
  capture logs its route, outcome, milliseconds and bytes; one that keeps nothing without being stopped logs
  why (`no picture taken`), and an after the queue would not take says so. `GET /tasks/:taskId/screens`, `GET
/screens/:screenId` (a PNG, private and immutable; 404 once pruned) and `GET /projects/:projectId/pictures`
  are refused to screens. `DaemonOptions.pictures` is `{ kind: 'pinned' }` from the entry point; tests give a
  camera (`test/fake-camera.ts`); absent, the daemon takes no pictures and fetches nothing. No picture is
  uploaded or sent to a model, except a design review's and `check_design`'s (to the session's model), a PR's (uploaded
  with `prPictures`), a finished task's pair in its Linear `ended` comment (`linear/reporter-pictures.ts`) and a `lane` screen taken by a lane's own browser, which goes to that
  session's model as an image block when it fits the account's limits
  (`decisions/2026-11-24-lane-screenshots-go-to-the-lanes-model.md`).
- The sign-in check (`sign-in-check.ts`, `sign-in-schedule.ts`; `POST /projects/:projectId/pictures/sign-in-check`,
  Settings › App Preview's Check Sign-In): the dev login is a contract (it creates its fictional user if missing, runs
  only against the dev database, is safe to repeat and prints one sign-in URL or path), so it is checked and not trusted.
  A check holds the app up (`holdApp`), runs the saved command, signs the browser in and loads the first page area
  route that loads (else `/`), only at the project's own address, read again before each step (`shootableAddress`; a
  printed address off the app's origin is refused by `parseLoginUrl`). It answers a `SignInCheckDto`: `signed_in` with
  the page as a PNG, `failed` with the exit code and the command's last lines, or `unchecked` when the app, not the
  login, kept it from telling (no answer, an error overlay, a browser that could not open the address while the app
  was down). The output is masked (`sign-in-output.ts`: addresses, queries, the outbound scan's secret patterns and long
  bare tokens). It runs by itself once the API listens, when the app address or the dev login command changes (the
  check under way is stopped), and every 24 h, for each live project with both. A failed command or check reports
  through `PicturesDeps.onSignIn`, and `daemon/start.ts` raises the project's one card (`inbox/sign-in-card.ts`), which
  a check or a picture's sign-in that works closes; an `unchecked` check changes nothing. A project whose address is
  cleared closes its card.
- Setting the sign-in up (`inbox/sign-in-card.ts`, `mcp/sign-in-setup-tool.ts`): the failed card, and the card a
  change that leaves an app address with no dev login raises (`PicturesDeps.onNoSignIn`, never at start-up, so Not
  Now holds), offer Set Up Sign-In. Its answer makes a Your-folder task naming one area (`signInSetupTask`) and a
  setting-up card naming it (`SIGN_IN_SETUP_TASK`), which the failed card leaves alone while the task is open. Only
  that task's lane is offered `save_dev_login`: a command naming an email off the reserved test domains
  (`fictional-account.ts`) is refused unrun; any other is checked by `checkDevLogin` (the check, run from the
  project's folder, never recorded or announced, keeping no state unless it signed in) and saved through
  `patchProject` only when `signed_in`, whose change checks it again and closes the card. `cannot` rewords the card
  with what was found and what the builder must decide, masked as prose (`maskedProse`: addresses, query strings and
  secrets, nothing cut), and keeps them in its detail (`SIGN_IN_CANNOT`, with the address and command they held
  for). A later failed sign-in that rewrites the card keeps those lines until the builder changes either.
- A failed dev login leaves a record for the task updates (`sign-in-record.ts`, `createSignInReporter`, wired in
  `daemon/start.ts`;
  `decisions/2026-11-25-the-daemon-uploads-a-tasks-pictures-to-linear-and-says-why-it-has-none.md`): the command,
  its exit code and the masked last lines of its output, kept per project (`pictures-sign-in.<projectId>`) and cleared
  when a sign-in succeeds or the app address or dev login command changes. The builder's card is the sign-in check's
  (above). `Pictures.outlook(taskId)` is the one place that says what a task that names a page can expect of
  its after: `none` (with a `why` when it has no after: no app address, no page named, no capture recorded), `wait` (an After capture of it is queued or running), `later` (a local copy not yet shipped) or
  `skipped` with the reason (a separate copy, the recorded sign-in failure, a refused browser); the Linear `ended` and
  landing comments and the Slack post read it, and the Linear reporter waits on `wait`.
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
- On-demand pictures for a design check (`decisions/2026-11-20-design-review-shows-the-app-to-the-sessions-model.md`): `PageCamera.drawHtml` draws a mock-up's HTML (`mockupDocument` and `MOCKUP_CSP` from `@10db/contracts`, the one copy the window's iframe also reads) in a context with JavaScript off, no proxy reach (`reach` null: only `about:blank` and `data:` pass, the proxy refuses everything) and every other request refused; the live case in `browser.live.test.ts` holds all four layers at once, so no single layer's loss turns it red. `Pictures.shootNow` shoots the routes in the first viewport and theme of the project's matrix, signed in as a capture is, through the host's one-at-a-time `use`, after `holdApp` (the preview's `hold`) says the app answers; it answers `{ shots, missing }` with each missing route's reason, and keeps files only (`writePicture`), no task row. `drawMockup` caches the drawn PNG in memory by the hash of HTML, viewport and theme. `design_checks` rows (`checkShotsOf`, `design-shots.ts`) name their files, so `removeUnnamed` also asks `designCheckNames`; `prune.ts` deletes a check 14 days after its task is done or cancelled, or, with no task (a Design review), 14 days after it was made. `GET /tasks/:taskId/design-checks`, `/design-checks/:checkId/mockup` and `/shots/:index` are refused to screens.
- A separate copy's own app (`decisions/2026-11-25-a-copys-pictures-come-from-its-own-app.md`): a project whose
  copies serve an app sets `copyAppCommand`. `resolveSite` (`pictures.ts`) gives every picture but a before of a
  task whose copy stands (`copyOfTask`, `copy-task.ts`: not Landed, Retiring or Retired, with a worktree) the
  copy's site: `runCopyApp` (`copy-app.ts`) runs the command in the copy's folder through the gate runner with
  the copy's id, for at most 120 s, its log `copy-app-<ms>.log` kept as the dev login's is, and `copyAppAddress`
  takes its last line as a loopback origin off the daemon's port and not the shared address. The dev login then
  runs in the copy's folder with `TENDB_COPY_ID` and `TENDB_APP_URL` (`signIn`'s `PictureSite`; every dev login
  gets `TENDB_APP_URL`, which `sandbox/env-allowlist.ts` lets through), and its state is
  `browser/<project id>/copy-<copy id>.json`; `forgetStorageState` drops every copy's state with the project's,
  since a localhost cookie is shared by every port, and a changed copy app command forgets them too. With the
  command set, `workstream.changed` to DONE asks a copy task's after and start-up's catch-up counts copy tasks;
  a command that fails logs a warning and the after comes at SHIPPED, in the shared app. A copy task keeps one
  after: a capture of one that has an after does nothing. `shootNow` takes the task's id (`check_design` passes
  it), shoots a copy task in its copy's app, and holds no preview for it. Befores stay on the shared app.
- `PicturesDeps.ensureApp` (`app-start/`, `decisions/2026-11-26-10db-brings-the-dev-stack-up-before-a-picture-or-a-sign-in.md`)
  runs before a capture's shots, before each dev login (a failed one sets the status line's sign-in problem) and
  before `shootNow`'s `holdApp`; a stack that will not start skips the capture or sign-in, logs why, and leaves the
  project's one Inbox card. Absent, nothing is checked.
- `PicturesDeps.onAfterCapture` is told, for every After capture of a task outside a pass that was not stopped,
  which task it was (what the capture kept is already stored); the pictures module imports nothing of Slack or
  delivery, and `daemon/start.ts` hands the call to `delivery/slack-picture-post.ts`.
