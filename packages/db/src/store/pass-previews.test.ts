import {
  EventType,
  mintId,
  PassPreview,
  type PassId,
  type PassTurnId,
  type ProjectDto,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  countPreviewTurn,
  createTestStore,
  getPassPreview,
  insertInboxItem,
  insertPass,
  insertPassTurn,
  insertPreviewMark,
  insertTask,
  insertTaskPageReports,
  insertWorkstream,
  listOpenPreviewMarks,
  listTaskPageReports,
  mendPreviewMark,
  openPreviewMark,
  seedProject,
  setPassPreview,
  setPreviewMarkCard,
  type Store,
} from './index';

// Workbench spec §8.2, §10, §11: a broken preview is a mark on the page whose turn broke it, one open
// mark per page, mended once; the pass remembers how its last load went; the routes an agent reports
// for its pictures are rows of their turn and run.

let store: Store;
let close: () => void;
let project: ProjectDto;
let passId: PassId;
let taskId: TaskId;
let runId: WorkstreamId;
let turnId: PassTurnId;
let clock = new Date('2026-11-10T12:00:00.000Z');

beforeEach(() => {
  clock = new Date('2026-11-10T12:00:00.000Z');
  ({ store, close } = createTestStore(() => clock));
  project = seedProject(store, {
    areas: [{ name: 'people', globs: ['src/people/**'], role: 'page', route: '/people' }],
  });
  taskId = store.write((ctx) =>
    insertTask(ctx, project.id, { title: 'People', acceptanceCriteria: ['x'], areas: ['people'] }),
  ).value.id;
  const opened = store.write((ctx) =>
    insertPass(ctx, {
      id: mintId('Pass'),
      projectId: project.id,
      name: 'Polish',
      pageCap: 4,
      returnBranch: 'main',
      startSha: 'a'.repeat(40),
      branch: '10db/polish-abc123',
      baseBranch: 'main',
      repo: null,
      taskIds: [taskId],
      dirt: [],
    }),
  ).value;
  passId = opened.pass.id;
  runId = store.write((ctx) =>
    insertWorkstream(ctx, taskId, {
      batchId: opened.batch.id,
      first: { model: 'claude-sonnet-5-5', effort: 'medium' },
    }),
  ).value.id;
  turnId = store.write((ctx) =>
    insertPassTurn(ctx, { taskId, workstreamId: runId, sessionId: null, messageId: null }),
  ).value.id;
});
afterEach(() => {
  close();
});

const mark = () =>
  store.write((ctx) =>
    insertPreviewMark(ctx, { passId, taskId, turnId, route: '/people', overlay: 'Syntax error' }),
  );

describe("a pass's preview", () => {
  it('is null until a load is judged, and each change appends one pass.changed', () => {
    expect(getPassPreview(store.db, passId)).toBeNull();
    const set = store.write((ctx) => {
      setPassPreview(ctx, passId, PassPreview.Broken);
    });
    expect(getPassPreview(store.db, passId)).toBe(PassPreview.Broken);
    expect(set.events.map((e) => [e.type, e.data['preview']])).toEqual([
      [EventType.PassChanged, 'broken'],
    ]);
    const same = store.write((ctx) => {
      setPassPreview(ctx, passId, PassPreview.Broken);
    });
    expect(same.events).toEqual([]);
  });
});

describe("a page's preview mark", () => {
  it('opens one mark per pass and page, saying so with pass.preview_broken', () => {
    const { value, events } = mark();
    expect(value).toMatchObject({ taskId, turnId, route: '/people', turns: 1, mendedAt: null });
    expect(events.map((e) => [e.type, e.entityId, e.data])).toEqual([
      [EventType.PassPreviewBroken, passId, { passId, taskId, route: '/people' }],
    ]);
    expect(openPreviewMark(store.db, passId, taskId)?.id).toBe(value.id);
    expect(() => mark()).toThrow();
    expect(listOpenPreviewMarks(store.db, passId)).toHaveLength(1);
  });

  it('counts its turns and keeps the card it raised', () => {
    const opened = mark().value;
    store.write((ctx) => countPreviewTurn(ctx, opened.id));
    const card = store.write((ctx) =>
      insertInboxItem(ctx, {
        projectId: project.id,
        kind: 'flag',
        title: 'Move?',
        body: 'Move.',
        options: [],
        recommendation: null,
        category: 'product',
        urgency: 'normal',
        detail: null,
        foldKey: null,
        targets: [],
      }),
    ).value;
    expect(store.write((ctx) => setPreviewMarkCard(ctx, opened.id, card.id)).value).toBe(true);
    expect(store.write((ctx) => setPreviewMarkCard(ctx, opened.id, card.id)).value).toBe(false);
    expect(openPreviewMark(store.db, passId, taskId)).toMatchObject({ turns: 2, cardId: card.id });
  });

  it('mends once, with pass.preview_mended, and the page may then break it again', () => {
    const opened = mark().value;
    clock = new Date('2026-11-10T12:07:00.000Z');
    const mended = store.write((ctx) => mendPreviewMark(ctx, opened.id));
    expect(mended.value).toMatchObject({ mendedAt: '2026-11-10T12:07:00.000Z' });
    expect(mended.events.map((e) => [e.type, e.data])).toEqual([
      [EventType.PassPreviewMended, { passId, taskId }],
    ]);
    const again = store.write((ctx) => mendPreviewMark(ctx, opened.id));
    expect(again.value).toBeNull();
    expect(again.events).toEqual([]);
    expect(openPreviewMark(store.db, passId, taskId)).toBeUndefined();
    expect(mark().value.id).not.toBe(opened.id);
  });
});

describe('the routes an agent reports', () => {
  it("keeps each route with its turn and run, and reads a turn's or a run's back", () => {
    store.write((ctx) => {
      insertTaskPageReports(ctx, { taskId, workstreamId: runId, turnId, routes: ['/people/42'] });
    });
    store.write((ctx) => {
      insertTaskPageReports(ctx, { taskId, workstreamId: runId, turnId: null, routes: ['/x'] });
    });
    expect(listTaskPageReports(store.db, { taskId, turnId }).map((r) => r.route)).toEqual([
      '/people/42',
    ]);
    expect(
      listTaskPageReports(store.db, { taskId, workstreamId: runId }).map((r) => r.route),
    ).toEqual(['/people/42', '/x']);
  });
});
