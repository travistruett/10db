# Task 6: docs, module notes and the decision record

**Spec:** the whole of S2's scope (index, "Spec"). **Track:** none; it runs last, after Tasks 1-5 and their review
rounds. Read `docs/architecture/decisions/README.md` once.

## Files

- **The decision record**, new in `docs/architecture/decisions/`, named `2026-11-20-a-plan-takes-its-chats-id.md`, in
  the README's format. It says:
  - a plan made from now on has its chat's uuid under the `shp` prefix (`planIdOfChat`);
  - why: every chat's session opens its plan's folder before the plan exists, so a plan made mid-session is
    readable on Claude and Codex without a restart;
  - that slice 1's minted ids keep working through `planOfChat`;
  - the cost: an empty folder per session.

  Cite the spec and this plan by path. Other decision records are named without a `decisions/` path until they exist.
- **Module notes** (each `AGENTS.md` beside the code). Say what is built now:
  - `apps/daemon/src/chat/AGENTS.md`, the paragraph at line 71:
    - every chat's session gets Plan's prompt, agents, allowed tools and folder;
    - the folder is its plan's, or `planIdOfChat`'s before it has one;
    - the read budget resolves the plan per call;
    - "This session has no Plan." is gone;
    - Show Plan is `POST /chats/:chatId/plan` (`ChatService.showPlan`, `ensurePlanOfChat`).
  - `apps/daemon/src/shape/AGENTS.md`:
    - `/mcp` gives every chat's session Plan's tools;
    - a handler resolves the plan per call, `propose_plan` makes it (a refused first call makes none), `note_heard`
      writes nothing without one, and the row tools answer `NO_PLAN_YET`;
    - a plan is made by New Plan, Show Plan, a passing `propose_plan`, `start_shape` and import.
  - `apps/desktop/src/views/sessions/AGENTS.md`: ⋯'s items are now Rename, Show Plan / Close Plan (the title row's
    only), Open in Terminal, Make a Board Task…, Archive and Close; File as Tasks is gone.
  - `apps/desktop/src/views/sessions/plan/AGENTS.md`:
    - the title row's Plan toggle is on every session (`useShowPlan`), and its tooltip;
    - the row's state dot (`rowDot`).
  - `apps/desktop/src/conversation/AGENTS.md`, line 20: the `held` composer shows Wait for It and Send Reading Only.
    "File as Tasks" there is stale; remove it.
- **The spec** `docs/superpowers/specs/2026-11-19-10db-plan-in-sessions-design.md`: its Status line says slices 1-2
  are built.
- **This plan's index:** nothing to change unless a ruling changed during the build. If one did, say so in the
  Brief's calls, with its cost.

## Interfaces

None.

## Tests

`tests/repo` must pass:

```sh
pnpm --filter @10db/repo-tests exec vitest run src/architecture-docs.test.ts
```

Or the package's name as `tests/repo/package.json` gives it. It checks the decision record's format and every path a
doc cites.

## Done when

- `make precheck` is green.
- Report: the SHA and the files changed.
