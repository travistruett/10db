import { ACTIVE_STATES, BatchState, ConflictError, type ProjectId } from '@10db/contracts';
import {
  chatsWithLiveSession,
  findOpenPass,
  getProject,
  listUnfinishedBatches,
  listWorkstreams,
  type DbReader,
} from '@10db/db';
import { projectSlack } from '../stakeholders';

/** A failed batch is never finished on its own, so it does not hold an archive back. */
const RUNNING_BATCH_STATES: readonly BatchState[] = [
  BatchState.Cutting,
  BatchState.Open,
  BatchState.Shipping,
];

const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/** What is still running in the project, as phrases for the refusal; empty when it is idle. */
export function runningInProject(db: DbReader, projectId: ProjectId): string[] {
  const running: string[] = [];
  const workstreams = listWorkstreams(db, { projectId, states: ACTIVE_STATES }).length;
  if (workstreams > 0) running.push(plural(workstreams, 'task in progress', 'tasks in progress'));
  if (findOpenPass(db, projectId) !== undefined) running.push('an open pass');
  const batches = listUnfinishedBatches(db, projectId).filter((b) =>
    RUNNING_BATCH_STATES.includes(b.state),
  ).length;
  if (batches > 0) running.push(plural(batches, 'batch being shipped', 'batches being shipped'));
  const chats = chatsWithLiveSession(db, projectId).length;
  if (chats > 0)
    running.push(plural(chats, 'chat with a live session', 'chats with a live session'));
  const out = projectSlack(db, projectId).out;
  if (out > 0) running.push(plural(out, 'Slack question out', 'Slack questions out'));
  return running;
}

/** Archiving stops 10db's activity in the project, so it refuses while anything still runs. */
export function refuseArchiveWhileRunning(db: DbReader, projectId: ProjectId): void {
  const running = runningInProject(db, projectId);
  if (running.length === 0) return;
  throw new ConflictError(
    `${getProject(db, projectId).name} can't be archived while it has ${running.join(', ')}. Stop that work first.`,
  );
}
