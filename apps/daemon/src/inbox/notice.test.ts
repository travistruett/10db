import {
  APP_ENTITY_ID,
  EventType,
  NoticePostedData,
  type DaemonEvent,
  type ProjectId,
  type TaskId,
} from '@10db/contracts';
import {
  createTestStore,
  insertTask,
  listEventsAfter,
  listInbox,
  seedProject,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CardTier } from './card-tier';
import { fitNoticeKey, InvalidNoticeError, postNotice, type NoticeInput } from './notice';

let store: Store;
let close: () => void;
let projectId: ProjectId;
let taskId: TaskId;
beforeEach(() => {
  ({ store, close } = createTestStore());
  projectId = seedProject(store).id;
  taskId = store.write((ctx) =>
    insertTask(ctx, projectId, { title: 'T', acceptanceCriteria: ['x'], areas: ['api'] }),
  ).value.id;
});
afterEach(() => {
  close();
});

function notice(over: Partial<NoticeInput> = {}): NoticeInput {
  return {
    tier: CardTier.Notice,
    projectId: null,
    taskId: null,
    key: 'k',
    tone: 'info',
    line: 'a line',
    body: '',
    ...over,
  };
}

function posted(): DaemonEvent[] {
  return listEventsAfter(store.db, 0, 1000).filter((e) => e.type === EventType.NoticePosted);
}

function only(): { entityType: string; entityId: string; data: NoticePostedData } {
  const [event, ...rest] = posted();
  if (!event || rest.length > 0) throw new Error('expected exactly one notice.posted event');
  return {
    entityType: event.entityType,
    entityId: event.entityId,
    data: NoticePostedData.parse(event.data),
  };
}

describe('postNotice', () => {
  const long = 'k'.repeat(201);
  const rows: {
    name: string;
    input: () => NoticeInput;
    entity: () => [string, string];
    check?: (data: NoticePostedData) => void;
  }[] = [
    {
      name: 'a task and a project file under the task',
      input: () => notice({ projectId, taskId }),
      entity: () => ['task', taskId],
    },
    {
      name: 'a project alone files under the project',
      input: () => notice({ projectId }),
      entity: () => ['project', projectId],
    },
    {
      name: 'neither files under the app',
      input: () => notice(),
      entity: () => ['app', APP_ENTITY_ID],
    },
    {
      name: 'a 600-character line is cut to 500 and ends in an ellipsis',
      input: () => notice({ line: 'x'.repeat(600) }),
      entity: () => ['app', APP_ENTITY_ID],
      check: (d) => {
        expect(d.line).toHaveLength(500);
        expect(d.line.endsWith('…')).toBe(true);
      },
    },
    {
      name: 'a 201-character key keeps 135, an ellipsis and 64 hex digits',
      input: () => notice({ key: long }),
      entity: () => ['app', APP_ENTITY_ID],
      check: (d) => {
        expect(d.key).toHaveLength(200);
        expect(d.key.slice(0, 135)).toBe('k'.repeat(135));
        expect(d.key[135]).toBe('…');
        expect(d.key.slice(136)).toMatch(/^[0-9a-f]{64}$/);
      },
    },
    {
      name: 'a 200-character key is stored unchanged',
      input: () => notice({ key: 'j'.repeat(200) }),
      entity: () => ['app', APP_ENTITY_ID],
      check: (d) => {
        expect(d.key).toBe('j'.repeat(200));
      },
    },
  ];

  it.each(rows)('$name', ({ input, entity, check }) => {
    store.write((ctx) => {
      postNotice(ctx, input());
    });
    const event = only();
    expect([event.entityType, event.entityId]).toEqual(entity());
    check?.(event.data);
  });

  it('gives equal long keys equal stored keys, and different ones different keys', () => {
    expect(fitNoticeKey('k'.repeat(300))).toBe(fitNoticeKey('k'.repeat(300)));
    expect(fitNoticeKey('k'.repeat(300))).not.toBe(fitNoticeKey(`${'k'.repeat(299)}j`));
  });

  it('leaves no notice behind when the write that posted it throws', () => {
    expect(() =>
      store.write((ctx) => {
        postNotice(ctx, notice());
        throw new Error('the caller failed after posting');
      }),
    ).toThrow('the caller failed');
    expect(posted()).toEqual([]);
  });

  it('refuses a task with no project as the caller bug it is', () => {
    expect(() =>
      store.write((ctx) => {
        postNotice(ctx, notice({ taskId }));
      }),
    ).toThrow(InvalidNoticeError);
    expect(posted()).toEqual([]);
  });

  it('raises no card', () => {
    store.write((ctx) => {
      postNotice(ctx, notice({ projectId, taskId }));
    });
    expect(listInbox(store.db, { states: ['OPEN'] })).toEqual([]);
  });
});
