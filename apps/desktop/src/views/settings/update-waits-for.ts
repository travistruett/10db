import type { SelfUpdateStatusDto } from '@10db/contracts';

const count = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

const quoted = (shapes: SelfUpdateStatusDto['midSession']['shapes']): string =>
  shapes.map((shape) => `“${shape.title}”`).join(', ');

/** The shaping conversations that hold the update, as the clause that names them. */
function turnsIn(shapes: SelfUpdateStatusDto['midSession']['shapes']): string {
  return shapes.length === 1
    ? `a turn in the shaping conversation ${quoted(shapes)}`
    : `turns in ${String(shapes.length)} shaping conversations (${quoted(shapes)})`;
}

/**
 * What an available update waits for, so a lane stuck behind it can be found: the running work it
 * lets finish, the shaping conversations whose turn is under way (no lane is running for them, so
 * they are named), and the lanes parked on a card, which hold it only until the drain begins.
 */
export function updateWaitsFor(data: SelfUpdateStatusDto): string {
  const { working, waitingOnCard, shapes } = data.midSession;
  // A turn is part of `working`; what remains is lanes, gates, batches and jobs.
  const steps = Math.max(0, working - shapes.length);
  if (data.draining) {
    let running: string;
    if (working === 0) running = 'Nothing is left running, so it installs on the next check.';
    else if (steps === 0 && shapes.length > 0)
      running = `It is waiting only for ${turnsIn(shapes)} to finish. No lane is running: lanes stay paused until it ends. If it is stuck, open the conversation and press Stop.`;
    else
      running = `It is waiting for ${count(working, 'running step', 'running steps')} to finish${shapes.length > 0 ? `, among them ${turnsIn(shapes)}` : ''}.`;
    if (waitingOnCard === 0) return running;
    return `${running} Lanes waiting on a card (${String(waitingOnCard)}) do not hold it: after the restart each waits on its card again and resumes when you answer.`;
  }
  if (working === 0 && waitingOnCard === 0) return '';
  const holding = [
    steps > 0 ? count(steps, 'running step', 'running steps') : null,
    shapes.length > 0 ? turnsIn(shapes) : null,
    waitingOnCard > 0
      ? `${count(waitingOnCard, 'lane', 'lanes')} waiting on a card (answer it, or it stops holding the update once lanes pause)`
      : null,
  ].filter((part) => part !== null);
  return `Holding it now: ${holding.join(' and ')}.`;
}
