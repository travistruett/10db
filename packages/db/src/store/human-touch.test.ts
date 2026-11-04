import {
  BatchState as B,
  HUMAN_TOUCH_DAYS,
  InboxState,
  WORKSTREAM_FAILED_TITLE_PREFIX,
  WorkstreamState as S,
  type BatchId,
  type InboxKind,
  type InboxItemId,
  type ProjectId,
  type WorkstreamId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertBatch, transitionBatch } from './batches';
import { humanTouchDays } from './human-touch';
import { insertInboxItem, updateInboxItem } from './inbox';
import { endSession, insertSession } from './sessions';
import type { Store } from './store';
import { closeTask, insertTask } from './tasks';
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
function startRun(projectId: ProjectId, title: string, batchId: BatchId | null = null) {
  const task = store.write((ctx) =>
    insertTask(ctx, projectId, {
      title,
      description: '',
      acceptanceCriteria: ['x'],
      areas: ['api'],
    }),
  ).value;
  const ws = store.write((ctx) => insertWorkstream(ctx, task.id, { batchId })).value;
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
  return { taskId: task.id, workstreamId: ws.id, sessionId: session.id };
}

/** A run that failed at 01:00 today with its failure card open, the clock left there. */
function failAtOne(projectId: ProjectId, batchId: BatchId | null = null) {
  at('2026-11-03T00:30:00.000Z');
  const run = startRun(projectId, 'failed', batchId);
  at('2026-11-03T01:00:00.000Z');
  move(run.workstreamId, S.Failed);
  const failure = card(
    projectId,
    'flag',
    `${WORKSTREAM_FAILED_TITLE_PREFIX}failed`,
    run.workstreamId,
  );
  return { ...run, failure };
}

function failedMinutesAtNoon(projectId: ProjectId): number | undefined {
  at('2026-11-03T12:00:00.000Z');
  return humanTouchDays(store.db, projectId, new Date(nowMs))[0]?.failedMinutes;
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
      failedMinutes: 0,
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

  it('counts the time a failure card sat open on a FAILED workstream apart from waitingMinutes', () => {
    const project = seedProject(store);

    // Fails at 22:00 on Nov 1 and is retried at 08:00 on Nov 2: 2 h on Nov 1, 8 h on Nov 2.
    at('2026-11-01T21:00:00.000Z');
    const overnight = startRun(project.id, 'overnight');
    at('2026-11-01T22:00:00.000Z');
    move(overnight.workstreamId, S.Failed);
    const failure = card(
      project.id,
      'flag',
      `${WORKSTREAM_FAILED_TITLE_PREFIX}overnight`,
      overnight.workstreamId,
    );
    at('2026-11-02T08:00:00.000Z');
    answer(failure);
    move(overnight.workstreamId, S.Queued);

    // Another card kind open on a FAILED workstream is not a failure card: it adds nothing.
    at('2026-11-02T09:00:00.000Z');
    const other = startRun(project.id, 'other');
    at('2026-11-02T09:10:00.000Z');
    move(other.workstreamId, S.Failed);
    const question = card(project.id, 'question', 'Which?', other.workstreamId);
    at('2026-11-02T09:40:00.000Z');
    answer(question);

    // Still failed with its card open: runs to now.
    at('2026-11-03T01:00:00.000Z');
    const still = startRun(project.id, 'still');
    move(still.workstreamId, S.Failed);
    card(project.id, 'flag', `${WORKSTREAM_FAILED_TITLE_PREFIX}still`, still.workstreamId);

    at('2026-11-03T03:30:00.000Z');
    const days = humanTouchDays(store.db, project.id, new Date(nowMs));
    const by = (day: string) => days.find((d) => d.day === day);

    expect(by('2026-11-01')).toMatchObject({ failedMinutes: 120, waitingMinutes: 0 });
    expect(by('2026-11-02')).toMatchObject({ failedMinutes: 480, waitingMinutes: 0 });
    expect(by('2026-11-03')).toMatchObject({ failedMinutes: 150, waitingMinutes: 0 });
    expect(by('2026-10-25')).toMatchObject({ failedMinutes: 0 });
  });

  it('stops counting a failed run when its task is closed, though the card stays open', () => {
    const project = seedProject(store);
    const run = failAtOne(project.id);

    at('2026-11-03T01:05:00.000Z');
    store.write((ctx) => closeTask(ctx, run.taskId));

    expect(failedMinutesAtNoon(project.id)).toBe(5);
  });

  it.each([
    ['abandoned', [B.Abandoned]],
    ['shipped without it', [B.Shipping, B.Shipped]],
  ] as const)('stops counting a failed run when its batch is %s', (_name, states) => {
    const project = seedProject(store);
    const batch = store.write((ctx) =>
      insertBatch(ctx, { projectId: project.id, title: 'B', baseBranch: 'main' }),
    ).value;
    store.write((ctx) => transitionBatch(ctx, batch.id, { to: B.Open }));
    failAtOne(project.id, batch.id);

    at('2026-11-03T01:05:00.000Z');
    for (const to of states) store.write((ctx) => transitionBatch(ctx, batch.id, { to }));

    expect(failedMinutesAtNoon(project.id)).toBe(5);
  });

  it('keeps counting a failed run while its batch can still retry it', () => {
    const project = seedProject(store);
    const batch = store.write((ctx) =>
      insertBatch(ctx, { projectId: project.id, title: 'B', baseBranch: 'main' }),
    ).value;
    store.write((ctx) => transitionBatch(ctx, batch.id, { to: B.Open }));
    failAtOne(project.id, batch.id);

    at('2026-11-03T01:05:00.000Z');
    store.write((ctx) => transitionBatch(ctx, batch.id, { to: B.Failed }));

    expect(failedMinutesAtNoon(project.id)).toBe(660);
  });

  it('reads the event log through an index, never a full scan', () => {
    const project = seedProject(store);
    const batch = store.write((ctx) =>
      insertBatch(ctx, { projectId: project.id, title: 'B', baseBranch: 'main' }),
    ).value;
    store.write((ctx) => transitionBatch(ctx, batch.id, { to: B.Open }));
    failAtOne(project.id, batch.id);
    at('2026-11-03T12:00:00.000Z');

    const client = store.db.$client;
    const prepare = client.prepare.bind(client);
    const eventQueries: string[] = [];
    const spy = vi.spyOn(client, 'prepare').mockImplementation((sql: string) => {
      if (/from "events"/i.test(sql)) eventQueries.push(sql);
      return prepare(sql);
    });
    humanTouchDays(store.db, project.id, new Date(nowMs));
    spy.mockRestore();

    // Card close, workstream state and task/batch end, the first two once for waiting and once for failed.
    expect(eventQueries.length).toBeGreaterThanOrEqual(5);
    for (const sql of eventQueries) {
      const placeholders = Array.from({ length: sql.split('?').length - 1 }, () => 'x');
      const plan = client
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...placeholders)
        .map((row) => (row as { detail: string }).detail);
      const events = plan.filter((detail) => /\bevents\b/.test(detail));
      expect(events.length).toBeGreaterThan(0);
      for (const detail of events) {
        expect(detail).toContain('USING INDEX events_entity_idx');
        expect(detail).not.toMatch(/^SCAN/);
      }
    }
  });
});
