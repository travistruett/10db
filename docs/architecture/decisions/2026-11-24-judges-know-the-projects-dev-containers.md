# Judges know whether Docker and localhost are open, and the project's compose services

- **Date:** 2026-11-24

## Decision

A session's `TrustPolicy.environment` says whether Docker and loopback are open to it, as its sandbox opens
them: a lane or pass step that may write has Docker when the project's `sandboxDocker` is on, and loopback
when `sandboxLoopback` is; a chat has neither. With Docker open it also names the project's compose
services, their compose project and the usual `<project>-<service>-<n>` container name, as the project's
local dev environment, not live systems. It says what is routine in them (reading, the project's tests,
linters, formatters, type checks, builds and file generators, and `docker run --rm` mounting only the
checkout or the session's temp folder) and what still crosses a limit (dropping or truncating tables,
deleting rows, applying migrations to their database, resetting it, `docker compose down -v`,
`docker volume rm`, and anything a container reaches outside this Mac). The four limits' text does not
change.

`trust/policy.ts` builds the lines from a `devAccess` input (`DevAccess`). `folders/dev-services.ts`
(`readComposeServices`) reads the compose files tracked at `refs/remotes/origin/<base>`, never the working
tree: at most 8 files, 3 folders deep, 256 KiB each. `composeServices` keeps only the names compose itself
accepts, and every repository value is a quoted value in the line.

## Why

On 2026-11-24 the crosses-limit judge left 12 of 127 calls below its 0.8 floor in two hours, nearly all
leaning allow; Ampsio's AMP-137 failed on 11 such skips: `docker exec` into its own backend and frontend
containers to list files, format, lint and run tests, and read-only `docker run --rm --network none` type
checks. The judge was never told Docker was open or which containers were the project's own, so it could not
tell them from a remote host.

`TrustPolicy.environment` is the one text every judge reads: Claude's auto mode, and 10db's judge on
OpenRouter, Anthropic and Bedrock accounts for Claude and Codex sessions alike, so the context reaches every
provider with no per-provider code.

The base is read, not the checkout, as for the Docker switch (`decisions/2026-11-08-a-project-turns-docker-on-for-its-gate-and-lanes.md`):
a lane's own edit, a service named after a production host, must not change what the judge treats as local.
Names are checked against compose's rules so a repository string can't carry a sentence into the policy.

Turned down: a rule that allows `docker exec` into named containers without a model, since a command in a
container can still drop a shared table or reach a remote host; and feeding the judge the repository's
`AGENTS.md` or Makefile, which the lane can write and which is far longer than the facts the judge needs.
Whether the model allows each routine command at the floor is checked by hand with
`apps/daemon/scripts/crosses-limit-replay.ts`, which also replays controls that must stay limits.
