# A project turns Docker on for its gate and lanes, and 10db turns it on itself when it sees the need

- **Date:** 2026-11-08

## Decision

- **A per-project switch, off by default.** `projects.sandbox_docker` (`ProjectDto.sandboxDocker`, Settings › General › Advanced,
  "Allow Docker") follows the localhost switch (`sandbox_loopback`). Its warning says what it costs: Docker can mount any
  host folder into a container, so a gate or lane with Docker can reach outside the sandbox.
- **With it off nothing changes.** A gate still gets the `docker` shim that prints `DOCKER_REFUSAL` and exits 125; a lane still
  has no engine socket.
- **With it on** (`sandbox/docker-access.ts`):
  - the gate has no shim, so the real `docker` runs and its exit status decides the gate;
  - the lane and gate profile (`buildLaneProfile`'s `dockerSockets`) add the engine sockets to `allowUnixSockets` (Claude Code's
    sandbox and srt read that field; Codex's lane gets the same list as `unix_sockets`): `/var/run/docker.sock`, Docker Desktop's
    `~/.docker/run/docker.sock`, Colima's, OrbStack's, Rancher Desktop's, and the socket a `unix://` `DOCKER_HOST` names, each
    by the path as written and by its real path;
  - the profile reads what the CLI needs and no more of `~/.docker`: `config.json`, `cli-plugins`, `contexts`, plus
    `/Applications/Docker.app` and `/usr/local/lib/docker`;
  - `DOCKER_HOST`, `DOCKER_CONTEXT` and `COMPOSE_*` pass through the env allowlist (`deniedEnvNames`'s `also`); a name that reads
    like a secret still does not, and `DOCKER_CONFIG` never does, because it names a directory the CLI reads plugins from.
- **`sandbox_docker_opt_out`** records that the builder set the switch off by hand (a patch with `sandboxDocker: false`, or the
  note's Turn it off). A patch with `sandboxDocker: true` clears it. 10db's own turning on (`autoEnableDocker`) does nothing
  while it stands, so 10db never turns the switch back on after the builder turned it off.
- **10db turns it on itself** (`daemon/auto-docker.ts`, wrapped round the shared gate runner for every project's gates; an
  install or a generator names no project's id and is left alone), when the project has not opted out:
  1. the gate command, or the Makefile target or script it runs, is seen to call docker (`daemon/docker-need.ts`: the command,
     `make` and `$(MAKE) -C dir target`, the targets a target needs, a script named in a recipe, a few levels deep, comments
     ignored). The files are read **from the base branch's commit** (`origin/<base>`, else the local branch), never the working tree;
  2. the gate failed (not passed, timed out or stopped) and the sandbox refused a `docker` it ran
     (`GateResult.dockerRefused`): 10db turns the switch on and runs the gate once more, on the tree it just tested (no base
     update, no second gate-started event), and the rerun's result is the one answered.

  Each turning on leaves the project's one Inbox card (`inbox/docker-card.ts`, fold key `docker-on:<projectId>`, a flag with
  answers Keep it on and Turn it off) saying that it did, why, and the warning. It is a card rather than the notice of
  `decisions/2026-10-31-notices-not-cards.md` because the task asked for an Inbox note and it has an answer the daemon acts on
  (Turn it off).

- Every gate gets the switch as it stands in the database when it starts, whatever the request was built from, so turning it
  on or off takes effect on the next gate without a restart. A lane reads it before each session, as the localhost switch.

## Why

- Ampsio's `make gate` runs ruff, mypy and pytest through `docker compose exec`, and its migration and lock commands run in the
  compose stack; the refusal made such a gate fail every time and no project could opt out. A switch per project follows the
  localhost switch and keeps the cost where it is wanted.
- The warning is plain because the cost is: a Docker socket is the host. `docker run -v /:/host` reads and writes any folder, so
  with it on the gate and lanes are outside the sandbox's file and secrets rules. That is why the switch is off by default and
  the builder can turn it off.
- **The risk of 10db turning it on itself.** A lane can write the checkout, so a lane could write a test that runs `docker` and
  have its gate "refused" into turning Docker on. The first trigger reads the base branch's commit, not the working tree, so
  a lane's edit is not what shows the need there. The second (a refused `docker`) is the builder's own condition ("gate fails only
  because Docker was refused") and rests on a marker the gate's sandbox writes, which the gate can write itself; it is limited
  by the one card that says it happened, the builder's off switch that 10db respects, and by being the builder's chosen
  behaviour. A stricter rule (turn it on only for a need the base shows) was not chosen because it would leave a project whose
  tests start containers with the failure the task exists to remove.
- Turned down: one app-wide switch (the gate sandbox is app-wide, which is the problem); opening `~/.docker` whole (it can hold
  registry credentials in `auths`); passing `DOCKER_CONFIG`; a notice instead of a card (the note has an answer).
- Not verified here: that a Codex lane's own sandbox reaches the socket, and the CLI's behaviour when `~/.docker/buildx` is not
  writable (a `docker compose build` may fail). The profile gives Codex the same sockets as Claude Code; a live run is the check.
