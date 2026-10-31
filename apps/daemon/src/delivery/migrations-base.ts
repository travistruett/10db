import type { WorkstreamId } from '@10db/contracts';
import { getBatch, getTask, getWorkstreamRow } from '@10db/db';
import type { BaseHeld, BaseUpdates } from './base-update';
import type { DeliveryContext } from './context';

/** The stock hazard whose claim lets a task write and generate database migrations. */
export const MIGRATIONS_HAZARD = 'migrations';

/** What bringing the base in before the migrations hazard came to. */
export type MigrationsBaseTake =
  /**
   * The task may have the hazard: its branch holds its base as origin has it, or there was nothing
   * to bring it into (the builder's own checkout, work with no batch) or no way to (a failed fetch).
   */
  | { readonly kind: 'ready' }
  /** The branch can't take its base: the task gets no hazard. `instruction` tells its agent why. */
  | { readonly kind: 'held'; readonly instruction: string }
  /** The session stopped first. */
  | { readonly kind: 'aborted' };

export interface MigrationsBase {
  /**
   * Brings the batch's base, as origin has it now, into the task's branch before the task is given
   * the migrations hazard, so a migration it generates is numbered after the base's latest: worktrees
   * are cut from the base once and never rebased, and migrations are numbered in order. Runs as a gate
   * does, in the batch's turn, so no gate's tree changes under it. Asks that overlap for one task
   * share one merge.
   */
  take(workstreamId: WorkstreamId, signal: AbortSignal): Promise<MigrationsBaseTake>;
}

/** What a session held back from the migrations hazard is told: why, and what to do next. */
function instructionFor(held: BaseHeld, base: string): string {
  const origin = `origin/${base}`;
  const files = held.paths.join(', ');
  const notGiven = `and has not given you the migrations hazard: a migration generated now would be numbered before ${base}'s latest. Don't generate or write a migration.`;
  switch (held.reason) {
    case 'conflict':
      return `${origin} conflicts with this branch in ${files}, so 10db couldn't bring it in ${notGiven} The batch's task cards show the conflict. Carry on with your other work, and call request_claim again with the same opId once it is resolved; if the migration is all that is left, ask the builder with ask_human to resolve it.`;
    case 'untracked':
      return `Files git doesn't track (${files}) are in the way of ${origin}'s newer commits, so 10db couldn't bring them in ${notGiven} Leave those files alone: the batch's task cards show them. Carry on with your other work, and call request_claim again with the same opId once they are out of the way; if the migration is all that is left, ask the builder with ask_human to move them.`;
    case 'uncommitted':
      return `Uncommitted changes in ${files} are in the way of ${origin}'s newer commits, so 10db couldn't bring them in ${notGiven} Commit those files with the commit tool, or undo your change to them, then call request_claim again with the same opId.`;
  }
}

export function createMigrationsBase(
  ctx: Pick<DeliveryContext, 'state'>,
  updates: BaseUpdates,
): MigrationsBase {
  const db = ctx.state.db;
  const inFlight = new Map<WorkstreamId, Promise<MigrationsBaseTake>>();

  async function take(id: WorkstreamId, signal: AbortSignal): Promise<MigrationsBaseTake> {
    if (signal.aborted) return { kind: 'aborted' };
    const row = getWorkstreamRow(db, id);
    if (row.batchId === null) return { kind: 'ready' };
    const batch = getBatch(db, row.batchId);
    // 10db never merges into the builder's own checkout.
    if (batch.worktreePath === null) return { kind: 'ready' };
    const task = getTask(db, row.taskId).title;
    const update = await updates.gate(batch.id, signal, () =>
      updates.beforeGate(batch.id, signal, { forMigrations: { task } }),
    );
    if (update === null || update.kind === 'aborted') return { kind: 'aborted' };
    if (update.kind !== 'not_merged' || update.held === undefined) return { kind: 'ready' };
    const { held } = update;
    return { kind: 'held', instruction: instructionFor(held, batch.baseBranch) };
  }

  return {
    take(id, signal) {
      const running = inFlight.get(id);
      if (running) return running;
      const next = take(id, signal).finally(() => {
        inFlight.delete(id);
      });
      inFlight.set(id, next);
      return next;
    },
  };
}
