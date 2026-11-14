import type { PassHoldDto, PassSharedChangeDto, PassTurnDto } from '@10db/contracts';

// Workbench spec §4.3, §7.2: which of a page's turns a shared hold belongs to, for the turn's file list.

type TurnWindow = Pick<PassTurnDto, 'taskId' | 'workstreamId' | 'startedAt' | 'endedAt'>;
type HoldGrant = Pick<PassHoldDto, 'taskId' | 'workstreamId' | 'seq' | 'grantedAt'>;
type ChainChange = Pick<PassSharedChangeDto, 'seq' | 'dropOf'>;

/**
 * The shared changes a turn's holds kept, by number: a hold is granted to the task's run while its
 * turn is open and kept at the turn's end. The turn's window is half-open, from its start up to but not
 * at its end, so a hold granted the instant one turn ends and the next starts is the next turn's alone.
 * A drop is not the turn's. Pure.
 */
export function sharedKeptIn<H extends HoldGrant, C extends ChainChange>(
  turn: TurnWindow,
  holds: readonly H[],
  changes: readonly C[],
): { readonly hold: H; readonly change: C }[] {
  const from = new Date(turn.startedAt).getTime();
  const to = turn.endedAt === null ? Infinity : new Date(turn.endedAt).getTime();
  return holds.flatMap((hold) => {
    const at = new Date(hold.grantedAt).getTime();
    if (hold.taskId !== turn.taskId || hold.workstreamId !== turn.workstreamId) return [];
    if (at < from || at >= to) return [];
    const change = changes.find((c) => c.seq === hold.seq && c.dropOf === null);
    return change === undefined ? [] : [{ hold, change }];
  });
}
