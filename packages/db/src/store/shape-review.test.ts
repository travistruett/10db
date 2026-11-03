import {
  ConflictError,
  EventType,
  InboxKind,
  ShapeFindingKind,
  ShapeFindingSeverity,
  ShapeFindingState,
  ShapeOrigin,
  ShapeProposalKind,
  ShapeProposalState,
  ShapeReviewer,
  type ProjectDto,
  type ShapeId,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestStore,
  getOneWayPaths,
  getShapeFinding,
  insertInboxItem,
  insertShape,
  insertShapeFinding,
  insertShapeLink,
  insertShapeProposal,
  insertTask,
  insertWorkstream,
  linkShapeAttachments,
  listRehearsals,
  listShapeAttachments,
  listShapeFindings,
  questionCardRates,
  recordRehearsal,
  seedProject,
  setOneWayPaths,
  settleOpenQuestionsOfTask,
  settleShapeFinding,
  upsertShapeAttachment,
  type Store,
} from './index';

// Shape spec docs/superpowers/specs/2026-11-02-10db-brainstorm-chat-design.md §7, §13.

let store: Store;
let close: () => void;
let project: ProjectDto;
let shapeId: ShapeId;
beforeEach(() => {
  ({ store, close } = createTestStore(() => new Date(2026, 10, 2, 12, 0)));
  project = seedProject(store, { name: 'alpha' });
  shapeId = store.write((ctx) =>
    insertShape(ctx, project.id, { title: 'Density', origin: ShapeOrigin.App }),
  ).value.id;
});
afterEach(() => {
  close();
});

const report = (over: Partial<Parameters<typeof insertShapeFinding>[1]> = {}) =>
  store.write((ctx) =>
    insertShapeFinding(ctx, {
      shapeId,
      effortKey: 'density',
      taskKey: null,
      reviewer: ShapeReviewer.Scope,
      kind: ShapeFindingKind.Finding,
      severity: ShapeFindingSeverity.High,
      text: 'No migration is named',
      round: 1,
      taskHash: null,
      ...over,
    }),
  );

const question = (taskKey: string, taskHash: string) =>
  report({
    reviewer: ShapeReviewer.Rehearsal,
    kind: ShapeFindingKind.Question,
    severity: null,
    taskKey,
    taskHash,
  }).value;

describe('findings', () => {
  it('are open, in the order they were reported, and the screen is told', () => {
    const a = report();
    const b = report({ text: 'Names no owner' });
    expect(listShapeFindings(store.db, shapeId).map((f) => f.id)).toEqual([a.value.id, b.value.id]);
    expect(a.value.state).toBe(ShapeFindingState.Open);
    expect(a.events.map((e) => e.type)).toContain(EventType.ShapeChanged);
  });

  it('settle once: resolved or dismissed with a one-line how, never twice', () => {
    const { id } = report().value;
    store.write((ctx) => settleShapeFinding(ctx, id, ShapeFindingState.Dismissed, 'not needed'));
    expect(getShapeFinding(store.db, id)).toMatchObject({ state: 'dismissed', how: 'not needed' });
    expect(() =>
      store.write((ctx) => settleShapeFinding(ctx, id, ShapeFindingState.Resolved, 'split it')),
    ).toThrow(ConflictError);
  });

  it('an edit to a task settles its open rehearsal questions and leaves the rest', () => {
    const asked = question('cards', 'h1');
    const elsewhere = question('rows', 'h2');
    const finding = report({ taskKey: 'cards' }).value;
    const { value: n } = store.write((ctx) =>
      settleOpenQuestionsOfTask(ctx, shapeId, 'cards', 'answered by your edit'),
    );
    expect(n).toBe(1);
    expect(getShapeFinding(store.db, asked.id)).toMatchObject({
      state: 'resolved',
      how: 'answered by your edit',
    });
    expect(getShapeFinding(store.db, elsewhere.id).state).toBe('open');
    expect(getShapeFinding(store.db, finding.id).state).toBe('open');
  });
});

describe('rehearsal marks', () => {
  it('are one per task and hash, zero questions included; a second write replaces the count', () => {
    const mark = (taskKey: string, hash: string, round: number, questions: number) =>
      store.write((ctx) => {
        recordRehearsal(ctx, { shapeId, taskKey, hash, round, questions });
      });
    mark('cards', 'h1', 1, 0);
    mark('cards', 'h1', 1, 2);
    mark('cards', 'h2', 2, 0);
    expect(listRehearsals(store.db, shapeId).map((r) => [r.taskKey, r.hash, r.questions])).toEqual([
      ['cards', 'h1', 2],
      ['cards', 'h2', 0],
    ]);
  });
});

describe('a spec', () => {
  it('is one per effort: a second write replaces it, and Convert links it to what it made', () => {
    const write = (body: string) =>
      store.write((ctx) => {
        upsertShapeAttachment(ctx, { shapeId, kind: 'spec', key: 'density', body });
      });
    write('# v1');
    write('# v2');
    expect(listShapeAttachments(store.db, shapeId).map((a) => a.body)).toEqual(['# v2']);
    const task = store.write((ctx) => insertTask(ctx, project.id, taskInput('Cards'))).value;
    store.write((ctx) => {
      linkShapeAttachments(ctx, shapeId, 'density', { taskId: task.id });
    });
    expect(listShapeAttachments(store.db, shapeId)[0]?.taskId).toBe(task.id);
  });
});

describe('one-way paths', () => {
  it('are unset until the builder sets them, per project', () => {
    expect(getOneWayPaths(store.db, project.id)).toBeNull();
    store.write((ctx) => {
      setOneWayPaths(ctx, project.id, ['db/**']);
    });
    expect(getOneWayPaths(store.db, project.id)).toEqual(['db/**']);
  });
});

function taskInput(title: string) {
  return { title, description: '', acceptanceCriteria: ['x'], areas: ['api'] };
}

describe('question cards per task', () => {
  const proposal = (key: string) =>
    store.write((ctx) =>
      insertShapeProposal(ctx, {
        shapeId,
        key,
        kind: ShapeProposalKind.Task,
        state: ShapeProposalState.Accepted,
        round: 1,
        createdRound: 1,
        pinned: [],
        body: {},
        taskHashes: {},
        sourceMessageIds: [],
      }),
    ).value;
  function convertedAndStarted(title: string): WorkstreamId {
    const task = store.write((ctx) => insertTask(ctx, project.id, taskInput(title))).value;
    const row = proposal(title);
    store.write((ctx) =>
      insertShapeLink(ctx, { shapeId, proposalId: row.id, key: title, taskId: task.id }),
    );
    return store.write((ctx) => insertWorkstream(ctx, task.id)).value.id;
  }
  function startedAlone(title: string): { taskId: TaskId; workstreamId: WorkstreamId } {
    const task = store.write((ctx) => insertTask(ctx, project.id, taskInput(title))).value;
    return {
      taskId: task.id,
      workstreamId: store.write((ctx) => insertWorkstream(ctx, task.id)).value.id,
    };
  }
  function ask(workstreamId: WorkstreamId, kind: InboxKind = InboxKind.Question) {
    store.write((ctx) =>
      insertInboxItem(ctx, {
        projectId: project.id,
        kind,
        title: 'Which one?',
        body: '',
        options: [],
        recommendation: null,
        category: 'product',
        urgency: 'normal',
        detail: null,
        foldKey: null,
        targets: [{ workstreamId, sessionId: null }],
      }),
    );
  }

  it('counts question cards on converted tasks against the same projects’ other started tasks', () => {
    const a = convertedAndStarted('a');
    convertedAndStarted('b');
    ask(a);
    ask(a);
    const plain = startedAlone('plain');
    ask(plain.workstreamId);
    ask(plain.workstreamId, InboxKind.Permission);
    store.write((ctx) => insertTask(ctx, project.id, taskInput('never started')));
    expect(questionCardRates(store.db)).toEqual({
      converted: { tasks: 2, cards: 2 },
      other: { tasks: 1, cards: 1 },
    });
  });

  it('is empty when no conversation has converted a task', () => {
    startedAlone('plain');
    expect(questionCardRates(store.db)).toEqual({
      converted: { tasks: 0, cards: 0 },
      other: { tasks: 0, cards: 0 },
    });
  });
});
