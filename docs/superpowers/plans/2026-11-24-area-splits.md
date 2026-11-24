# Plan: the Workbench setup proposes splitting a broad area, and Apply retags its tasks

**Size:** Core. Task 1 changes which areas open tasks name in the same write that changes the project's areas,
which is claims (`.claude/rules/testing.md`: claims are core). Task 2 is the suggester and the modal row
(Feature-sized, one pure rule-table test). The UI half of this hand-off (split buttons, the calmer modal) ships
before it as Feature work.

## Brief

**What changes for you.** The Suggestions modal can propose splitting a broad area that open tasks name, such as
Ampsio's `backend` (`amps/backend/**`): one area per package in a folder of sibling packages
(`amps/backend/apps/<app>`), with the rest in `backend-shared`, its core; the name `backend` is retired. The row reads "Split backend into 26
areas: backend-shared (core), access, backend-accounts and 23 more · 15 open tasks get all of them". Apply saves the new areas, and in the
same database write every open task that names `backend` names all of the new areas instead.

A new project's first proposal applies the same rule, so a broad area is never proposed in the first place.

**What it buys.** New tasks can name `methods` alone, so two backend tasks in different apps run side by side.
Before, one area serialized every backend task.

**What could go wrong, and how we'd know.**
- A task is left on the narrowed name and two lanes write one file. This is why the hand split of 2026-11-23 was
  reverted. Prevented by the retag in the same write, and refused outright while any run holds `backend`. The
  core test checks both.
- A session that started before the split checks its writes against the paths it read at start, so a claim it
  takes later on the narrowed name would let it write another part's files. This is true of any area edit in
  Settings today, too. Fixed for both: the guard reads the project's areas and hazards on every tool call, as
  a Workbench pass's lanes already do.
- The rule splits something you'd rather keep whole. It is a row you untick, and the area then stays exactly as
  it is.
- Today's 15 tasks still run one at a time: each names every part. You narrow a task in its drawer (#833 lets a
  task's areas change between runs).

**Calls you might disagree with.**
- The retag gives each task every part (a superset), never a guessed subset. A wrong guess would block a task's
  writes mid-run. Narrowing is yours, per task.
- The core is renamed `<area>-shared` and the old name retired: an area called `backend` that holds only config
  and tests would read as the whole backend to you, to an agent tagging a task and to the sizing judge. A
  routing rule, a kind's "implied by" or a knowledge record that names `backend` no longer matches; rename it by
  hand if it should follow.
- A folder added later under the split root (a new app) belongs to no part: it falls to the catch-all, and a
  task that writes there asks for the catch-all's claim, where before `backend` held it.
- Packages named `core`, `common`, `shared`, `base`, `lib` or `utils` stay in the core, as does everything outside
  the packages folder.
- The split waits while a run holds the area. Apply is then refused with the task's name and the modal keeps your
  ticks; untick the split, or try again once that run lets go.
- A kind implied by `backend` (Settings › Kinds) is not extended to the parts: kinds are app-wide, so new names
  there could set off kinds in other projects. A task narrowed to `methods` loses that kind until you add it.
- The 15 retagged tasks are sized again (their areas changed), which asks the sizing judge once each.

**What is needed from you.** Nothing.

## Global Constraints

- Starts after #831 merges (it adds refusals near the start of `patchProject`); this branch merges `main` first.
- The retag writes `tasks.areas` directly in `patchProject`'s transaction, not through `patchTask` or
  `checkAreasCanChange`. #833 adds guards there (kept work, pass holds) that would refuse a superset retag that is
  safe: no task loses a file.
- No migration: `tasks.areas` and `projects.areas` are existing JSON columns.
- Provider parity: none of this touches a provider. Every account kind behaves the same.

- The split is offered whether or not the rebuild is on: it applies to the project's own list when the rebuild is
  off, and the Add Area caret counts it.
- `__init__.py` is no package marker: every Python subpackage has one. `apps.py`, `pyproject.toml`, `setup.py` and
  the manifests are.

## Interfaces

```ts
// packages/contracts/src/entities.ts (ProjectPatch)
export const AreaSplit = z.object({ from: AreaName, into: z.array(AreaName).min(2) });
// ProjectPatch gains: areaSplits: z.array(AreaSplit).optional() — refused without `areas` in the same patch.

// packages/contracts/src/workbench-setup.ts
export const SplitRow = z.object({
  from: AreaName,
  /** The new areas, the core first (`<from>-shared`); `from` itself is retired. */
  into: z.array(AreaDef).min(2),
  /** `from` as it is, which unticking puts back. */
  was: AreaDef,
  /** Open tasks that name `from`. */
  tasks: z.int().nonnegative(),
});
// WorkbenchSetupAreas gains: splits: z.array(SplitRow).default([]); WorkbenchSetupDto loses `branch`
// (decisions/2026-11-24-suggestions-open-from-add-areas-menu-and-drop-the-branch-note.md).
/** `areas` with each split of `rows` not in `unticked` applied in `from`'s place. Pure. */
export function withSplits(areas: readonly AreaDef[], rows: readonly SplitRow[], unticked: readonly string[]): AreaDef[];

// apps/daemon/src/folders/rebuild-areas.ts: RebuildInput gains
//   readonly splits: ReadonlyMap<string, { core: AreaDef; parts: readonly AreaDef[] }>; // by kept area name

// apps/daemon/src/folders/broad-areas.ts (pure)
export function broadAreaSplit(
  area: AreaDef,
  files: readonly string[],
  taken: ReadonlySet<string>,
): { readonly core: AreaDef; readonly parts: readonly AreaDef[] } | null;
```

## State table (task 1: `patchProject` with `areaSplits`)

| Case | Result |
| --- | --- |
| `from` is not a current area | InvalidError |
| an `into` name is not in the patch's `areas` | InvalidError |
| `areaSplits` without `areas` | InvalidError |
| an unreleased claim names `from` | ConflictError naming the task |
| an open task names `from` | its areas: `from` replaced in place by `into`, deduplicated; `TaskChanged` emitted |
| a done or cancelled task names `from` | untouched (history) |
| a task does not name `from` | untouched |
| the project's `isolate` names `from` | `isolate` gains every `into` name |

A pass needs no check of its own: its pages' claims are held for the pass's life, and its lanes read areas live.

## State table (the modal's Apply)

| State | Event | Outcome |
| --- | --- | --- |
| Modal open, split ticked | a run takes `from` | Apply refused with the task's name; the modal stays open with its ticks |
| Modal open | the daemon restarts | Apply sends the same patch; the refusals above decide it |
| Modal open, rebuild off | Apply | `areas` = `withSplits(project.areas, …)`, with `areaSplits` |
| Modal open, rebuild on | Apply | `areas` = `withSplits(withoutPages(proposed, …), …)`, with `areaSplits` |
| Split unticked | Apply | no `areaSplits`; the area stays exactly as it was |

## Tracks

One track, in order: task 1, then task 2.

- [Task 1](2026-11-24-area-splits/task-1.md): `areaSplits` in `ProjectPatch`; `patchProject` refuses and retags
  in one write; a lane's guard reads areas and hazards live. One core test on a real SQLite file.
- [Task 2](2026-11-24-area-splits/task-2.md): `broadAreaSplit`, `rebuildAreas` proposing splits for kept areas,
  `SplitRow` and `withSplits`, the modal's split rows, and `setupPatch` sending `areaSplits`. One pure
  rule-table test of `broadAreaSplit`; a click-through on a copy of Ampsio in the Dev window before review.
