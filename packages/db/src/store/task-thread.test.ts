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
  insertBuilderMessage,
  insertTask,
  listTaskThread,
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
});
