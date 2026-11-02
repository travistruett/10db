# The install takes the newest commit whose build has finished, and main's builds queue at most one deep

- **Date:** 2026-11-02
- **Amends:** decisions/2026-10-29-install-app-from-main-ci-build.md

## Decision

`release-dry-run.yml` has the concurrency group `release-dry-run-${{ github.ref }}` with
`cancel-in-progress: false`. Per branch, one build runs and at most one waits; a newer push replaces the build
still waiting, and a running build is never cancelled.

`install-app.sh [ref]` no longer waits for the build of the ref's head. It lists the ref's newest 100 commits
and the newest 100 successful `release-dry-run` runs, and installs the newest commit that has a successful
run whose `unsigned-dmg` artifact has not expired. It prints the commit and how many commits behind the head
that is (`0`: "the head of <ref>"). Only when none of the 100 commits has such a build does it do what it did
before: wait for a run of the head already under way, else start one with `gh workflow run` and wait for it.
A build that failed for the head no longer stops the install while an older commit's build succeeded.

## Why

On 2026-11-02 merges came every few minutes and a macOS build takes about 15 minutes, so runs queued four
deep. `install-app.sh main` waited for the head's build, 10db had been quit for it (the script refuses while
10db runs), and the install had to be abandoned. A run waiting in a concurrency group is replaced by the next
one, so the queue stays at one, and the commits skipped that way were never going to be installed anyway.
Because the install no longer needs the head's build, a replaced head costs nothing; it installs the newest
finished commit and says how far behind it is, and running it again later gives a newer one.

Turned down: `cancel-in-progress: true`, which would cancel the build in progress and leave main with no
finished build while pushes keep coming. Not done here: the daemon's self-update is not in this tree; when it
lands it calls this script and gets the same behaviour.
