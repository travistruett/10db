# Docker reach for copies is unchanged in the pilot

- **Date:** 2026-11-24

## Decision

With `sandboxDocker` on, a lane or gate in a copy gets the Docker engine exactly as in the shared folder, and so can reach any database or folder, `amps_dev` included. The judge is the guard. The pilot adds no reach and takes none away. This is the builder's decision.

## Why

A copy's own databases are named by `TENDB_COPY_ID`, which a target uses by convention. Narrowing Docker for copies would need a design of its own and would differ from the shared folder the builder works in today.
