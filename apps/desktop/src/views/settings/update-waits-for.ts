import { SHAPE_HOLD_WAY_OUT, type SelfUpdateStatusDto } from '@10db/contracts';

type MidSession = SelfUpdateStatusDto['midSession'];

const count = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

const joined = (parts: readonly string[]): string =>
  parts.length < 2
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] ?? ''}`;

const quoted = (shapes: MidSession['shapes']): string =>
  shapes.map((shape) => `“${shape.title}”`).join(', ');

/** The shaping conversations that hold the update, as the clause that names them. */
function turnsIn(shapes: MidSession['shapes']): string {
  return shapes.length === 1
    ? `a turn in the shaping conversation ${quoted(shapes)}`
    : `turns in ${String(shapes.length)} shaping conversations (${quoted(shapes)})`;
}

/**
 * The work the update waits for, one clause per kind, so the builder knows where to look. Only the
 * lanes and gates are running steps, the ones the Board shows; a batch being cut or shipped, a
 * delivery job and a shaping turn are counted in `working` too and each is named for what it is.
 */
function workClauses(midSession: MidSession): string[] {
  const { working, batches, jobs, shapes } = midSession;
  const steps = Math.max(0, working - batches - jobs - shapes.length);
  return [
    steps > 0 ? count(steps, 'running step', 'running steps') : null,
    batches > 0
      ? count(batches, 'batch being cut or shipped', 'batches being cut or shipped')
      : null,
    jobs > 0 ? count(jobs, 'delivery job', 'delivery jobs') : null,
    shapes.length > 0 ? turnsIn(shapes) : null,
  ].filter((part) => part !== null);
}

/**
 * What an available update waits for, so a lane stuck behind it can be found: the work it lets
 * finish, each kind by name (running steps, batches, delivery jobs, shaping turns), and the lanes
 * parked on a card, which hold it only until the drain begins.
 */
export function updateWaitsFor(data: SelfUpdateStatusDto): string {
  const { waitingOnCard, shapes } = data.midSession;
  const work = workClauses(data.midSession);
  if (data.draining) {
    let running: string;
    if (work.length === 0) running = 'Nothing is left running, so it installs on the next check.';
    else if (work.length === 1 && shapes.length > 0)
      running = `It is waiting only for ${turnsIn(shapes)} to finish. No lane is running: lanes stay paused until it ends. ${SHAPE_HOLD_WAY_OUT}`;
    else running = `It is waiting for ${joined(work)} to finish.`;
    if (waitingOnCard === 0) return running;
    return `${running} Lanes waiting on a card (${String(waitingOnCard)}) do not hold it: after the restart each waits on its card again and resumes when you answer.`;
  }
  if (work.length === 0 && waitingOnCard === 0) return '';
  const holding = [
    ...work,
    waitingOnCard > 0
      ? `${count(waitingOnCard, 'lane', 'lanes')} waiting on a card (answer it, or it stops holding the update once lanes pause)`
      : null,
  ].filter((part) => part !== null);
  return `Holding it now: ${joined(holding)}.`;
}
