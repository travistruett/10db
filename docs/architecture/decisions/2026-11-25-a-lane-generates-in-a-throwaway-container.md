# A lane in its own worktree generates in a throwaway container

- **Date:** 2026-11-25

## Decision

A session whose checkout is not the builder's folder, with Docker and the project's compose services open to it
(`devStackElsewhere` in `apps/daemon/src/trust/policy.ts`; `TrustPolicyInput.builderFolder` is the project's
`repoPath`, passed by the runner and by a chat), gets one more environment line, `Separate worktree:`. It tells
every judge that reads `policy.environment`:

- outside a copy, that the shared dev containers were started from the builder's folder and hold its files, never
  the checkout's, so a command in them that generates or rewrites project files (directly or through a make
  target or script) writes outside the checkout and is judged under Destroying Data It Didn't Create; generating
  in a throwaway container from the project's images is the routine way;
- in a separate copy, that the containers named with the copy's id were started from the copy's checkout and are
  its own, that the project's own commands that read the id are judged as the `Separate copy:` line says,
  generators included, and that only a container without the id holds the builder's folder.

The `Routine in them:` line now says that `docker run --rm` mounting only the checkout, the temp folder and named
volumes read-only (`:ro`) crosses no limit by itself, and that a throwaway container from the project's own images
with `--network none` reaches no database or host, so making migrations or an API client there, into the
checkout, is routine. `--env-file` is reading a `.env` file, and a writable named volume is shared state. The
four limits, `LIMIT_QUESTIONS` and the `Still a limit on this Mac` line are unchanged, so a migrate against a
shared or remote database and a data reset stay limits.

A lane's brief (`GENERATORS_RULE` in `apps/daemon/src/briefing/prompts.ts`, one text for Claude and Codex) says
the same to the agent: a project target that runs in the copy's own stack is fine; otherwise
`docker run --rm --network none` from the project's image, the checkout's folders mounted where compose mounts
them, dependency volumes `:ro`, no `.env`, `--skip-checks` where the tool would reach a database; commit what it
writes, never hand-edit generated files, and take the migrations hazard first if the project has one.

This narrows `decisions/2026-11-24-judges-know-the-projects-dev-containers.md` for a worktree: file generators in
the shared containers stay routine in the builder's own folder, but not from a worktree.
`decisions/2026-11-25-the-judge-takes-a-copys-project-commands-as-the-copys-own.md` stands as it is.

## Why

On 2026-11-24 Ampsio lanes could not make a migration or the API client. The judge skipped
`make migration APP=accounts` and the lane's own fallback, a read-only `docker run --rm --network none …
makemigrations --dry-run`, at 60% against the floor. One lane committed a model change without its migration;
another hand-edited a generated file. Skipping `make migration` was right for the wrong reason: the shared
containers mount the builder's folder, so a migration made there misses the lane's model change and lands in
the builder's tree. What worked on the host was `makemigrations --skip-checks`, `spectacular --skip-checks` and
`openapi-ts` in throwaway containers from the project's images, with the worktree mounted, the dependency volumes
read-only and no network: no database, no network, and writes only inside the worktree.

`TrustPolicy.environment` is the one text every judge reads (Claude's auto mode, and 10db's judge on every
account for Claude and Codex sessions), and the brief rule is one text for both providers, so parity needs no
per-provider code.

Turned down: a fast-path rule that allows a `docker run --rm --network none` without a model. A rule keyed on a
command's shape can't bound what the image's entrypoint then runs, the same reason the fast path has no
exception for a program in the checkout. Whether the model allows the throwaway commands and stops the controls
at the floor is checked by hand with `apps/daemon/scripts/crosses-limit-replay.ts`.
