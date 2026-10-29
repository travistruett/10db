import {
  isTerminal,
  LANE_STATES,
  latestPerTask,
  WorkstreamState,
  type BatchDto,
  type WorkstreamDto,
} from '@10db/contracts';

export interface AbandonNote {
  /** Why Abandon can't run yet: the daemon refuses while any run on the branch is live. */
  readonly refusal: string | null;
  /** One line saying what Abandon does, led by the refusal when there is one. */
  readonly line: string;
}

/** A run the daemon's abandon refuses to cut short: it holds a lane, is taken over, or waits in a live session. */
function isLive(w: WorkstreamDto): boolean {
  return (
    LANE_STATES.includes(w.state) ||
    w.state === WorkstreamState.TakenOver ||
    (w.state === WorkstreamState.WaitingHuman && w.currentSessionId !== null)
  );
}

function names(titles: readonly string[]): string {
  if (titles.length <= 1) return titles.join('');
  return `${titles.slice(0, -1).join(', ')} and ${titles.at(-1) ?? ''}`;
}

/** What Abandon does to a batch: the branch is kept and every unfinished task on it is cancelled. */
export function abandonNote(batch: BatchDto, workstreams: readonly WorkstreamDto[]): AbandonNote {
  const runs = workstreams.filter((w) => w.batchId === batch.id);
  const live = latestPerTask(runs.filter(isLive)).map((w) => w.taskTitle);
  const unfinished = latestPerTask(runs).filter((w) => !isTerminal(w.state)).length;
  const does =
    unfinished === 0
      ? 'Abandon keeps the branch and closes it without shipping.'
      : unfinished === 1
        ? 'Abandon keeps the branch and cancels its unfinished task.'
        : `Abandon keeps the branch and cancels its ${String(unfinished)} unfinished tasks.`;
  const refusal =
    live.length === 0
      ? null
      : live.length === 1
        ? `${names(live)} is running: cancel it in Factory first.`
        : `${names(live)} are running: cancel them in Factory first.`;
  return { refusal, line: refusal ? `${refusal} ${does}` : does };
}
