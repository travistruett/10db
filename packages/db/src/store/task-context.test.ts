import {
  AnchorResult,
  EventType,
  ShapeOrigin,
  type ShapeAttachmentRevisionId,
  type ShapeId,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestStore,
  getTaskContext,
  insertAnchorChecks,
  insertAttachmentRevision,
  insertDocumentAttachment,
  insertShape,
  insertTask,
  insertWorkstream,
  latestAnchorChecksOfTask,
  listAnchorChecks,
  markTaskContextPacked,
  seedProject,
  transitionWorkstream,
  upsertTaskContext,
  type Store,
} from './index';

let store: Store;
let close: () => void;
let shapeId: ShapeId;
let revisionId: ShapeAttachmentRevisionId;
let taskId: TaskId;
let workstreamId: WorkstreamId;
beforeEach(() => {
  ({ store, close } = createTestStore(() => new Date(2026, 10, 12, 8, 0)));
  const project = seedProject(store, { name: 'alpha' });
  shapeId = store.write((ctx) =>
    insertShape(ctx, project.id, { title: 'Remote host', origin: ShapeOrigin.ClaudeCode }),
  ).value.id;
  revisionId = store.write((ctx) => {
    const doc = insertDocumentAttachment(ctx, {
      shapeId,
      kind: 'plan',
      key: 'p1',
      docKey: 'p1',
      title: 'P1',
      body: '',
    });
    return insertAttachmentRevision(ctx, {
      attachmentId: doc.id,
      body: '## Task 1: One\n',
      sha256: 'a',
      sections: [],
      note: null,
      author: null,
      bundleNumber: 1,
      authoredAt: null,
    }).row.id;
  }).value;
  taskId = store.write((ctx) =>
    insertTask(ctx, project.id, {
      title: 'One',
      description: '',
      acceptanceCriteria: ['x'],
      areas: ['api'],
    }),
  ).value.id;
  workstreamId = newWorkstream();
});
afterEach(() => {
  close();
});

function newWorkstream(): WorkstreamId {
  return store.write((ctx) =>
    insertWorkstream(ctx, taskId, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
  ).value.id;
}

const pin = (section: string, cites: string[]) =>
  store.write((ctx) => {
    upsertTaskContext(ctx, { taskId, shapeId, revisionId, section, shared: ['calls'], cites });
  });

const check = (ws: WorkstreamId, commit: string, result: AnchorResult, line: number | null) => ({
  workstreamId: ws,
  entryKey: 'f-runner-packs',
  entryVersion: 1,
  anchorIndex: 0,
  result,
  line,
  checkedCommit: commit,
  note: null,
});

describe('task context', () => {
  it('a task’s context reads back', () => {
    pin('task-1', ['f-runner-packs']);
    expect(getTaskContext(store.db, taskId)).toMatchObject({
      taskId,
      shapeId,
      revisionId,
      section: 'task-1',
      shared: ['calls'],
      cites: ['f-runner-packs'],
      packedText: null,
    });
  });

  it('upsert replaces section and cites and keeps the packed text', () => {
    pin('task-1', ['a']);
    store.write((ctx) => {
      markTaskContextPacked(ctx, taskId, { text: 'Plan context', workstreamId });
    });
    pin('task-2', ['b']);
    expect(getTaskContext(store.db, taskId)).toMatchObject({
      section: 'task-2',
      cites: ['b'],
      packedText: 'Plan context',
      packedWorkstreamId: workstreamId,
    });
  });

  it('the packed text reads back byte for byte', () => {
    pin('task-1', []);
    const text = 'Plan context:\r\n﻿## Task 1  \n› trailing\n\n';
    store.write((ctx) => {
      markTaskContextPacked(ctx, taskId, { text, workstreamId });
    });
    const read = getTaskContext(store.db, taskId)?.packedText ?? '';
    expect(Buffer.from(read, 'utf8').equals(Buffer.from(text, 'utf8'))).toBe(true);
  });
});

describe('anchor checks', () => {
  it('checks are listed per workstream and base commit', () => {
    const wrote = store.write((ctx) => {
      insertAnchorChecks(ctx, taskId, [check(workstreamId, 'aaaaaaa', AnchorResult.Moved, 21)]);
    });
    expect(wrote.events.map((e) => [e.type, e.entityType, e.entityId])).toEqual([
      [EventType.PlanAnchorChecked, 'task', taskId],
    ]);
    expect(wrote.events[0]?.data).toEqual({ workstreamId, counts: { moved: 1 } });
    store.write((ctx) => {
      insertAnchorChecks(ctx, taskId, [check(workstreamId, 'aaaaaaa', AnchorResult.Current, 18)]);
    });
    expect(listAnchorChecks(store.db, workstreamId, 'aaaaaaa')).toMatchObject([
      { entryKey: 'f-runner-packs', result: 'current', line: 18 },
    ]);
  });

  it('a check at another base is not listed', () => {
    store.write((ctx) => {
      insertAnchorChecks(ctx, taskId, [check(workstreamId, 'aaaaaaa', AnchorResult.Current, 18)]);
    });
    expect(listAnchorChecks(store.db, workstreamId, 'bbbbbbb')).toEqual([]);
    store.write((ctx) => transitionWorkstream(ctx, workstreamId, { to: 'STARTING', fence: null }));
    store.write((ctx) => transitionWorkstream(ctx, workstreamId, { to: 'FAILED', fence: null }));
    const later = newWorkstream();
    expect(listAnchorChecks(store.db, later, 'aaaaaaa')).toEqual([]);
    store.write((ctx) => {
      insertAnchorChecks(ctx, taskId, [check(later, 'bbbbbbb', AnchorResult.Changed, null)]);
    });
    expect(latestAnchorChecksOfTask(store.db, taskId)).toMatchObject([
      { workstreamId: later, checkedCommit: 'bbbbbbb', result: 'changed' },
    ]);
  });

  it('no rows write no event', () => {
    expect(
      store.write((ctx) => {
        insertAnchorChecks(ctx, taskId, []);
      }).events,
    ).toEqual([]);
  });
});
