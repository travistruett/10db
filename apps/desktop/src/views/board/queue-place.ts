import {
  queueOrder,
  WorkstreamState,
  type WorkstreamDto,
  type WorkstreamId,
} from '@10db/contracts';

/** Each queued workstream's place in line, counting from 1, in the order the scheduler takes them. */
export function queuePlaces(workstreams: readonly WorkstreamDto[]): Map<WorkstreamId, number> {
  const line = workstreams.filter((w) => w.state === WorkstreamState.Queued).toSorted(queueOrder);
  return new Map(line.map((w, index) => [w.id, index + 1] as const));
}

/** 2 as "2nd", 11 as "11th". */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${String(n)}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
  return `${String(n)}${suffix}`;
}

function listOf(titles: readonly string[]): string {
  return titles.length < 2
    ? titles.join('')
    : `${titles.slice(0, -1).join(', ')} and ${titles.at(-1) ?? ''}`;
}

/** What the builder is told after Run Next: it is first in line, and runs once its dependencies are done. */
export function runNextNote(title: string, waitingOn: readonly string[]): string {
  if (waitingOn.length === 0) return `${title} is next in line for a free lane.`;
  return `${title} will run once ${listOf(waitingOn)} ${waitingOn.length === 1 ? 'is' : 'are'} done, before the other queued tasks.`;
}
