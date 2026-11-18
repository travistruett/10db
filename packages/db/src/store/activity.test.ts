import {
  ActivityPageQuery,
  APP_ENTITY_ID,
  EventType,
  mintId,
  type NoticePostedData,
  type ProjectId,
  type TaskId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Json } from '../json';
import {
  createTestStore,
  hasNoticeKey,
  insertTask,
  pageActivity,
  seedProject,
  type Store,
} from './index';

let store: Store;
let close: () => void;
let nowMs: number;
beforeEach(() => {
  nowMs = Date.parse('2026-11-17T12:00:00.000Z');
  ({ store, close } = createTestStore(() => new Date(nowMs)));
});
afterEach(() => {
  close();
});

/** Posts a notice `afterMin` minutes after the previous one's time, filed under its entity. */
function post(
  entity: { type: 'task' | 'project' | 'app'; id: string },
  data: Partial<NoticePostedData> & { key: string },
  afterMin = 20,
): number {
  nowMs += afterMin * 60_000;
  const body: NoticePostedData = {
    projectId: null,
    taskId: null,
    tone: 'info',
    line: `line of ${data.key}`,
    body: '',
    ...data,
  };
  return emitNotice(entity.type, entity.id, body);
}

/** Appends one notice.posted event and returns its seq. */
function emitNotice(entityType: string, entityId: string, data: Record<string, Json>): number {
  const { events } = store.write((ctx) => {
    ctx.emit({ type: EventType.NoticePosted, entityType, entityId, data });
  });
  const seq = events[0]?.seq;
  if (seq === undefined) throw new Error('no event was appended');
  return seq;
}

/** Another event type between notices, so a read has something to skip. */
function noise(): void {
  store.write((ctx) => {
    ctx.emit({ type: EventType.InboxChanged, entityType: 'inbox', entityId: 'x', data: {} });
  });
}

function query(over: Record<string, unknown> = {}): ActivityPageQuery {
  return ActivityPageQuery.parse(over);
}

function seedTask(projectId: ProjectId): TaskId {
  return store.write((ctx) =>
    insertTask(ctx, projectId, { title: 'T', acceptanceCriteria: ['x'], areas: ['api'] }),
  ).value.id;
}

describe('pageActivity', () => {
  it('reads notices newest first, skips other events, and ends with a null cursor', () => {
    const a = post({ type: 'app', id: APP_ENTITY_ID }, { key: 'a' });
    noise();
    const b = post({ type: 'app', id: APP_ENTITY_ID }, { key: 'b' });
    noise();
    const page = pageActivity(store.db, query());
    expect(page.rows.map((r) => r.seq)).toEqual([b, a]);
    expect(page.next).toBeNull();
  });

  it('pages 5 distinct notices by 2 with no repeat and no gap', () => {
    const seqs = ['a', 'b', 'c', 'd', 'e'].map((key) => {
      noise();
      return post({ type: 'app', id: APP_ENTITY_ID }, { key });
    });
    const seen: number[] = [];
    let after: number | undefined;
    for (let i = 0; i < 10; i += 1) {
      const page = pageActivity(store.db, query({ pageSize: 2, after }));
      seen.push(...page.rows.map((r) => r.seq));
      if (page.next === null) break;
      after = page.next;
    }
    expect(seen).toEqual([...seqs].reverse());
  });

  it('a project page holds its own and its tasks notices, not another project or the app', () => {
    const p1 = seedProject(store);
    const p2 = seedProject(store);
    const task = seedTask(p1.id);
    const own = post({ type: 'project', id: p1.id }, { key: 'own', projectId: p1.id });
    const onTask = post(
      { type: 'task', id: task },
      { key: 'task', projectId: p1.id, taskId: task },
    );
    post({ type: 'project', id: p2.id }, { key: 'other', projectId: p2.id });
    post({ type: 'app', id: APP_ENTITY_ID }, { key: 'app' });
    const page = pageActivity(store.db, query({ project: p1.id }));
    expect(page.rows.map((r) => r.seq)).toEqual([onTask, own]);
  });

  it('a task page holds only that tasks notices', () => {
    const p = seedProject(store);
    const t1 = seedTask(p.id);
    const t2 = seedTask(p.id);
    post({ type: 'project', id: p.id }, { key: 'proj', projectId: p.id });
    const mine = post({ type: 'task', id: t1 }, { key: 'm', projectId: p.id, taskId: t1 });
    post({ type: 'task', id: t2 }, { key: 'n', projectId: p.id, taskId: t2 });
    expect(pageActivity(store.db, query({ task: t1 })).rows.map((r) => r.seq)).toEqual([mine]);
  });

  it('q matches the line or the body, and a percent sign is literal', () => {
    const inLine = post({ type: 'app', id: APP_ENTITY_ID }, { key: 'a', line: 'Branch gone' });
    const inBody = post({ type: 'app', id: APP_ENTITY_ID }, { key: 'b', body: 'on branch x' });
    post({ type: 'app', id: APP_ENTITY_ID }, { key: 'c', line: '100 done' });
    const pct = post({ type: 'app', id: APP_ENTITY_ID }, { key: 'd', line: '50% done' });
    expect(pageActivity(store.db, query({ q: 'branch' })).rows.map((r) => r.seq)).toEqual([
      inBody,
      inLine,
    ]);
    expect(pageActivity(store.db, query({ q: '%' })).rows.map((r) => r.seq)).toEqual([pct]);
  });

  it('skips a row whose data does not parse, and the page after it continues', () => {
    const a = post({ type: 'app', id: APP_ENTITY_ID }, { key: 'a' });
    const bad = emitNotice('app', APP_ENTITY_ID, { nonsense: true });
    const c = post({ type: 'app', id: APP_ENTITY_ID }, { key: 'c' });
    const first = pageActivity(store.db, query({ pageSize: 1 }));
    expect(first.rows.map((r) => r.seq)).toEqual([c]);
    expect(first.next).not.toBeNull();
    const second = pageActivity(store.db, query({ pageSize: 1, after: first.next ?? undefined }));
    expect(second.rows.map((r) => r.seq)).toEqual([a]);
    expect(bad).toBeLessThan(c);
  });

  it('folds three within 10 minutes into one row of 3', () => {
    post({ type: 'app', id: APP_ENTITY_ID }, { key: 'same' }, 1);
    post({ type: 'app', id: APP_ENTITY_ID }, { key: 'same' }, 1);
    const last = post({ type: 'app', id: APP_ENTITY_ID }, { key: 'same' }, 1);
    const page = pageActivity(store.db, query());
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ seq: last, count: 3 });
  });
});

describe('hasNoticeKey', () => {
  it('is true for a key posted on the project, false for another project or a task entity', () => {
    const p1 = seedProject(store);
    const p2 = seedProject(store);
    const task = seedTask(p1.id);
    post({ type: 'project', id: p1.id }, { key: 'k', projectId: p1.id });
    post({ type: 'task', id: task }, { key: 't', projectId: p1.id, taskId: task });
    expect(hasNoticeKey(store.db, p1.id, 'k')).toBe(true);
    expect(hasNoticeKey(store.db, p2.id, 'k')).toBe(false);
    expect(hasNoticeKey(store.db, p1.id, 't')).toBe(false);
    expect(hasNoticeKey(store.db, mintId('Project'), 'k')).toBe(false);
  });
});
