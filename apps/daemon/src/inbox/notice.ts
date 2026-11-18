import { createHash } from 'node:crypto';
import {
  APP_ENTITY_ID,
  EventType,
  fitNotice,
  NoticeEntity,
  NoticePostedData,
  type Notice,
  type ProjectId,
  type TaskId,
} from '@10db/contracts';
import type { WriteContext } from '@10db/db';
import type { CardTier } from './card-tier';

/** A notice that asks nothing: stored as a `notice.posted` event, never as a card. */
export interface NoticeInput {
  readonly tier: typeof CardTier.Notice;
  readonly projectId: ProjectId | null;
  /** Set only with a `projectId`. */
  readonly taskId: TaskId | null;
  readonly key: string;
  readonly tone: Notice['tone'];
  readonly line: string;
  readonly body: string;
}

/** A notice filed under a task that has no project: the raiser's bug, never the builder's data. */
export class InvalidNoticeError extends Error {
  override readonly name = 'InvalidNoticeError';
}

const KEY_MAX = 200;
const KEY_KEPT = 135;
const DIGEST_HEX = 64;

/**
 * The key a notice is stored under. One of 200 characters or fewer stays as it is; a longer one keeps
 * its head and ends in a sha256 of the whole, so equal long keys stay equal and the key still parses.
 */
export function fitNoticeKey(key: string): string {
  if (key.length <= KEY_MAX) return key;
  const digest = createHash('sha256').update(key).digest('hex').slice(0, DIGEST_HEX);
  return `${key.slice(0, KEY_KEPT)}…${digest}`;
}

/** Appends the notice to the events log inside the caller's write: it commits or rolls back with it. */
export function postNotice(ctx: WriteContext, notice: NoticeInput): void {
  const { projectId, taskId } = notice;
  if (taskId !== null && projectId === null) {
    throw new InvalidNoticeError(`a notice on task ${taskId} names no project`);
  }
  const { key, tone, line, body } = fitNotice({
    key: fitNoticeKey(notice.key),
    tone: notice.tone,
    line: notice.line,
    body: notice.body,
  });
  const data = NoticePostedData.parse({ projectId, taskId, key, tone, line, body });
  const entity =
    taskId !== null
      ? { entityType: NoticeEntity.Task, entityId: taskId }
      : projectId !== null
        ? { entityType: NoticeEntity.Project, entityId: projectId }
        : { entityType: NoticeEntity.App, entityId: APP_ENTITY_ID };
  ctx.emit({ type: EventType.NoticePosted, ...entity, data });
}
