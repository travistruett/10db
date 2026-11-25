import {
  EventType,
  InboxKind,
  QuestionCategory,
  TaskStatus,
  Urgency,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acceptanceFigures } from './acceptance-figures';
import { insertInboxItem } from './inbox';
import type { Store } from './store';
import { insertTask, setTaskStatus } from './tasks';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream } from './workstreams';

const NOW = new Date('2026-11-25T12:00:00.000Z');
const IN = '2026-11-23T12:00:00.000Z';
const OUT = '2026-11-01T12:00:00.000Z';

let store: Store;
let close: () => void;
let at: Date;
beforeEach(() => {
  at = NOW;
  ({ store, close } = createTestStore(() => at));
});
afterEach(() => {
  close();
});

function seedRun(projectId: ReturnType<typeof seedProject>['id']) {
  const task = store.write((ctx) =>
    insertTask(ctx, projectId, { title: 'T', acceptanceCriteria: ['x'], areas: ['api'] }),
  ).value;
  const ws = store.write((ctx) =>
    insertWorkstream(ctx, task.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
  ).value;
  return { task, ws };
}

function finishAt(taskId: TaskId, when: string) {
  at = new Date(when);
  store.write((ctx) => {
    setTaskStatus(ctx, taskId, TaskStatus.Done);
  });
}

function sendBackAt(workstreamId: WorkstreamId, when: string, by: string) {
  at = new Date(when);
  store.write((ctx) => {
    ctx.emit({
      type: EventType.StepChanged,
      entityType: 'workstream',
      entityId: workstreamId,
      data: { stepIndex: 0, role: 'implementer', sentBackBy: by },
    });
  });
}

function cardAt(projectId: ReturnType<typeof seedProject>['id'], ws: WorkstreamId, when: string) {
  at = new Date(when);
  store.write((ctx) =>
    insertInboxItem(ctx, {
      projectId,
      kind: InboxKind.Acceptance,
      title: 'c',
      body: 'c',
      options: [],
      recommendation: null,
      category: QuestionCategory.Engineering,
      urgency: Urgency.Normal,
      detail: null,
      foldKey: null,
      targets: [{ workstreamId: ws, sessionId: null }],
    }),
  );
}

describe('acceptanceFigures', () => {
  it('counts each figure inside the window and leaves out a carded task, a builder send-back and old rows', () => {
    const project = seedProject(store);
    const clean = seedRun(project.id);
    const carded = seedRun(project.id);
    const old = seedRun(project.id);
    finishAt(clean.task.id, IN);
    finishAt(carded.task.id, IN);
    finishAt(old.task.id, OUT);
    cardAt(project.id, carded.ws.id, IN);
    cardAt(project.id, old.ws.id, OUT);
    sendBackAt(clean.ws.id, IN, 'acceptance');
    sendBackAt(clean.ws.id, IN, 'builder');
    sendBackAt(clean.ws.id, OUT, 'review');
    // Another project's rows are not counted.
    const other = seedProject(store, { name: 'other', repoPath: '/tmp/other-acceptance' });
    const theirs = seedRun(other.id);
    finishAt(theirs.task.id, IN);
    sendBackAt(theirs.ws.id, IN, 'review');
    cardAt(other.id, theirs.ws.id, IN);

    expect(acceptanceFigures(store.db, project.id, 7, NOW)).toEqual({
      completed: 1,
      sentBack: 1,
      sentToYou: 1,
    });
  });
});
