import { NotFoundError, type AccountId, type ModelMarkBasis } from '@10db/contracts';
import {
  clearWordingMark,
  endWordingMarks,
  markAccountModelUnusable,
  type MarkResult,
} from '@10db/db';
import { timerAt, type Clock } from '../clock';
import type { StateStore } from '../events';

interface MarkDeps {
  readonly state: StateStore;
  readonly clock: Clock;
}

/**
 * Marks a model unusable on an account after a session on it was refused (see `ModelMarkBasis`). A mark from an
 * error's wording alone ends on its own, so a timer ends it at its time; `resumeModelMarks` does the same for the
 * marks a restart finds. Null when the account lists no row for the model, so nothing could be marked.
 */
export function markModelUnusable(
  deps: MarkDeps,
  accountId: AccountId,
  model: string,
  basis: ModelMarkBasis,
): MarkResult | null {
  try {
    const result = deps.state.write((ctx) =>
      markAccountModelUnusable(ctx, accountId, model, basis),
    );
    // timerAt looks at the clock again when its timer fires, so a timer that fires early (or a clock set back)
    // waits again instead of finding no mark due and leaving this one with no end.
    if (result.endsAt !== null)
      timerAt(deps.clock, new Date(result.endsAt), () => {
        deps.state.write((ctx) => endWordingMarks(ctx));
      });
    return result;
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    return null;
  }
}

/** A session ran on the model and was not refused: a mark from wording alone was wrong, and goes. */
export function clearModelMark(
  deps: Pick<MarkDeps, 'state'>,
  accountId: AccountId,
  model: string,
): void {
  deps.state.write((ctx) => clearWordingMark(ctx, accountId, model));
}

/**
 * At start: ends the marks whose time passed while the daemon was down, and sets a timer for the rest, one after
 * another, since a restart lost the timers of the marks it found.
 */
export function resumeModelMarks(deps: MarkDeps): void {
  const next = deps.state.write((ctx) => endWordingMarks(ctx));
  if (next === null) return;
  timerAt(deps.clock, new Date(next), () => {
    resumeModelMarks(deps);
  });
}
