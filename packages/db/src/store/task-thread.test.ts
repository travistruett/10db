import {
  EventType,
  mintId,
  NotFoundError,
  TaskMessageAuthor,
  TaskMessageKind,
  type TaskId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestStore,
  getTaskFile,
  getTaskMessageRow,
  insertBuilderMessage,
  insertSystemNotice,
  insertTask,
  listTaskThread,
  listUndeliveredTaskMessages,
  markTaskFilesInline,
  markTaskMessagesDelivered,
  markTaskMessagesPushed,
  seedProject,
  type Store,
} from './index';

// Workbench spec §11: a task's thread is rows, so it survives a restart, and a pasted picture's row
// names the message it came with.

let store: Store;
let close: () => void;
let taskId: TaskId;
let otherTaskId: TaskId;
beforeEach(() => {
  ({ store, close } = createTestStore());
  const project = seedProject(store, { name: 'alpha' });
  const task = (title: string) =>
    store.write((ctx) =>
      insertTask(ctx, project.id, { title, acceptanceCriteria: ['x'], areas: ['ui'] }),
    ).value.id;
  taskId = task('Settings page');
  otherTaskId = task('Board page');
});
afterEach(() => {
  close();
});

const picture = (name: string, sha: string) => ({
  name,
  mediaType: 'image/png' as const,
  size: 120,
  sha256: sha.repeat(64),
  storedPath: `/data/tasks/${taskId}/files/${sha.repeat(64)}.png`,
});

describe('a task thread', () => {
  it('keeps a builder message with its pictures, oldest first, each picture under its own message', () => {
    const first = store.write((ctx) =>
      insertBuilderMessage(ctx, taskId, {
        body: 'Make the header smaller',
        files: [picture('before.png', 'a'), picture('after.png', 'b')],
      }),
    );
    store.write((ctx) => insertBuilderMessage(ctx, otherTaskId, { body: 'Elsewhere', files: [] }));
    const second = store.write((ctx) =>
      insertBuilderMessage(ctx, taskId, { body: 'And the footer', files: [] }),
    ).value;

    const thread = listTaskThread(store.db, taskId);
    expect(thread.map((m) => m.body)).toEqual(['Make the header smaller', 'And the footer']);
    expect(thread[0]).toMatchObject({
      id: first.value.id,
      taskId,
      author: TaskMessageAuthor.Builder,
      kind: TaskMessageKind.Message,
      pushedAt: null,
      deliveredAt: null,
    });
    expect(thread[0]?.files.map((f) => [f.name, f.messageId, f.inlineSent])).toEqual([
      ['before.png', first.value.id, false],
      ['after.png', first.value.id, false],
    ]);
    expect(thread[1]).toMatchObject({ id: second.id, files: [] });
    expect(thread[0]?.files[0]).not.toHaveProperty('storedPath');
    expect(
      first.events.map((e) => [e.type, e.entityType, e.entityId, e.data['messageId']]),
    ).toEqual([[EventType.TaskMessageAdded, 'task', taskId, first.value.id]]);
  });

  it('gets one picture by its id, with where it is kept', () => {
    const message = store.write((ctx) =>
      insertBuilderMessage(ctx, taskId, { body: '', files: [picture('shot.png', 'c')] }),
    ).value;
    const id = message.files[0]?.id;
    if (id === undefined) throw new Error('no file');
    expect(getTaskFile(store.db, id)).toMatchObject({
      taskId,
      messageId: message.id,
      sha256: 'c'.repeat(64),
      storedPath: `/data/tasks/${taskId}/files/${'c'.repeat(64)}.png`,
    });
    expect(() => getTaskFile(store.db, mintId('TaskFile'))).toThrow(NotFoundError);
  });

  it('writes nothing for an unknown task, and nothing when the write it is part of fails', () => {
    expect(() =>
      store.write((ctx) =>
        insertBuilderMessage(ctx, mintId('Task'), { body: 'x', files: [picture('a.png', 'd')] }),
      ),
    ).toThrow(NotFoundError);
    expect(() =>
      store.write((ctx) => {
        insertBuilderMessage(ctx, taskId, { body: 'half', files: [picture('a.png', 'e')] });
        throw new Error('the picture never reached the disk');
      }),
    ).toThrow('the picture never reached the disk');
    expect(listTaskThread(store.db, taskId)).toEqual([]);
    expect(store.db.$client.prepare('select count(*) as n from task_files').get()).toEqual({
      n: 0,
    });
  });

  it('marks a message pushed, then delivered once, and lists those pushed and not delivered', () => {
    const add = (id: TaskId, body: string, files = [] as ReturnType<typeof picture>[]) =>
      store.write((ctx) => insertBuilderMessage(ctx, id, { body, files })).value;
    const first = add(taskId, 'First', [picture('a.png', 'a')]);
    const second = add(taskId, 'Second');
    const unpushed = add(taskId, 'Not handed over yet');
    const elsewhere = add(otherTaskId, 'Another task');
    store.write((ctx) => {
      markTaskMessagesPushed(ctx, [first.id, second.id, elsewhere.id]);
    });
    expect(listUndeliveredTaskMessages(store.db, taskId).map((m) => m.body)).toEqual([
      'First',
      'Second',
    ]);
    expect(
      listUndeliveredTaskMessages(store.db, taskId)[0]?.files.map((f) => f.storedPath),
    ).toEqual([picture('a.png', 'a').storedPath]);

    // Another task's message is not this task's to mark, and a mark is made once.
    const marked = store.write((ctx) =>
      markTaskMessagesDelivered(ctx, taskId, [second.id, elsewhere.id]),
    ).value;
    expect(marked).toEqual([second.id]);
    const deliveredAt = getTaskMessageRow(store.db, second.id).deliveredAt;
    expect(deliveredAt).not.toBeNull();
    expect(store.write((ctx) => markTaskMessagesDelivered(ctx, taskId, [second.id])).value).toEqual(
      [],
    );
    expect(getTaskMessageRow(store.db, second.id).deliveredAt).toBe(deliveredAt);
    expect(getTaskMessageRow(store.db, elsewhere.id).deliveredAt).toBeNull();
    expect(listUndeliveredTaskMessages(store.db, taskId).map((m) => m.id)).toEqual([first.id]);
    expect(getTaskMessageRow(store.db, unpushed.id).pushedAt).toBeNull();
    expect(() => getTaskMessageRow(store.db, mintId('TaskMessage'))).toThrow(NotFoundError);
  });

  it("marks the pictures a session holds as blocks, and a fresh session's start clears the rest", () => {
    const message = store.write((ctx) =>
      insertBuilderMessage(ctx, taskId, {
        body: '',
        files: [picture('a.png', 'a'), picture('b.png', 'b')],
      }),
    ).value;
    const [a, b] = message.files.map((f) => f.id);
    if (a === undefined || b === undefined) throw new Error('no files');
    const inline = () => listTaskThread(store.db, taskId)[0]?.files.map((f) => f.inlineSent);
    store.write((ctx) => {
      markTaskFilesInline(ctx, taskId, [a], false);
    });
    expect(inline()).toEqual([true, false]);
    store.write((ctx) => {
      markTaskFilesInline(ctx, taskId, [b], true);
    });
    expect(inline()).toEqual([false, true]);
  });

  it('writes a notice of its own to the thread, from the system', () => {
    const notice = store.write((ctx) => insertSystemNotice(ctx, taskId, 'Started a fresh session'));
    expect(listTaskThread(store.db, taskId)).toEqual([
      expect.objectContaining({
        id: notice.value.id,
        author: TaskMessageAuthor.System,
        kind: TaskMessageKind.Notice,
        body: 'Started a fresh session',
        files: [],
      }),
    ]);
    expect(notice.events.map((e) => e.type)).toEqual([EventType.TaskMessageAdded]);
  });
});
