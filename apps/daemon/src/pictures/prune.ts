import { ScreenKind, type TaskId, type TaskScreenId } from '@10db/contracts';
import { listFinishedTurnScreens, markScreensPruned } from '@10db/db';
import type { Clock, Timer } from '../clock';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import { removeUnnamed } from './picture-files';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §10 "When", §11: a turn
// picture is kept 14 days after its task is done or cancelled; a before and an after are kept for good.
// No thread message can show a turn picture yet, so none is exempt. A pruned row stays as a record,
// and its file is deleted once no unpruned row names its hash.

/** How long a turn picture is kept after its task is done or cancelled. */
const TURN_PICTURES_KEPT_MS = 14 * 24 * 60 * 60_000;

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

export interface PruningDeps {
  readonly state: StateStore;
  readonly dataDir: string;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** One sweep: marks the prunable turn pictures pruned and deletes the files nothing names any more. */
function sweep(deps: PruningDeps): void {
  const rows = listFinishedTurnScreens(deps.state.db);
  const doneAt = new Map(rows.map((r) => [r.taskId, r.doneAt]));
  const pruned = new Set(prunableTurnScreens(rows, doneAt, deps.clock.now().getTime()));
  if (pruned.size === 0) return;
  deps.state.write((ctx) => {
    markScreensPruned(ctx, [...pruned]);
  });
  let removed = 0;
  for (const sha of new Set(rows.filter((r) => pruned.has(r.id)).map((r) => r.sha256)))
    if (removeUnnamed(deps.state.db, deps.dataDir, sha)) removed += 1;
  deps.logger.info({ pruned: pruned.size, filesRemoved: removed }, 'pruned turn pictures');
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
