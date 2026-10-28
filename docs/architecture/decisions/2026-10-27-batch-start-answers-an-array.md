# A batch start answers a list of batches

- **Date:** 2026-10-27
- **Amends:** decision 122

## Decision

`POST /projects/:id/batches` answers `BatchDto[]` (`BatchStartResult`): one batch in shared mode, one per group
in worktree mode. `PROTOCOL_VERSION` goes from 3 to 4, because the narrower answer breaks a stale client; the
desktop and the daemon ship together and the version-mismatch screen covers one that is stale.
`ProjectViewDto.openBatches` lists every unfinished batch, newest first, and defaults to `[]`; `currentBatch`
is the newest unfinished batch, else the latest. `BatchStartInput.batchId` names the batch a fix task joins; in
shared mode it must name the project's unfinished batch, else 409.

## Why

A set start in worktree mode makes several batches, so the answer can't be an object. Defaulting
`openBatches` lets an answer without it still parse.
