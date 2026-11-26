# 10db brings the dev stack up before a picture or a sign-in

- **Date:** 2026-11-26

## Decision

A project has an app start command (`projects.app_start_command`, Settings › App Preview › App Start Command,
suggested by the Workbench setup from a Makefile `up` or `dev-up` target, else a Compose file). Before a picture
(a capture's pictures and `Pictures.shootNow`) and before the dev login, `app-start/` looks at `appUrl`; when
nothing answers and the project has a start command, it:

- opens Docker Desktop (`open -a Docker`) when no engine socket answers (`dockerAccess`'s sockets) and the
  project uses Docker (Allow Docker is on, or the command is seen to call docker in `origin/<base>`, as the gate
  is), and waits up to two minutes for a socket;
- runs the command once, in the project's folder, through the unslotted gate runner under the gate's sandbox with
  Docker allowed whatever the project's switch says. The request names no project id, so it never turns the
  switch on or leaves the Docker note. The command is the builder's own setting; it must return once the stack is
  started (`make up`, `docker compose up -d`) and may run ten minutes;
- waits up to three minutes for the address to answer, then goes on.

A start that fails (a non-zero exit, the ten minutes, no answer in time, Docker Desktop that never came up) leaves
one Inbox status card per project (fold key `app-start:<project>`, refreshed by a later failure, closed once the
app answers) saying what ran and what it saw, and the picture or sign-in is skipped. The same command and address
are not run again for ten minutes: an ask in that time gets the earlier failure's words, so a broken stack never
loops. Asks while a start runs share it. No model runs, so every kind of account behaves the same.

## Why

Pictures and `devLoginCommand` failed whenever the builder's stack was down, and the preview command runs only
while a pass is open. The command is the builder's, not a lane's, so Docker is allowed for it without the switch
the gate's lane-written code needs. Opening Docker Desktop only for a project that uses Docker keeps a project
with a plain dev server from launching a heavy app. A wait after a failure, rather than a permanent stop, lets a
fixed stack start on a later ask without the builder touching Settings.
