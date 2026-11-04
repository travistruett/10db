import type { SelfUpdateStatusDto } from '@10db/contracts';

const count = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/**
 * What an available update waits for, so a lane stuck behind it can be found: the running work it
 * lets finish, and the lanes parked on a card, which hold it only until the drain begins.
 */
export function updateWaitsFor(data: SelfUpdateStatusDto): string {
  const { working, waitingOnCard } = data.midSession;
  if (data.draining) {
    const running =
      working > 0
        ? `It is waiting for ${count(working, 'running step', 'running steps')} to finish.`
        : 'Nothing is left running, so it installs on the next check.';
    if (waitingOnCard === 0) return running;
    return `${running} Lanes waiting on a card (${String(waitingOnCard)}) do not hold it: after the restart each waits on its card again and resumes when you answer.`;
  }
  if (working === 0 && waitingOnCard === 0) return '';
  const holding = [
    working > 0 ? count(working, 'running step', 'running steps') : null,
    waitingOnCard > 0
      ? `${count(waitingOnCard, 'lane', 'lanes')} waiting on a card (answer it, or it stops holding the update once lanes pause)`
      : null,
  ].filter((part) => part !== null);
  return `Holding it now: ${holding.join(' and ')}.`;
}
