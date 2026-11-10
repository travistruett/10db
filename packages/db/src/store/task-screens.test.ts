import {
  EventType,
  mintId,
  NotFoundError,
  ScreenKind,
  SCREENS_MATRIX_DEFAULT,
  ScreenTheme,
  type PassTurnId,
  type ProjectDto,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import {
  createTestStore,
  getTaskScreenRow,
  hashNamed,
  hasTaskScreen,
  insertBuilderMessage,
  insertSession,
  listTaskCodexStarts,
  listTaskToolCalls,
  taskStartFacts,
  insertPass,
  insertPassTurn,
  insertTask,
  insertTaskScreen,
  insertWorkstream,
  listTaskScreens,
  seedProject,
  type NewTaskScreen,
  type Store,
} from './index';

// Workbench spec §10, §11: a task's pictures are rows naming files by their hash; a turn whose picture
// is the same as the last one stores nothing new, and a file is kept while an unpruned row names it.

let store: Store;
let close: () => void;
let project: ProjectDto;
let taskId: TaskId;
let turnIds: PassTurnId[];
let runId: WorkstreamId;
let clock = new Date('2026-11-10T12:00:00.000Z');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

beforeEach(() => {
  clock = new Date('2026-11-10T12:00:00.000Z');
  ({ store, close } = createTestStore(() => clock));
  project = seedProject(store, {
    delivery: 'local',
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
  const workstreamId = store.write((ctx) =>
    insertWorkstream(ctx, taskId, {
      batchId: opened.batch.id,
      first: { model: 'claude-sonnet-5-5', effort: 'medium' },
    }),
  ).value.id;
  runId = workstreamId;
  turnIds = [];
  for (let i = 0; i < 3; i += 1) {
    const turn = store.write((ctx) => {
      const message = insertBuilderMessage(ctx, taskId, { body: `turn ${String(i)}`, files: [] });
      const started = insertPassTurn(ctx, {
        taskId,
        workstreamId,
        sessionId: null,
        messageId: message.id,
      });
      ctx.tx
        .update(schema.passTurns)
        .set({ endedAt: ctx.now, ending: 'ready' })
        .where(eq(schema.passTurns.id, started.id))
        .run();
      return started;
    }).value;
    turnIds.push(turn.id);
  }
});
afterEach(() => {
  close();
});

const later = (): void => {
  clock = new Date(clock.getTime() + 1000);
};

function screen(over: Partial<NewTaskScreen> = {}): NewTaskScreen {
  return {
    taskId,
    turnId: null,
    kind: ScreenKind.Before,
    route: '/people',
    viewport: { width: 1440, height: 900 },
    theme: ScreenTheme.Default,
    sha256: HASH_A,
    size: 100,
    width: 1440,
    height: 900,
    storedPath: `/data/screens/aa/${HASH_A}.png`,
    keptSha: null,
    ...over,
  };
}

const insert = (over: Partial<NewTaskScreen> = {}) => {
  later();
  return store.write((ctx) => insertTaskScreen(ctx, screen(over)));
};

describe('insertTaskScreen', () => {
  it.each([ScreenKind.Before, ScreenKind.Turn, ScreenKind.After])(
    'keeps a %s picture and says so',
    (kind) => {
      const turnId = kind === ScreenKind.Turn ? turnIds[0] : undefined;
      const { value, events } = insert({ kind, turnId: turnId ?? null, keptSha: 'c'.repeat(40) });
      expect(value).toMatchObject({
        taskId,
        kind,
        route: '/people',
        viewport: { width: 1440, height: 900 },
        theme: 'default',
        sha256: HASH_A,
        keptSha: 'c'.repeat(40),
        turnId: turnId ?? null,
        turnSeq: turnId === undefined ? null : 1,
      });
      expect(events).toEqual([
        expect.objectContaining({
          type: EventType.TaskScreenAdded,
          entityType: 'task',
          entityId: taskId,
          data: { taskId, screenId: value?.id, turnId: turnId ?? null, kind },
        }),
      ]);
    },
  );

  it('stores no new turn picture when it is the same as the last turn picture of the route', () => {
    const [one, two, three] = turnIds;
    expect(insert({ kind: ScreenKind.Turn, turnId: one ?? null }).value).not.toBeNull();
    const same = insert({ kind: ScreenKind.Turn, turnId: two ?? null });
    expect(same.value).toBeNull();
    expect(same.events).toEqual([]);
    expect(
      insert({ kind: ScreenKind.Turn, turnId: three ?? null, sha256: HASH_B }).value,
    ).not.toBeNull();
    expect(listTaskScreens(store.db, taskId).map((s) => s.turnSeq)).toEqual([1, 3]);
  });

  it('keeps the same bytes again in another viewport, theme or route, and as a before or after', () => {
    insert({ kind: ScreenKind.Turn, turnId: turnIds[0] ?? null });
    const again = [
      { kind: ScreenKind.Turn, turnId: turnIds[1] ?? null, viewport: { width: 390, height: 844 } },
      { kind: ScreenKind.Turn, turnId: turnIds[1] ?? null, theme: ScreenTheme.Dark },
      { kind: ScreenKind.Turn, turnId: turnIds[1] ?? null, route: '/people?tab=all' },
      { kind: ScreenKind.After },
    ];
    for (const over of again) expect(insert(over).value).not.toBeNull();
  });

  it('compares with the newest turn picture only, not an older one', () => {
    insert({ kind: ScreenKind.Turn, turnId: turnIds[0] ?? null });
    insert({ kind: ScreenKind.Turn, turnId: turnIds[1] ?? null, sha256: HASH_B });
    expect(insert({ kind: ScreenKind.Turn, turnId: turnIds[2] ?? null }).value).not.toBeNull();
  });

  it('compares with no pruned picture', () => {
    const first = insert({ kind: ScreenKind.Turn, turnId: turnIds[0] ?? null }).value;
    store.write((ctx) =>
      ctx.tx
        .update(schema.taskScreens)
        .set({ prunedAt: ctx.now })
        .where(eq(schema.taskScreens.id, first?.id ?? mintId('TaskScreen')))
        .run(),
    );
    expect(insert({ kind: ScreenKind.Turn, turnId: turnIds[1] ?? null }).value).not.toBeNull();
  });
});

describe('reading pictures', () => {
  it('lists a task oldest first, leaving out pruned pictures', () => {
    const before = insert({ kind: ScreenKind.Before }).value;
    const turn = insert({
      kind: ScreenKind.Turn,
      turnId: turnIds[0] ?? null,
      sha256: HASH_B,
    }).value;
    const after = insert({ kind: ScreenKind.After }).value;
    expect(listTaskScreens(store.db, taskId).map((s) => s.id)).toEqual([
      before?.id,
      turn?.id,
      after?.id,
    ]);
    store.write((ctx) =>
      ctx.tx
        .update(schema.taskScreens)
        .set({ prunedAt: ctx.now })
        .where(eq(schema.taskScreens.id, turn?.id ?? mintId('TaskScreen')))
        .run(),
    );
    expect(listTaskScreens(store.db, taskId).map((s) => s.kind)).toEqual(['before', 'after']);
  });

  it('reads one row with where its file is, and refuses an unknown id', () => {
    const kept = insert().value;
    expect(getTaskScreenRow(store.db, kept?.id ?? mintId('TaskScreen')).storedPath).toBe(
      `/data/screens/aa/${HASH_A}.png`,
    );
    expect(() => getTaskScreenRow(store.db, mintId('TaskScreen'))).toThrow(NotFoundError);
  });

  it('names a hash while an unpruned row does, and not once only pruned rows name it', () => {
    expect(hashNamed(store.db, HASH_A)).toBe(false);
    const one = insert({ kind: ScreenKind.Before }).value;
    const two = insert({ kind: ScreenKind.After }).value;
    expect(hashNamed(store.db, HASH_A)).toBe(true);
    for (const row of [one, two]) {
      store.write((ctx) =>
        ctx.tx
          .update(schema.taskScreens)
          .set({ prunedAt: ctx.now })
          .where(eq(schema.taskScreens.id, row?.id ?? mintId('TaskScreen')))
          .run(),
      );
      expect(hashNamed(store.db, HASH_A)).toBe(row === one);
    }
  });
});

describe("a project's picture settings", () => {
  it('starts with the default matrix and no dev login', () => {
    expect(project.screens).toEqual(SCREENS_MATRIX_DEFAULT);
    expect(project.devLoginCommand).toBeNull();
  });
});

describe('what the before rule reads', () => {
  it("counts the task's turns and sessions on every run", () => {
    expect(taskStartFacts(store.db, taskId)).toEqual({ turns: 3, sessions: 0, keptWorkSha: null });
    store.write((ctx) =>
      insertSession(ctx, {
        workstreamId: runId,
        provider: 'claude',
        model: 'm',
        effort: 'low',
        mode: 'managed',
        mcpTokenHash: mintId('Session'),
      }),
    );
    expect(taskStartFacts(store.db, taskId).sessions).toBe(1);
  });

  it("lists the task's tool calls up to a time", () => {
    const session = store.write((ctx) =>
      insertSession(ctx, {
        workstreamId: runId,
        provider: 'claude',
        model: 'm',
        effort: 'low',
        mode: 'managed',
        mcpTokenHash: mintId('Session'),
      }),
    ).value;
    const call = (tool: string | null) => {
      later();
      store.write((ctx) => {
        ctx.emit({
          type: EventType.SessionActivity,
          entityType: 'session',
          entityId: session.id,
          data: {
            workstreamId: runId,
            kind: tool === null ? 'text' : 'tool',
            summary: 'x',
            tool: tool === null ? null : { name: tool, target: 'x' },
            turn: null,
          },
        });
      });
      return clock.toISOString();
    };
    const read = call('Read');
    call(null);
    const write = call('Write');
    call('Bash');
    expect(listTaskToolCalls(store.db, taskId, write)).toEqual([
      { tool: 'Read', at: read },
      { tool: 'Write', at: write },
    ]);
  });

  it("lists when the task's Codex sessions started, and none of its Claude sessions", () => {
    const start = (provider: 'claude' | 'codex') => {
      later();
      store.write((ctx) =>
        insertSession(ctx, {
          workstreamId: runId,
          provider,
          model: 'm',
          effort: 'low',
          mode: 'managed',
          mcpTokenHash: mintId('Session'),
        }),
      );
      return clock.toISOString();
    };
    start('claude');
    const codex = start('codex');
    expect(listTaskCodexStarts(store.db, taskId)).toEqual([codex]);
  });

  it('says whether the task has a picture of a kind', () => {
    expect(hasTaskScreen(store.db, taskId, ScreenKind.Before)).toBe(false);
    insert({ kind: ScreenKind.Before });
    expect(hasTaskScreen(store.db, taskId, ScreenKind.Before)).toBe(true);
    expect(hasTaskScreen(store.db, taskId, ScreenKind.After)).toBe(false);
  });
});
