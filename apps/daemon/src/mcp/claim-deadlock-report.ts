import { TITLE_MAX, type WorkstreamId } from '@10db/contracts';
import {
  getProject,
  getTask,
  getWorkstreamRow,
  noticesByKey,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import { fileDefect } from '../defects';
import { fitNoticeKey } from '../inbox';
import { deadlockNoticeKey, markReported, type DeadlockPair } from './claim-deadlock-pairs';

function taskOf(db: DbReader, id: WorkstreamId): ReturnType<typeof getTask> {
  return getTask(db, getWorkstreamRow(db, id).taskId);
}

/** What 10db did at the pair's nth break, from 1. */
function didAt(n: number): string {
  if (n === 1) return 'yielded';
  if (n === 2) return 'yielded and queued';
  return 'yielded, queued and reported';
}

function fit(title: string): string {
  return title.length <= TITLE_MAX ? title : `${title.slice(0, TITLE_MAX - 1)}…`;
}

/**
 * Reports a third or later deadlock between the pair, once per pair, in the write that yields and queues:
 * a defect task in 10db's own project, folded with any open one over the same claims. `thisBreak` is the line
 * of the notice this write posts. Null when the pair was reported before or a task was filed; otherwise the
 * report itself, for the yield notice's body to carry.
 */
export function reportClaimDeadlock(
  w: WriteContext,
  pair: DeadlockPair,
  thisBreak: string,
): string | null {
  if (pair.reported) return null;
  const claims = pair.contested
    .map((claim) => `${claim.kind} ${claim.name}`)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const signature = `claim-deadlock:${claims.join(',')}`;
  const title = fit(`Two tasks deadlocked three times over ${claims.join(', ')}`);
  const first = taskOf(w.tx, pair.a);
  const second = taskOf(w.tx, pair.b);
  // An Undo starts the count again and leaves the older notices, so only the last `breaks - 1` are this count's.
  const earlier =
    pair.breaks > 1
      ? noticesByKey(
          w.tx,
          [first.id, second.id],
          fitNoticeKey(deadlockNoticeKey(pair.a, pair.b)),
        ).slice(-(pair.breaks - 1))
      : [];
  const shown = [...earlier, { at: w.now, line: thisBreak }];
  const breaks = shown.map(
    (entry, index) =>
      `- ${entry.at}: ${entry.line}. 10db ${didAt(pair.breaks - shown.length + index + 1)}.`,
  );
  const description = [
    `In project "${getProject(w.tx, first.projectId).name}", tasks "${first.title}" and "${second.title}" deadlocked over claims each held and the other waited for, ${String(pair.breaks)} times.`,
    `Contested claims: ${claims.join(', ')}.`,
    `Breaks:\n${breaks.join('\n')}`,
  ].join('\n\n');
  const filed = fileDefect(w, { signature, title, description });
  markReported(w, pair.a, pair.b);
  if (filed !== null) return null;
  return [
    "No defect task was filed: 10db's project is not on this Mac, or an open task there already reports this.",
    `${title}. Defect signature: ${signature}`,
    description,
  ].join('\n\n');
}
