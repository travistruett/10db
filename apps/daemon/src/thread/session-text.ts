import {
  TaskMessageAuthor,
  TaskMessageKind,
  type TaskDto,
  type TaskFileId,
  type TaskMessageId,
} from '@10db/contracts';
import { listTaskThreadRows, type DbReader, type TaskFileRow, type TaskMessageRow } from '@10db/db';

// Workbench spec §6.3: how a task's thread reads to a lane session. A picture the builder pasted is
// named by where it is kept, which the session's Read may open (§13); only a message sent now carries
// its pictures as image blocks.

/** The thread's note that a lane started a fresh session, from the digest, for a builder message. */
export const FRESH_SESSION_NOTICE = 'Started a fresh session';

/**
 * A message may reach a session more than once (Workbench spec §6.3: delivery is at least once), and
 * always under its id.
 */
const REPEAT_LINE =
  '(10db may send a message again: one with the same id as a message you have seen is the same message, so act on it once.)';

/** What a fresh session is told of a picture it does not hold. */
const pictureLine = (file: TaskFileRow): string =>
  `[Picture ${file.name}, kept at ${file.storedPath}: Read it to see it.]`;

/**
 * A builder message as a session reads it, under its id so a message sent again reads as the same one.
 * The pictures in `asBlocks` go with it as image blocks; any other is named by its path.
 */
export function builderMessageText(
  message: TaskMessageRow,
  asBlocks: ReadonlySet<TaskFileId>,
): string {
  const attached = message.files.filter((file) => asBlocks.has(file.id));
  return [
    `The builder wrote in the task's thread (message ${message.id}):`,
    message.body,
    ...(attached.length > 0
      ? [`[${attached.map((file) => file.name).join(', ')} attached as pictures.]`]
      : []),
    ...message.files.filter((file) => !asBlocks.has(file.id)).map(pictureLine),
    REPEAT_LINE,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * What a fresh session of a task is told of its thread before the builder's message `before`: the
 * task's brief, then the builder's messages and the agent's replies, from the latest handoff on when
 * there is one (`after`, its time), since the handoff carries what came before. Built from the rows
 * alone, so the same thread always gives the same digest. A pasted picture is named, not resent.
 * The files each turn changed join its reply once turns are rows.
 */
export function buildThreadDigest(
  db: DbReader,
  task: Pick<TaskDto, 'id' | 'title' | 'description'>,
  window: { readonly after: string | null; readonly before: TaskMessageId },
): string {
  const said = listTaskThreadRows(db, task.id).filter(
    (m) =>
      m.id < window.before &&
      (window.after === null || m.createdAt >= window.after) &&
      ((m.author === TaskMessageAuthor.Builder && m.kind === TaskMessageKind.Message) ||
        (m.author === TaskMessageAuthor.Agent && m.kind === TaskMessageKind.Reply)),
  );
  const lines = [
    "This task's thread continues in a fresh session. Here is where it stands.",
    '',
    `The brief: ${task.title}`,
    ...(task.description === '' ? [] : [task.description]),
    '',
    window.after === null ? 'The thread so far:' : 'The thread since the latest handoff:',
  ];
  if (said.length === 0) lines.push('Nothing was said before the message below.');
  for (const m of said) {
    if (m.author === TaskMessageAuthor.Agent) {
      lines.push(`[your reply] ${m.body}`);
      continue;
    }
    lines.push(`[builder, message ${m.id}] ${m.body}`, ...m.files.map(pictureLine));
  }
  return lines.join('\n');
}
