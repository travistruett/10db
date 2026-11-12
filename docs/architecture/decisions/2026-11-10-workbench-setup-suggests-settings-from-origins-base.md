# Workbench setup suggests a project's settings from origin's committed base, and shows the push as a command

- **Date:** 2026-11-10

## Decision

The Workbench setup (`POST /projects/:projectId/workbench-setup`, `WorkbenchSetupDto.settings` and `.branch`) suggests
the settings a project lacks, each with where it was found in one line, and notes the base branch's unpushed commits.
`suggestSettings` (`apps/daemon/src/daemon/suggest-settings.ts`) assembles it; each detector is pure and table-tested in
`apps/daemon/src/folders/`.

- **Trusted source.** Every file is read from `origin/<base>`'s commit, found once by the exact name
  `refs/remotes/origin/<base>` (`originBaseCommit`; never a guessed name, which a lane-made branch or tag could answer), in git's object store (`Git.filesAt`,
  `Git.fileAt`), never HEAD or the checkout: a local-delivery project's lanes commit to the base branch, so HEAD is
  lane-written. With no `refs/remotes/origin/<base>` the files are read from HEAD, and then no dev login is suggested
  (its row is absent), because a model would write it from lines a lane may have committed. Nothing of the repository
  runs. Files are read eight at a time. Besides the files, setup takes one look at what listens on this Mac (`lsof`,
  `daemon/listening-ports.ts`, each call stopped after 3 s or with the request) and one probe of each of three addresses
  (`daemon/loopback-probe.ts`). Both come in through `DaemonOptions` (`listeners`, `probe`), lsof and one GET unless
  given.
- **Order.** Rows come in the screen's order: App address, Sign-in for pictures (dev login command), Check after each
  turn (changed-files check), Allow Docker. A setting the project has is never suggested. Every row is ticked by default;
  Apply sends the ticked ones in the same `PATCH /projects/:id` as the areas.
- **App address** (`detect-app-address.ts`). Origins on `localhost`, `127.0.0.1` or `[::1]` only (no `.localhost`
  name), never the daemon's port; an https one is kept with the note "https: pictures need a trusted certificate". In
  this order: a compose
  app service's published port (`proxy`, `nginx`, `caddy`, `web`, `app`, `frontend`; short and long syntax, a
  `${VAR:-default}` read as its default, a host ip off this Mac or a UDP port left out; compose files at any depth
  outside a dot folder, base files before overrides); a Tauri `build.devUrl`; an app origin variable (`APP_ORIGIN`,
  `APP_URL`, `BASE_URL`, or a name ending in one, such as `NEXT_PUBLIC_APP_ORIGIN`) in a workflow, `.env.example` or
  compose file; a server listening now whose working directory is in the repository; the UI package's Vite
  `server.port`, its `dev` script's `--port`/`-p`, then its framework's default (Next 3000, Vite 5173), a guess. Three
  are probed with one GET each (1 s, no redirect followed, any status an answer, only those three hosts ever asked): the
  first three, with the last slot kept for a server listening in the checkout when there is one. The first stated address that answers wins.
  Only when the repository states no address does a listener that answered win, then a guess that did; neither ever beats
  a stated address, even one that did not answer: the first stated one is then suggested with the note "Nothing answered
  there just now: start your dev server". In a run on the builder's repositories, gstack's browser helper (a `bun`
  server started from the checkout) answered while ampsio's and 10db's dev servers were down.
- **Dev login** (`detect-dev-login.ts`). A tracked file or package script named `dev_login`, `dev-login`, `devlogin`,
  `login_as` or the like (a runnable extension; a test, component or stylesheet named so is not one). The lines of
  tracked shell scripts, Makefiles and workflows that run it, continuations included, with the literal variable
  assignments and shell functions those lines use, go to the default account's fast model as one question under the
  area-naming rules (`decisions/2026-10-29-propose-areas-from-the-repository.md`: no tool, an empty folder, no settings,
  `NAMING_MS`, aborted with the request; `askWithin` bounds it). The answer is checked by `devLoginAnswer` and dropped
  unless it has one exact shape: one line of at most 500 characters with none of `< > | ; & $` backtick, backslash or
  `#`; plain words (letters, digits and `@ % + = : , . / - _`, no glob) or wholly quoted words; the found command's
  invocation (`python manage.py <name>` for a Django management command, the script's path alone or after `sh`,
  `bash`, `node` or `python`, or `<pnpm|npm|yarn|bun> run <script>` with the script's package folder as `--dir`,
  `--prefix` or `--cwd`), optionally inside exactly `docker compose exec [-T] <service>` or `docker-compose exec [-T]
<service>`; then only arguments the repository's own scripts pass, verbatim
  (`devLoginWords`: every word of the lines that run the command, each variable with a literal value in the same script
  written out, and every word of a package script's command), a `-` word also being `--flag` or `--flag=value` of plain
  characters, and a package script's only after a literal `--`. An allowlist, not a list of refused options: argparse
  expands abbreviations (`--set` for `--settings`), and a wrapper can reach `manage.py` too. Words split on the
  ASCII space; any other space (a tab, a no-break space, a line separator) is refused. A command that runs `docker` or
  `docker-compose` carries the note "Needs Allow Docker". No candidate, no invocation line, no model or a failed check:
  no row.
- **Check after each turn** (`detect-changed-check.ts`). The UI package is the package holding the proposed pages and
  the project's page areas (the one most are in), or with none the shallowest package depending on a web framework. Its
  typecheck script (`typecheck`, `type-check`, `check-types`, `tsc`) and lint script (`lint`, `eslint`), joined by
  `&&`, each run by the manager of the nearest lockfile up to the root (`pnpm --dir`, `npm --prefix`, `yarn --cwd`,
  `bun run --cwd`). Its note: it reads the files on disk, so it sees a turn's work before sign-off.
- **Allow Docker.** Suggested when the switch is off, the builder has not turned it off (`sandbox_docker_opt_out`), and
  the project's gate command or saved turn check (the builder's own) calls docker, or a package script at origin that a
  suggested turn check runs does, as `callsDocker` reads a gate (`daemon/docker-need.ts`, Makefiles and scripts from
  origin's commit only). The check command 10db wrote is never read as text: a package folder named `docker` would read
  as a call. With no origin commit only the builder's own commands count. The dev login command never counts, set or
  suggested: a model wrote it. The row carries Settings' warning in full: Docker can mount any host folder
  into a container, so a gate or task with Docker can reach outside the sandbox. Unticked, nothing is recorded (not an
  opt-out).
- **Branch.** When `origin/<base>` exists and the local base branch has commits it lacks (`Git.countCommits`,
  `rev-list --count`, every parent), the note says how many and gives `git push origin <base>` (the name shell-quoted
  when it holds anything but letters, digits and `. _ / -`) with a Copy button. Setup never pushes, and the picker's Set
  Up (n) does not count the note, since Apply can't clear it.

## Why

- A setup screen that already holds the address, the sign-in command and the turn check turns slice 0 into reading
  and one click. Each source line lets the builder judge a row without opening the repository.
- `origin/<base>` is what the Docker decision already trusts (`decisions/2026-11-08-a-project-turns-docker-on-for-its-gate-and-lanes.md`):
  a lane can commit locally, so a lane could plant a `dev_login` invocation that steers the model into a command the
  builder then runs under the gate's sandbox, and, through a docker call, tick Allow Docker, which reaches the whole
  host. Reading origin's commit makes a lane's own commit unable to change any suggestion. With no origin there is no
  trusted copy, so the one model-written row is left out rather than guessed.
- The strict argv shape, not a blocklist alone, because the model's output is untrusted text that becomes a command:
  the allowed shapes are the ones a repository's own scripts use, and anything else is dropped.
- A server listening in the checkout ranks below what the repository states: on ampsio a static preview
  (`python -m http.server` in `scratch/`) listened in the repository and was taken over the compose proxy that serves
  the app. Live listeners still beat the guesses (a Vite port, a dev script's port, a framework default).
- The push is a command, not a button: it runs the repository's hooks and sends commits to a remote, so the builder
  does it knowingly. Cost if wrong: one paste.
- Turned down: reading HEAD or the working tree (lane-written); a dev login written without a model from the
  invocation lines (variables, functions and compose wrappers differ per repository); counting the dev login for
  Docker; following redirects in the probe (it could leave the loopback address it was given); asking the model with no
  invocation line (it would guess how the command is run).
