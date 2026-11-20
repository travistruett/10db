# A plan takes its chat's id, so every session can open its plan's folder before the plan exists

- **Date:** 2026-11-20
- **Amends:** `decisions/2026-11-19-plan-becomes-part-of-sessions.md`, which says a chat with a plan gets Plan's
  files; the files now open for every chat.

## Decision

- A plan made from now on has its chat's uuid under the `shp` prefix as its id (`planIdOfChat`).
- Every chat's session opens its plan's folder, `<data>/shapes/<planIdOfChat(chat)>`, read-only, along with Plan's
  agents and tools, whether or not the chat has a plan yet.
- A plan made by slice 1 under a minted id keeps working: the chat finds it through `planOfChat`, and its folder is
  that plan's own.
- The cost is an empty folder per session. Archive removes it from a chat with no plan, and only warns when the
  removal fails unexpectedly.

## Why

A session's sandbox and file access are fixed when it starts. A plan made mid-session (Show Plan, or the agent's
first `propose_plan`) needs a folder the session can already read, on Claude and on Codex, without a restart. A
minted id would not exist until the plan did, so the folder's name is derived from what the session already has:
its chat. Minting at the first session and opening that folder was turned down because it makes a plan row, or a
second id to store, for every session that never plans.

The spec is `docs/superpowers/specs/2026-11-19-10db-plan-in-sessions-design.md` and the plan is
`docs/superpowers/plans/2026-11-20-10db-plan-in-sessions-s2.md`.
