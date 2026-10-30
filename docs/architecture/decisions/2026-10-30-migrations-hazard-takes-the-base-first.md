# A task takes its base before it gets the migrations hazard

- **Date:** 2026-10-30
- **Amends:** `decisions/2026-10-29-gate-with-base.md`

## Decision

- **On the grant.** When `request_claim` grants the `migrations` hazard, and when a run starts holding it
  because the task names it among its areas, 10db first brings the batch's base, as origin has it now, into
  the task's branch (`delivery/migrations-base.ts`). It is the gate's base update (fetch, merge into the
  worktree's branch, move the batch's base and its tasks' starts), run in the batch's gate turn, with no
  install: the next gate installs. The hazard counts only once the branch holds the base, so a migration the
  task generates is numbered after the base's latest. Asks that overlap for one task share one merge.
- **Held back.** When the branch can't take its base, the hazard is given back (`releaseClaim`) and the call
  answers `granted: false, waiting: false, heldBy: null`, unrecorded, so a retry with the same opId asks
  again. On a conflict the batch's one base-conflict card is rewritten to say the task asked for the hazard
  and generates no migration until the conflict is resolved, and `inboxId` names it; files git doesn't track
  in the way do the same on the base-kept card. The task's own uncommitted change in the way raises no card:
  `inboxId` is null and the instruction tells the agent to commit it. A run that held the hazard from its
  start runs without it, and asking again says why. The base still coming in when the call's slice ends
  answers `waiting: true` with the hazard kept and an instruction not to generate yet.
- **Not merged into.** Work with no batch, and a batch in the builder's own checkout, get the hazard as before:
  10db never merges into the builder's checkout. A failed fetch grants it too: the gate below is the backstop.
- **At the gate.** When the base conflicts with a branch in a drizzle `meta/_journal.json`, 10db reads both
  journals from the commits and names each of the branch's migrations whose number the base already gives
  another. The batch's one base-conflict card is then titled "must regenerate migration …" and says how:
  merge the base, take the base's migration directory whole with `git restore` from `origin/<base>` (staged
  and in the worktree, so the branch's own migration files go too), run drizzle-kit generate, commit. It goes
  once the branch holds the base, as before.
- **Contract.** `request_claim`'s refusal has `inboxId` nullable. Widening an output field the agent reads,
  as `heldBy` was, needs no protocol bump.

## Why

A worktree is cut from the base once and takes it again only before a gate
(`decisions/2026-10-29-gate-with-base.md`, which superseded the worktree design's W11), and drizzle numbers
migrations in order. The migrations hazard kept two tasks from generating at once but not one after another from
different bases: "Choose per task where its pull request lands" took the hazard after #137 had merged its
0009, generated its own 0009 on its old base, and conflicted with main in the journal and snapshot. Taking the
base at the grant is the one point where the number is decided. Generated files are never merged by hand
(AGENTS.md) and migrations are forward-only (`packages/db/AGENTS.md`), so the fix for a collision that still
happens (the base moved after the grant, a fetch failed) is to regenerate on the base. The card says how,
rather than 10db regenerating: regenerating a generated directory in the worktree under the gate sandbox is
the work of the settle-conflicts change, which is not on main yet and which this card leaves room for.

Turned down: merging before the claim is granted (the holder's release can come after main moves again, so the
merge must follow the grant); keeping the hazard while the conflict stands (it would hold every other task's
migration for as long as the builder takes); recording the refusal under its opId (the agent could never ask
again with the same one); running the install before the grant (it can outlast the session's tool timeout).
