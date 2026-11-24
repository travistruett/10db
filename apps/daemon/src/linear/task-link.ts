import { ExternalKind, type ExternalLink, type TaskDto, type TaskId } from '@10db/contracts';
import { getTask, skipFollowUpSourceTask, type DbReader } from '@10db/db';

/** The Linear issue a task reports to, and the task it reports for when that is another task's issue. */
export interface LinearTaskLink {
  readonly link: ExternalLink;
  /** The task whose skipped calls this one runs, which holds the link; null when the task holds it. */
  readonly followUpOf: TaskDto | null;
}

/**
 * A task's Linear issue: its own link, or, for the follow-up Run these now made, its source task's, since one
 * issue has one live linked task and the follow-up's outcome is that issue's. Null for a task with neither.
 */
export function linearLinkOf(db: DbReader, taskId: TaskId): LinearTaskLink | null {
  const task = getTask(db, taskId);
  if (task.external?.kind === ExternalKind.Linear) return { link: task.external, followUpOf: null };
  if (task.external !== undefined && task.external !== null) return null;
  const sourceId = skipFollowUpSourceTask(db, taskId);
  if (sourceId === null) return null;
  const source = getTask(db, sourceId);
  return source.external?.kind === ExternalKind.Linear
    ? { link: source.external, followUpOf: source }
    : null;
}
