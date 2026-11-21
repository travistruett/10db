import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  ScreenKind,
  type DesignCheckId,
  type ShapeId,
  type TaskId,
  type TaskScreenId,
} from '@10db/contracts';
import {
  deleteDesignChecks,
  designCheckNames,
  listDesignChecksForPruning,
  listFinishedTurnScreens,
  listPrunedHashes,
  markScreensPruned,
} from '@10db/db';
import type { Clock, Timer } from '../clock';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import { removeUnnamed } from './picture-files';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §10 "When", §11: a turn
// picture, and a design check, is kept 14 days after its task is done or cancelled; a before and an after
// are kept for good.
// No thread message can show a turn picture yet, so none is exempt. A pruned row stays as a record,
// and its file is deleted once no unpruned row names its hash.

/** How long a turn picture is kept after its task is done or cancelled. */
const TURN_PICTURES_KEPT_MS = 14 * 24 * 60 * 60_000;

/** A file this young is left alone: a check that will name it may not be written yet. */
const NEW_FILE_KEPT_MS = 10 * 60_000;

/** How often the sweep runs after the one at start-up. */
const PRUNE_EVERY_MS = 24 * 60 * 60_000;

/** The turn pictures among `rows` whose task was done (by `doneAt`) at least 14 days before `now`. */
export function prunableTurnScreens(
  rows: readonly {
    readonly id: TaskScreenId;
    readonly taskId: TaskId;
    readonly kind: ScreenKind;
  }[],
  doneAt: ReadonlyMap<TaskId, string>,
  now: number,
): TaskScreenId[] {
  return rows.flatMap((row) => {
    if (row.kind !== ScreenKind.Turn) return [];
    const done = doneAt.get(row.taskId);
    return done !== undefined && now - Date.parse(done) >= TURN_PICTURES_KEPT_MS ? [row.id] : [];
  });
}

/**
 * The design checks to delete: a task's 14 days after the task was done or cancelled, one with no task
 * (a plan's Design review) 14 days after it was made.
 */
export function prunableDesignChecks(
  rows: readonly {
    readonly id: DesignCheckId;
    readonly createdAt: string;
    readonly taskDoneAt: string | null;
    readonly hasTask: boolean;
  }[],
  now: number,
): DesignCheckId[] {
  return rows.flatMap((row) => {
    const since = row.hasTask ? row.taskDoneAt : row.createdAt;
    return since !== null && now - Date.parse(since) >= TURN_PICTURES_KEPT_MS ? [row.id] : [];
  });
}

export interface PruningDeps {
  /** A plan's folder, where a Design review copies its pictures; absent, none are removed. */
  readonly planFilesDir?: (shapeId: ShapeId) => string;
  readonly state: StateStore;
  readonly dataDir: string;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * One sweep: marks the prunable turn pictures pruned, then deletes every file only pruned rows name,
 * so a file whose removal failed on an earlier sweep goes on a later one.
 */
function sweep(deps: PruningDeps): void {
  const now = deps.clock.now().getTime();
  const rows = listFinishedTurnScreens(deps.state.db);
  const doneAt = new Map(rows.map((r) => [r.taskId, r.doneAt]));
  const pruned = prunableTurnScreens(rows, doneAt, deps.clock.now().getTime());
  if (pruned.length > 0)
    deps.state.write((ctx) => {
      markScreensPruned(ctx, pruned);
    });
  const checks = prunableDesignChecks(listDesignChecksForPruning(deps.state.db), now);
  const gone =
    checks.length === 0
      ? { hashes: [], planCopies: [] }
      : deps.state.write((ctx) => deleteDesignChecks(ctx, checks));
  const checkHashes = gone.hashes;
  // A Design review's pictures were copied into its plan's folder: they go on the same day, unless a
  // check still names them.
  for (const copy of gone.planCopies)
    if (deps.planFilesDir !== undefined && !designCheckNames(deps.state.db, copy.sha256))
      rmSync(join(deps.planFilesDir(copy.shapeId), 'design', `${copy.sha256}.png`), {
        force: true,
      });
  let removed = 0;
  for (const sha of new Set([...listPrunedHashes(deps.state.db), ...checkHashes]))
    if (removeUnnamed(deps.state.db, deps.dataDir, sha, now - NEW_FILE_KEPT_MS)) removed += 1;
  if (pruned.length > 0 || removed > 0)
    deps.logger.info({ pruned: pruned.length, filesRemoved: removed }, 'pruned turn pictures');
}

/** Sweeps at once, then every `PRUNE_EVERY_MS`, until stopped; a failed sweep is logged and tried again. */
export function startPruning(deps: PruningDeps): { readonly stop: () => void } {
  let timer: Timer | null = null;
  let stopped = false;
  const run = (): void => {
    try {
      sweep(deps);
    } catch (error) {
      deps.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'could not prune turn pictures',
      );
    }
    if (!stopped) timer = deps.clock.setTimeout(run, PRUNE_EVERY_MS);
  };
  run();
  return {
    stop: () => {
      stopped = true;
      timer?.cancel();
    },
  };
}
