# The installed app installs main's newest finished build by itself when no task is mid-session

- **Date:** 2026-11-03
- **Amends:** decisions/2026-11-02-install-takes-the-newest-finished-build.md (its "Not done here: the daemon's
  self-update is not in this tree; when it lands it calls this script and gets the same behaviour"),
  decisions/2026-10-29-install-app-from-main-ci-build.md (the install is run by the builder, with 10db quit)

Nothing is superseded: `make install-app` and `make rollback-app` work as before, with the same lock, the same
database backup and the same kept zip. This adds a second caller of the install script, and it changes what the
script accepts on its command line, not what a plain run does.

## Decision

**What decides to update.** The installed daemon (`apps/daemon/src/self-update`) looks at the head of `main` on
GitHub every minute with `gh api repos/<owner>/<name>/commits/main`. It does so only when it runs from
`/Applications/10db.app` and its bundle carries `build-info.json`: the commit `scripts/build.ts` built it from
(`GITHUB_SHA`, else the checkout's `git rev-parse HEAD`) and the repository GitHub built it for
(`GITHUB_REPOSITORY`). The repository is fixed there, when the app is built, and is the only one the app follows:
no project, checkout, origin or setting chooses it. A build with no repository (a local one), a run from source
and any other copy of the app show their commit and never update.

It acts only when main's head is ahead of the running commit (`gh api repos/<repo>/compare/<running>...<head>`
says `ahead`). A head that is the running commit, or a running commit main is not ahead of (a build from another
branch, or one nobody pushed), is not an update, so a branch build is never replaced by an older main.

**What it installs: the install path of today, not another.** The daemon stages with
`install-app.sh --stage <data dir>/self-update/stage --running <running commit> [--skip <rolled-back commit>] main`: the same choice as
`make install-app` (decisions/2026-11-02-install-takes-the-newest-finished-build.md). It takes the newest of
main's last 100 commits that has a finished successful `release-dry-run` build with a live artifact, **not
necessarily the head**, and never an older one: it waits for or starts the head's build only when none of the 100
has one, and with `--running` a newest finished build that is the running commit is not fetched at all (status
step `current`, so a build still under way for the head costs one cheap lookup a minute, not a download). The
fetched build must also be ahead of the running commit (the same comparison), else nothing is installed. The DMG
is checked against `SHA256SUMS`, and the stage folder keeps the DMG, the checksum, the commit and a copy of the
two install scripts, because the install replaces the app that holds them.

**When it installs.** Only when nothing is mid-session: no lane holding a session (`countLanes`'s states, and a
`WAITING_HUMAN` workstream with a live session), no workstream with a gate process, no batch `CUTTING` or
`SHIPPING` (`countMidSession`, `packages/db`), and no delivery job queued or running (`DeliveryJobs.pending()`: a
ship, checkout return or cleanup is a job before it is a row). Queued, held, paused and waiting work does not
count, because startup recovery keeps its place across a restart. The daemon checks, holds the scheduler back
(`scheduler.stop()`) and waits for the tick it was in to finish (`scheduler.idle()`), checks again, and starts the
staged `install-app.sh --apply <stage> --quit-first --relaunch` detached. `Scheduler.stop()` also makes a tick that
was reading branches launch nothing, so no lane begins between the last check and the quit. It waits and checks
again each minute while a batch is cutting or shipping or a lane runs.

**When it has waited too long: the factory drains.** On 2026-11-03 #466 merged and its build finished, yet the app
was still on the previous commit 30 minutes later: three lanes ran back to back, each starting its next step as soon
as the last ended, so the idle moment never came. Once a build is staged and has waited longer than the wait limit
(`app_settings` key `self_update.wait_minutes`, default 15, 0 to 1440, `PUT /settings/self-update/wait`), or the
builder chose Install Now (`POST /settings/self-update/install-now`, drains at once), the daemon _drains_ the
factory (`self-update/drain.ts`) until the app has installed:

- **Held:** the scheduler launches no queued lane (its `held` hook, beside the overload hold), a running lane starts
  no next session (the runner's hold), a task's gate takes no slot (`limitGates`), and no open batch moves to
  SHIPPING (`ShipperDeps.holdShips`; a batch whose work is done stays OPEN and is shipped by `checkOpenBatches` when
  the drain ends or after the relaunch). The runner's and the task gate's hold is the load guard _and_ the drain
  (`holdBoth`): work starts only when neither holds.
- **Not stopped:** a session, a task gate, a shipping gate, a cut and a ship that began before the drain run to the
  end. A shipping gate is held only by the load, never by the drain, because its batch is already SHIPPING and a
  parked ship would keep the update waiting for ever; delivery jobs already queued (a ship, a checkout return, a
  cleanup, a catch-up) run, as they are short and a restart would lose them.
- **What counts as mid-session while it drains:** the same count as before, minus the callers parked at the drain
  (`Drain.parked()`): a lane parked before its next session or its gate has begun nothing a quit would cut off, and
  counting it would hold the update up for ever. A stop at the quit leaves such a lane's saved next action, as any
  stop before a session did, and recovery queues it again, so lanes resume after the relaunch with no card.
- **Ends:** the check installs as soon as the count is 0 (the drain stays on until the relaunch, so nothing starts in
  the gap). It ends, and lanes start again, when the builder turns the switch off, the install does not start or
  its script ends with the daemon still running, main is back at the running commit, or the staged build is dropped.
  Install Now remembered before the build is staged drains the moment one is.
- **Seen:** `GET /settings/self-update` also says `waitMinutes`, `waitingSince` (when the build was staged),
  `draining` and `drainingSince`. Settings > Updates shows an update status line, the wait limit and Install Now;
  the Factory view shows a note, with the time, while lanes are paused. The status is polled every 15 s while an
  update is available, as no event says it.

The check runs every minute, so the install follows the end of the last running step by up to a minute: the app
runs the new commit within the wait limit plus the time the running steps take plus that minute.

**What the script does.** `--apply` takes the install lock, sends the window SIGTERM (the supervisor stops the
daemon cleanly), waits until no process that holds the database is left (the builder's MCP bridge,
`builder-mcp.mjs`, holds none and is neither waited for nor signalled), then does what an install does: back up
the database with `sqlite3 .backup`, zip the previous app to `10db-previous/`, copy the new one in, clear its
quarantine, register it, and with `--relaunch` open it. `make rollback-app` finds that zip and that backup as it
does after a manual install. `--status-file` makes either half write `{ok, mode, step, message, commit}`.

**What runs with what.** The daemon starts both halves with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`,
`TENDB_INSTALL_GH` set to the gh it resolved from its fixed install prefixes, `GH_REPO` set to the pinned
repository, and the login environment otherwise as gh's sign-in needs it, without `PATH`, `BASH_ENV`, `ENV`,
`DYLD_*`, `LD_*` or `TENDB_INSTALL_*`. The stage half runs in its own process group with its own `TMPDIR`; a
timeout or the app quitting kills the group and removes both folders, and starts no stage after.

**Failure.** A failure leaves the running app as it was, or restorable: `install-app.sh` puts the previous app
back when a step after the quit fails, relaunches it, and `make rollback-app` still works. It raises one Inbox
card, "Updating 10db failed: <step>", folded on the commit, naming the step (`find-commit`, `wait-for-build`,
`download`, `verify-checksum`, `quit`, `backup-database`, `zip-previous`, `install`, `relaunch` and so on) and
the script's message, and the lanes resume. A staging failure is reported by the running daemon. An apply
failure before the quit (the lock is held, or the app does not quit in time) leaves this daemon running: it
hears the detached script exit, reads the status file, starts the scheduler again, clears its marker and raises
the card. An apply failure after the quit is reported once by the next daemon, from the status file and the
`self_update.applying` marker, at startup. The head of main whose update failed is kept
(`self_update.failed_commit`); it is not tried again until main has a newer head or the builder touches the
switch, so one failure is one card. Cards sit under the first project; with none registered the failure is only
logged.

**After `make rollback-app`.** Rolling back must stick: otherwise the restored app finds main ahead of it at its
first check and installs the build the builder just rolled back from. `rollback-app.sh` reads the commit from the
replaced bundle's `Contents/Resources/daemon/build-info.json` and, once the swap has finished, writes it to
`<data dir>/self-update/rolled-back-from` (it still never touches the database). At startup the daemon moves that
commit into `app_settings` key `self_update.rolled_back_from` and removes the file. While main's head is that
commit, a check stops there. When main has moved on, the stage is run with `--skip <that commit>`: when the newest
finished build is still that commit (main's head is still building), the script fetches nothing and reports step
`skipped`, and nothing is kept staged, so every later check looks again for the head's build. A staged build that
turns out to be that commit is dropped the same way. The first newer finished build of main is installed as usual.
Touching the switch (off, or on) clears the record, as it clears `self_update.failed_commit`.

**The switch and the commit.** One app-wide setting, `app_settings` key `self_update.enabled`: true, false, or
absent for the default, which is on. Settings > Updates has the switch, served by `GET/PUT /settings/self-update`;
with it off a check asks GitHub nothing and nothing is staged or installed. Turning it off also stops a check
already under way: the daemon kills a stage in progress (its process group, gh included, and its folders) with a
cancel that, unlike the shutdown stop, lets later stages run, and forgets a staged build. A check looks at the
switch again when its stage ends and again once the scheduler is held back, just before it writes
`self_update.applying`; finding it off, it lets work go on and installs nothing. `/health` reports `commit` (null
for a run from source) and the header shows its first 7 characters.

## Why

On 2026-10-29 six fixes were merged and none reached the app the builder was using; on 2026-11-02 the install was
abandoned because it waited for the head's build while 10db was quit. 10db builds 10db, so the app should follow
main without a step that depends on the builder remembering it, and the install that picks the newest finished
build (so a replaced head costs nothing) is the one it should use. Staging while the app runs means the quit
happens only once the DMG is already checked and on disk, so the app is down for the swap, not for a download.

Quitting is safe only when no session, gate, cut or ship would be cut off; waiting and queued work survives a
restart through startup recovery, so it is not a reason to wait. A shell script does the swap because the install
script already handles the backup, the zip, the rollback of a failed copy and the lock, and has tests for each;
the daemon only decides when. The status file is the only way the daemon that outlives the failure can name the
step, since the process that failed is the one that quit it.

The repository is baked in at build time because a running app has nothing it can trust at run time: a project's
origin, or a `package.json` and script read from a checkout lanes can write, would let a lane choose which
repository's build runs, with the builder's token, outside any sandbox. The same reasoning gives the script a fixed
`PATH` and the resolved gh, and makes the switch one app-wide setting: it says whether, never from where.

Turned down for the drain: waiting for an idle moment alone (what failed on 2026-11-03); stopping a session to
install (work lost, and the builder's rule is that nothing running is killed); holding queued delivery jobs too
(they live in memory, so a restart would drop a ship that was accepted); holding a batch's shipping gate for the
drain (it would park a SHIPPING batch and the update would never see an idle moment).

Turned down: a Tauri-side updater (needs the signed releases and an update server that do not exist yet); a
migration for the setting (an `app_settings` key costs less than regenerating the migration baseline); a
per-project setting or default read from a project's repository (the lane-writable input above); updating when
only the head's build counts (it is what made the 2026-11-02 install wait); killing the MCP bridge to finish the
quit (it belongs to the builder's client and holds no database).

`release-dry-run.yml` already runs on every push to `main` (decisions/2026-11-02-install-takes-the-newest-finished-build.md),
so main's build is usually ready within about 15 minutes of a merge; the app installs it within a minute of the
build finishing, while no task is mid-session.
