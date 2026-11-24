import {
  ExternalKind,
  TaskStatus,
  type ExternalLink,
  type TaskDto,
  type TaskId,
} from '@10db/contracts';
import { getTask, skipFollowUpSourceTask, type DbReader } from '@10db/db';

/** The Linear issue a task reports to, and the task it reports for when that is another task's issue. */
export interface LinearTaskLink {
  readonly link: ExternalLink;
  /** The task that holds the link, when it is not this one: the first of its follow-up chain. */
  readonly followUpOf: TaskDto | null;
  /** The chain's earlier tasks, nearest first and ending with `followUpOf`; empty for a task that holds the link. */
  readonly chain: readonly TaskId[];
}

/**
 * A task's Linear issue: its own link, or, for the follow-up Run these now made (or a follow-up of one), the link
 * of the task the chain started from, since one issue has one live linked task and the follow-up's outcome is that
 * issue's. A cancelled source no longer holds its issue, so its follow-ups report nowhere. Null for a task with none.
 */
export function linearLinkOf(db: DbReader, taskId: TaskId): LinearTaskLink | null {
  const task = getTask(db, taskId);
  if (task.external?.kind === ExternalKind.Linear)
    return { link: task.external, followUpOf: null, chain: [] };
  if (task.external !== undefined && task.external !== null) return null;
  const seen = new Set<TaskId>([taskId]);
  const chain: TaskId[] = [];
  let sourceId = skipFollowUpSourceTask(db, taskId);
  while (sourceId !== null && !seen.has(sourceId)) {
    seen.add(sourceId);
    chain.push(sourceId);
    const source = getTask(db, sourceId);
    if (source.status === TaskStatus.Cancelled) return null;
    // Linear is the only tracker a task links today.
    if (source.external !== undefined && source.external !== null)
      return { link: source.external, followUpOf: source, chain };
    sourceId = skipFollowUpSourceTask(db, sourceId);
  }
  return null;
}
