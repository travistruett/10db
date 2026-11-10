import {
  AbandonStep,
  EventType,
  mintId,
  PassTurnEnding,
  WorkstreamState,
  TaskMessageAuthor,
  TaskMessageKind,
  type PassDto,
  type ProjectDto,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestStore,
  endPassTurn,
  getTaskMessageRow,
  insertBuilderMessage,
  insertPass,
  insertPassTurn,
  insertTask,
  insertWorkstream,
  latestPassTurn,
  listPassTurns,
  listTaskThreadRows,
  listTurnsEndedUnsettled,
  markPassTurnAnswered,
  openPassTurn,
  seedProject,
  abandonPassAndBatch,
  leavePass,
  setAbandonStep,
  setPassTurnKept,
  settlePassTurn,
  settleTurnsLeaving,
  transitionWorkstream,
  type Store,
} from './index';

// Workbench spec §6.2, §11, §12: a pass task's turns are rows, so a turn that ended before the daemon
// stopped is finished at start-up by how it ended.

let store: Store;
let close: () => void;
let project: ProjectDto;
let pass: PassDto;
let taskId: TaskId;
let workstreamId: WorkstreamId;
let clock = new Date('2026-11-09T12:00:00.000Z');

beforeEach(() => {
  clock = new Date('2026-11-09T12:00:00.000Z');
  ({ store, close } = createTestStore(() => clock));
  project = seedProject(store, {
    delivery: 'local',
    areas: [{ name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' }],
  });
  taskId = store.write((ctx) =>
    insertTask(ctx, project.id, {
      title: 'Settings',
      acceptanceCriteria: ['x'],
      areas: ['settings'],
    }),
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
  pass = opened.pass;
  workstreamId = store.write((ctx) =>
    insertWorkstream(ctx, taskId, {
      batchId: opened.batch.id,
      first: { model: 'claude-sonnet-5-5', effort: 'medium' },
    }),
  ).value.id;
});
afterEach(() => {
  close();
});

const later = (minutes: number): void => {
  clock = new Date(clock.getTime() + minutes * 60_000);
};

function startTurn() {
  return store.write((ctx) => {
    const message = insertBuilderMessage(ctx, taskId, { body: 'make it blue', files: [] });
    return insertPassTurn(ctx, { taskId, workstreamId, sessionId: null, messageId: message.id });
  });
}

describe("a pass task's turns", () => {
  it('ends a turn and writes its reply in one write, keeps its work, and settles it: a restart between finds it', () => {
    const { value: turn, events: started } = startTurn();
    expect(turn).toMatchObject({ seq: 1, endedAt: null, ending: null, settledAt: null });
    expect(started.map((e) => e.type)).toContain(EventType.PassTurnStarted);
    // The message that started the turn names it.
    expect(getTaskMessageRow(store.db, turn.messageId ?? mintId('TaskMessage')).turnId).toBe(
      turn.id,
    );
    expect(openPassTurn(store.db, taskId)?.id).toBe(turn.id);
    expect(listTurnsEndedUnsettled(store.db)).toEqual([]);

    later(3);
    const { events: ended } = store.write((ctx) =>
      endPassTurn(ctx, turn.id, { ending: PassTurnEnding.Ready, replyBody: 'Made it blue.' }),
    );
    expect(ended.map((e) => e.type)).toEqual(
      expect.arrayContaining([EventType.TaskMessageAdded, EventType.PassTurnEnded]),
    );
    const reply = listTaskThreadRows(store.db, taskId).at(-1);
    expect(reply).toMatchObject({
      author: TaskMessageAuthor.Agent,
      kind: TaskMessageKind.Reply,
      body: 'Made it blue.',
      turnId: turn.id,
    });
    expect(openPassTurn(store.db, taskId)).toBeUndefined();
    // Between the end and the settle, a restart finds the turn by its rows, with how it ended.
    expect(listTurnsEndedUnsettled(store.db)).toEqual([
      expect.objectContaining({
        id: turn.id,
        ending: PassTurnEnding.Ready,
        endedAt: clock.toISOString(),
        keptBaseSha: null,
      }),
    ]);

    store.write((ctx) => {
      setPassTurnKept(ctx, turn.id, {
        keptSha: 'b'.repeat(40),
        keptBaseSha: 'a'.repeat(40),
        sharedSeq: null,
      });
    });
    expect(listTurnsEndedUnsettled(store.db)[0]).toMatchObject({
      keptSha: 'b'.repeat(40),
      keptBaseSha: 'a'.repeat(40),
    });

    later(1);
    const { events: settled } = store.write((ctx) => settlePassTurn(ctx, turn.id));
    expect(settled.map((e) => e.type)).toContain(EventType.PassPageReady);
    expect(listTurnsEndedUnsettled(store.db)).toEqual([]);
    expect(latestPassTurn(store.db, taskId)).toMatchObject({
      id: turn.id,
      settledAt: clock.toISOString(),
      readyAt: clock.toISOString(),
    });
  });

  it.each([
    { ending: PassTurnEnding.Stopped, replyBody: null },
    { ending: PassTurnEnding.Failed, replyBody: '' },
  ])('settles a $ending turn with no Ready and no reply row', ({ ending, replyBody }) => {
    const turn = startTurn().value;
    const before = listTaskThreadRows(store.db, taskId).length;
    store.write((ctx) => endPassTurn(ctx, turn.id, { ending, replyBody }));
    const { events } = store.write((ctx) => settlePassTurn(ctx, turn.id));
    expect(listTaskThreadRows(store.db, taskId)).toHaveLength(before);
    expect(events.map((e) => e.type)).not.toContain(EventType.PassPageReady);
    expect(latestPassTurn(store.db, taskId)).toMatchObject({ ending, readyAt: null });
  });

  it('refuses a second end, a settle before the end, and a second open turn, changing nothing', () => {
    const turn = startTurn().value;
    expect(() => store.write((ctx) => settlePassTurn(ctx, turn.id))).toThrow(/has not ended/);
    expect(() => startTurn()).toThrow();
    store.write((ctx) =>
      endPassTurn(ctx, turn.id, { ending: PassTurnEnding.Ready, replyBody: 'done' }),
    );
    const thread = listTaskThreadRows(store.db, taskId).length;
    expect(() =>
      store.write((ctx) =>
        endPassTurn(ctx, turn.id, { ending: PassTurnEnding.Stopped, replyBody: 'again' }),
      ),
    ).toThrow(/already ended/);
    expect(listTaskThreadRows(store.db, taskId)).toHaveLength(thread);
    expect(latestPassTurn(store.db, taskId)?.ending).toBe(PassTurnEnding.Ready);
  });

  it("numbers a task's turns, lists every turn of the pass, and marks the first answer once", () => {
    const first = startTurn().value;
    store.write((ctx) =>
      endPassTurn(ctx, first.id, { ending: PassTurnEnding.Ready, replyBody: 'done' }),
    );
    store.write((ctx) => settlePassTurn(ctx, first.id));
    later(2);
    store.write((ctx) => {
      markPassTurnAnswered(ctx, first.id);
    });
    const answeredAt = clock.toISOString();
    later(2);
    store.write((ctx) => {
      markPassTurnAnswered(ctx, first.id);
    });
    const second = startTurn().value;
    expect(second.seq).toBe(2);
    expect(listPassTurns(store.db, pass.id).map((t) => [t.seq, t.answeredAt])).toEqual([
      [1, answeredAt],
      [2, null],
    ]);
    expect(latestPassTurn(store.db, taskId)?.id).toBe(second.id);
  });

  it("ends a task's open turn as stopped and settles every turn as it leaves its pass, none Ready", () => {
    const ended = startTurn().value;
    store.write((ctx) =>
      endPassTurn(ctx, ended.id, { ending: PassTurnEnding.Ready, replyBody: 'done' }),
    );
    const open = startTurn().value;
    later(1);

    const { events } = store.write((ctx) => {
      settleTurnsLeaving(ctx, taskId);
    });

    expect(listTurnsEndedUnsettled(store.db)).toEqual([]);
    expect(
      listPassTurns(store.db, pass.id).map((t) => [t.id, t.ending, t.settledAt, t.readyAt]),
    ).toEqual([
      [ended.id, PassTurnEnding.Ready, clock.toISOString(), null],
      [open.id, PassTurnEnding.Stopped, clock.toISOString(), null],
    ]);
    expect(events.map((e) => e.type)).not.toContain(EventType.PassPageReady);
  });

  it("reads the latest turn of the task's current run only, never an earlier run's", () => {
    // A turn of the task's run in a pass it has since left, ended and never carried through.
    const earlier = startTurn().value;
    store.write((ctx) => {
      endPassTurn(ctx, earlier.id, { ending: PassTurnEnding.Ready, replyBody: null });
      transitionWorkstream(ctx, workstreamId, { to: WorkstreamState.Cancelled, fence: null });
      leavePass(ctx, taskId);
      setAbandonStep(ctx, pass.id, AbandonStep.Abandoning);
      abandonPassAndBatch(ctx, pass.id);
    });
    const later = store.write((ctx) => {
      const next = insertPass(ctx, {
        id: mintId('Pass'),
        projectId: project.id,
        name: 'Again',
        pageCap: 4,
        returnBranch: 'main',
        startSha: 'a'.repeat(40),
        branch: '10db/again-def456',
        baseBranch: 'main',
        repo: null,
        taskIds: [taskId],
        dirt: [],
      });
      return insertWorkstream(ctx, taskId, {
        batchId: next.batch.id,
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      });
    }).value;

    expect(latestPassTurn(store.db, taskId)).toBeUndefined();
    const turn = store.write((ctx) =>
      insertPassTurn(ctx, { taskId, workstreamId: later.id, sessionId: null, messageId: null }),
    ).value;
    expect(turn.seq).toBe(2);
    expect(latestPassTurn(store.db, taskId)?.id).toBe(turn.id);
  });
});
