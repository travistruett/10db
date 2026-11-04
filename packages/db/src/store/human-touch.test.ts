import {
  HUMAN_TOUCH_DAYS,
  InboxState,
  WORKSTREAM_FAILED_TITLE_PREFIX,
  WorkstreamState as S,
  type InboxKind,
  type InboxItemId,
  type ProjectId,
  type WorkstreamId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { humanTouchDays } from './human-touch';
import { insertInboxItem, updateInboxItem } from './inbox';
import { endSession, insertSession } from './sessions';
import type { Store } from './store';
import { insertTask } from './tasks';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream, transitionWorkstream } from './workstreams';

// A day's counts are the day's inbox rows by kind; waiting minutes are the time a card was open
// while the workstream it targeted waited on a person.

let store: Store;
let close: () => void;
let nowMs: number;
const at = (iso: string): void => {
  nowMs = Date.parse(iso);
};

beforeEach(() => {
  at('2026-10-20T09:00:00.000Z');
  ({ store, close } = createTestStore(() => new Date(nowMs)));
});
afterEach(() => {
  close();
});

function card(
  projectId: ProjectId,
  kind: InboxKind,
  title: string,
  workstreamId: WorkstreamId | null = null,
): InboxItemId {
  return store.write((ctx) =>
    insertInboxItem(ctx, {
      projectId,
      kind,
      title,
      body: '',
      options: [],
      recommendation: null,
      category: 'engineering',
      urgency: 'normal',
      detail: null,
      foldKey: null,
      targets: workstreamId ? [{ workstreamId, sessionId: null }] : [],
    }),
  ).value.id;
}

function answer(id: InboxItemId): void {
  store.write((ctx) =>
    updateInboxItem(ctx, id, { state: InboxState.Answered, answer: { choice: 'Allow' } }),
  );
}

function move(id: WorkstreamId, to: S): void {
  store.write((ctx) => transitionWorkstream(ctx, id, { to, fence: null }));
}

/** A task whose workstream is running, with a session started now. */
function startRun(projectId: ProjectId, title: string) {
  const task = store.write((ctx) =>
    insertTask(ctx, projectId, {
      title,
      description: '',
      acceptanceCriteria: ['x'],
      areas: ['api'],
    }),
  ).value;
  const ws = store.write((ctx) => insertWorkstream(ctx, task.id)).value;
  move(ws.id, S.Starting);
  move(ws.id, S.Running);
  const session = store.write((ctx) =>
    insertSession(ctx, {
      workstreamId: ws.id,
      provider: 'claude',
      model: 'sonnet',
      effort: 'medium',
      mode: 'managed',
      mcpTokenHash: `hash-${title}`,
    }),
  ).value;
  return { workstreamId: ws.id, sessionId: session.id };
}

describe('humanTouchDays', () => {
  it('counts the day by kind, divides by tasks that ran, and adds only the minutes work was blocked', () => {
    const project = seedProject(store);
    const other = seedProject(store, { name: 'other' });
    // Before the window and in another project: counted nowhere.
    card(project.id, 'question', 'Too old');
    at('2026-11-02T10:00:00.000Z');
    card(other.id, 'question', 'Someone else');

    // Task B runs across midnight and waits 20 minutes on a card raised 10 before it.
    at('2026-11-01T22:59:00.000Z');
    const b = startRun(project.id, 'B');
    at('2026-11-01T23:50:00.000Z');
    const bCard = card(project.id, 'question', 'Which?', b.workstreamId);
    move(b.workstreamId, S.WaitingHuman);
    at('2026-11-02T00:10:00.000Z');
    answer(bCard);
    at('2026-11-02T00:11:00.000Z');
    move(b.workstreamId, S.Running);
    at('2026-11-02T01:00:00.000Z');
    store.write((ctx) => {
      endSession(ctx, b.sessionId, 'done');
    });

    // Task A: a permission card blocks it for 20 minutes; a question answered while it ran adds none.
    at('2026-11-02T08:00:00.000Z');
    const a = startRun(project.id, 'A');
    at('2026-11-02T09:00:00.000Z');
    const aPermission = card(project.id, 'permission', 'Allow Bash?', a.workstreamId);
    move(a.workstreamId, S.WaitingHuman);
    at('2026-11-02T09:20:00.000Z');
    answer(aPermission);
    at('2026-11-02T09:21:00.000Z');
    move(a.workstreamId, S.Running);
    at('2026-11-02T10:00:00.000Z');
    const aQuestion = card(project.id, 'question', 'Lane question', a.workstreamId);
    at('2026-11-02T10:05:00.000Z');
    answer(aQuestion);
    at('2026-11-02T10:30:00.000Z');
    card(project.id, 'flag', `${WORKSTREAM_FAILED_TITLE_PREFIX}A`, a.workstreamId);
    card(project.id, 'flag', 'Stray file');
    card(project.id, 'proposal', 'Add a rule');
    at('2026-11-02T11:00:00.000Z');
    store.write((ctx) => {
      endSession(ctx, a.sessionId, 'done');
    });

    // Task C is still waiting on an open card an hour later.
    at('2026-11-03T10:00:00.000Z');
    const c = startRun(project.id, 'C');
    at('2026-11-03T11:00:00.000Z');
    card(project.id, 'permission', 'Allow Read?', c.workstreamId);
    move(c.workstreamId, S.WaitingHuman);

    at('2026-11-03T12:00:00.000Z');
    const days = humanTouchDays(store.db, project.id, new Date(nowMs));

    expect(days).toHaveLength(HUMAN_TOUCH_DAYS);
    expect(days[0]?.day).toBe('2026-11-03');
    expect(days.at(-1)?.day).toBe('2026-10-21');
    const by = (day: string) => days.find((d) => d.day === day);
    expect(by('2026-11-02')).toEqual({
      day: '2026-11-02',
      permission: 1,
      question: 1,
      workstreamFailed: 1,
      flag: 1,
      proposal: 1,
      review: 0,
      check: 0,
      cards: 5,
      tasksRan: 2,
      cardsPerTask: 2.5,
      waitingMinutes: 30,
    });
    expect(by('2026-11-01')).toMatchObject({
      question: 1,
      cards: 1,
      tasksRan: 1,
      cardsPerTask: 1,
      waitingMinutes: 10,
    });
    expect(by('2026-11-03')).toMatchObject({
      permission: 1,
      cards: 1,
      tasksRan: 1,
      waitingMinutes: 60,
    });
    expect(by('2026-10-25')).toMatchObject({
      cards: 0,
      tasksRan: 0,
      cardsPerTask: null,
      waitingMinutes: 0,
    });
  });
});
