import { ClaimKind, type WorkstreamDto } from '@10db/contracts';
import { activeClaims, getTask, type DbReader } from '@10db/db';

/** The areas a workstream's knowledge is scoped to: its task's areas plus any area it has claimed since. */
export function workstreamAreas(
  db: DbReader,
  workstream: Pick<WorkstreamDto, 'id' | 'taskId'>,
): string[] {
  const claimed = activeClaims(db, workstream.id)
    .filter((c) => c.kind === ClaimKind.Area)
    .map((c) => c.name);
  return [...new Set([...getTask(db, workstream.taskId).areas, ...claimed])].sort();
}
