import {
  BoardStatus,
  ConflictError,
  Effort,
  EventType,
  InvalidError,
  mintId,
  NotFoundError,
  WorkstreamState,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import { seedDefaultAccount } from './accounts';
import { insertBatch } from './batches';
import { listEventsAfter } from './events';
import { getProject, insertProject, listProjects, patchProject } from './projects';
import type { Store, WriteContext } from './store';
import { deriveBoardStatus, getTask, insertTask, listTasks, setTaskStatus } from './tasks';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
  store.write((ctx) => seedDefaultAccount(ctx, { expectedIdentity: null }));
});
afterEach(() => {
  close();
});

const insertMinimalProject = (ctx: WriteContext) =>
  insertProject(ctx, {
    name: 'x',
    repoPath: '/tmp/x',
    gateCommand: 'true',
    areas: [{ name: 'src', globs: ['src/**'] }],
  });

describe('store.write', () => {
  it('commits rows and events together and returns the persisted events', () => {
    const after = listEventsAfter(store.db, 0, 10).at(-1)?.seq ?? 0;
    const { value: project, events } = store.write(insertMinimalProject);
    expect(events.map((e) => e.type)).toEqual([
      EventType.ProjectCreated,
      EventType.BoardColumnSaved,
    ]);
    expect(events[0]?.entityId).toBe(project.id);
    expect(listEventsAfter(store.db, after, 10)).toEqual(events);
  });

  it('rolls back rows and events when the function throws', () => {
    const after = listEventsAfter(store.db, 0, 10).at(-1)?.seq ?? 0;
    expect(() =>
      store.write((ctx) => {
        insertMinimalProject(ctx);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(listProjects(store.db)).toEqual([]);
    expect(listEventsAfter(store.db, after, 10)).toEqual([]);
  });
});

describe('projects', () => {
  it('throws NotFoundError for an unknown project', () => {
    expect(() => getProject(store.db, mintId('Project'))).toThrow(NotFoundError);
  });

  it('rejects a second project on the same repository with ConflictError', () => {
    store.write(insertMinimalProject);
    expect(() => store.write(insertMinimalProject)).toThrow(ConflictError);
    expect(listProjects(store.db)).toHaveLength(1);
  });

  it('stores the extra allowed commands a project was created with', () => {
    const project = seedProject(store, { allowedCommands: ['pnpm exec prettier', 'pnpm test'] });
    expect(getProject(store.db, project.id).allowedCommands).toEqual([
      'pnpm exec prettier',
      'pnpm test',
    ]);
  });

  it('reads a project with no gate command back as null, and clears one that had it', () => {
    const none = store.write((ctx) =>
      insertProject(ctx, {
        name: 'none',
        repoPath: '/tmp/none',
        areas: [{ name: 'src', globs: ['src/**'] }],
      }),
    ).value;
    expect(getProject(store.db, none.id).gateCommand).toBeNull();
    const project = seedProject(store);
    expect(getProject(store.db, project.id).gateCommand).toBe('true');
    store.write((ctx) => patchProject(ctx, project.id, { gateCommand: null }));
    expect(getProject(store.db, project.id).gateCommand).toBeNull();
    expect(listProjects(store.db).map((p) => p.gateCommand)).toEqual([null, null]);
  });

  it('has no extra allowed commands unless it was given some', () => {
    const project = seedProject(store);
    expect(getProject(store.db, project.id).allowedCommands).toEqual([]);
  });

  it('starts a project without localhost and keeps a patched switch', () => {
    const project = seedProject(store);
    expect(getProject(store.db, project.id).sandboxLoopback).toBe(false);
    store.write((ctx) => patchProject(ctx, project.id, { sandboxLoopback: true }));
    expect(getProject(store.db, project.id).sandboxLoopback).toBe(true);
    expect(
      seedProject(store, { repoPath: '/tmp/loopback', sandboxLoopback: true }).sandboxLoopback,
    ).toBe(true);
  });

  it('replaces the allowed commands on a patch and leaves the other fields alone', () => {
    const project = seedProject(store, { allowedCommands: ['pnpm test'] });
    const patched = store.write((ctx) =>
      patchProject(ctx, project.id, { allowedCommands: ['pnpm lint'] }),
    ).value;
    expect(patched).toMatchObject({ allowedCommands: ['pnpm lint'], gateCommand: 'true' });
    expect(listProjects(store.db)[0]?.allowedCommands).toEqual(['pnpm lint']);

    store.write((ctx) => patchProject(ctx, project.id, { allowedCommands: [] }));
    expect(getProject(store.db, project.id).allowedCommands).toEqual([]);
  });

  it('refuses a patch with a command that is not a plain prefix and keeps the old list', () => {
    const project = seedProject(store, { allowedCommands: ['pnpm test'] });
    expect(() =>
      store.write((ctx) => patchProject(ctx, project.id, { allowedCommands: ['pnpm --run'] })),
    ).toThrow();
    expect(getProject(store.db, project.id).allowedCommands).toEqual(['pnpm test']);
  });
});

describe('workspace mode', () => {
  const worktreeConfig = {
    delivery: 'pull_request',
    prTitlePrefix: 'feat(app)',
    workspaceMode: 'worktree',
  } as const;

  it('insertProject stores the mode and the seed', () => {
    const project = seedProject(store, {
      ...worktreeConfig,
      worktreeSeed: ['node_modules', 'target'],
    });
    expect(getProject(store.db, project.id)).toMatchObject({
      workspaceMode: 'worktree',
      worktreeSeed: ['node_modules', 'target'],
    });
    expect(seedProject(store, { repoPath: '/tmp/plain' })).toMatchObject({
      workspaceMode: 'shared',
      worktreeSeed: ['node_modules'],
    });
  });

  it('patchProject refuses worktree mode with local delivery', () => {
    const local = seedProject(store);
    expect(() =>
      store.write((ctx) => patchProject(ctx, local.id, { workspaceMode: 'worktree' })),
    ).toThrow(InvalidError);
    const worktree = seedProject(store, { ...worktreeConfig, repoPath: '/tmp/wt' });
    expect(() =>
      store.write((ctx) => patchProject(ctx, worktree.id, { delivery: 'local' })),
    ).toThrow(InvalidError);
    expect(getProject(store.db, worktree.id).delivery).toBe('pull_request');
  });

  it('patchProject takes both changes together and stores a new seed', () => {
    const project = seedProject(store, { prTitlePrefix: 'feat(app)' });
    const patched = store.write((ctx) =>
      patchProject(ctx, project.id, {
        delivery: 'pull_request',
        workspaceMode: 'worktree',
        worktreeSeed: ['.venv'],
      }),
    ).value;
    expect(patched).toMatchObject({ workspaceMode: 'worktree', worktreeSeed: ['.venv'] });
  });

  it('patchProject refuses a workspace mode change while the project has an unfinished batch', () => {
    const project = seedProject(store, {
      delivery: 'pull_request',
      prTitlePrefix: 'feat(app)',
    });
    const batch = store.write((ctx) =>
      insertBatch(ctx, { projectId: project.id, title: 'Open one', baseBranch: 'main' }),
    ).value;
    let refusal: unknown;
    try {
      store.write((ctx) => patchProject(ctx, project.id, { workspaceMode: 'worktree' }));
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ConflictError);
    expect(String(refusal)).toContain('Open one');
    expect(batch.state).toBe('CUTTING');
    expect(getProject(store.db, project.id).workspaceMode).toBe('shared');
  });
});

describe('tasks', () => {
  it('lists tasks with dependencies and a derived board status', () => {
    const project = seedProject(store);
    const a = store.write((ctx) =>
      insertTask(ctx, project.id, { title: 'A', acceptanceCriteria: ['a'], areas: ['api'] }),
    ).value;
    const b = store.write((ctx) =>
      insertTask(ctx, project.id, {
        title: 'B',
        acceptanceCriteria: ['b'],
        areas: ['ui'],
        dependsOn: [a.id],
      }),
    ).value;
    const byTitle = Object.fromEntries(listTasks(store.db, project.id).map((t) => [t.title, t]));
    expect(byTitle['A']?.boardStatus).toBe(BoardStatus.Ready);
    expect(byTitle['B']).toMatchObject({ boardStatus: BoardStatus.Backlog, dependsOn: [a.id] });

    store.write((ctx) => {
      setTaskStatus(ctx, a.id, 'done');
    });
    const after = Object.fromEntries(listTasks(store.db, project.id).map((t) => [t.title, t]));
    expect(after['A']?.boardStatus).toBe(BoardStatus.Done);
    expect(after['B']?.boardStatus).toBe(BoardStatus.Ready);
    expect(b.id).toBe(after['B']?.id);
  });

  it('keeps a task with a cancelled dependency out of Ready', () => {
    const project = seedProject(store);
    const a = store.write((ctx) =>
      insertTask(ctx, project.id, { title: 'A', acceptanceCriteria: ['a'], areas: ['api'] }),
    ).value;
    const b = store.write((ctx) =>
      insertTask(ctx, project.id, {
        title: 'B',
        acceptanceCriteria: ['b'],
        areas: ['ui'],
        dependsOn: [a.id],
      }),
    ).value;
    store.write((ctx) => {
      setTaskStatus(ctx, a.id, 'cancelled');
    });
    expect(getTask(store.db, a.id).boardStatus).toBe(BoardStatus.Done);
    expect(getTask(store.db, b.id).boardStatus).toBe(BoardStatus.Backlog);
  });

  it('picks the later-minted workstream when two share a creation time', () => {
    const fixed = new Date('2026-01-01T00:00:00.000Z');
    const fixedStore = createTestStore(() => fixed);
    try {
      const project = seedProject(fixedStore.store);
      const task = fixedStore.store.write((ctx) =>
        insertTask(ctx, project.id, { title: 'A', acceptanceCriteria: ['a'], areas: ['api'] }),
      ).value;
      const at = fixed.toISOString();
      const ids = [mintId('Workstream'), mintId('Workstream')] as const;
      for (const id of ids) {
        fixedStore.store.db
          .insert(schema.workstreams)
          .values({
            id,
            taskId: task.id,
            projectId: project.id,
            state: WorkstreamState.Queued,
            nextAction: { kind: 'start' },
            attempt: 1,
            recoveryAttempts: 0,
            model: 'm',
            effort: Effort.Medium,
            fence: 0,
            createdAt: at,
            updatedAt: at,
          })
          .run();
      }
      expect(getTask(fixedStore.store.db, task.id).workstreamId).toBe(ids[1]);
    } finally {
      fixedStore.close();
    }
  });

  it('rejects an area the project does not define', () => {
    const project = seedProject(store);
    expect(() =>
      store.write((ctx) =>
        insertTask(ctx, project.id, { title: 'X', acceptanceCriteria: ['x'], areas: ['nope'] }),
      ),
    ).toThrow(InvalidError);
  });

  it('rejects a dependency from another project', () => {
    const p1 = seedProject(store);
    const p2 = seedProject(store);
    const other = store.write((ctx) =>
      insertTask(ctx, p2.id, { title: 'O', acceptanceCriteria: ['o'], areas: ['api'] }),
    ).value;
    expect(() =>
      store.write((ctx) =>
        insertTask(ctx, p1.id, {
          title: 'X',
          acceptanceCriteria: ['x'],
          areas: ['api'],
          dependsOn: [other.id],
        }),
      ),
    ).toThrow(InvalidError);
  });
});

describe('deriveBoardStatus', () => {
  it.each([
    ['done task', { taskStatus: 'done', depsDone: true, workstreamState: null }, BoardStatus.Done],
    ['ready', { taskStatus: 'open', depsDone: true, workstreamState: null }, BoardStatus.Ready],
    [
      'waiting on deps',
      { taskStatus: 'open', depsDone: false, workstreamState: null },
      BoardStatus.Backlog,
    ],
    [
      'running',
      { taskStatus: 'open', depsDone: true, workstreamState: 'RUNNING' },
      BoardStatus.InProgress,
    ],
    [
      'waiting on a human',
      { taskStatus: 'open', depsDone: true, workstreamState: 'WAITING_HUMAN' },
      BoardStatus.Blocked,
    ],
    [
      'failed',
      { taskStatus: 'open', depsDone: true, workstreamState: 'FAILED' },
      BoardStatus.Blocked,
    ],
    [
      'cancelled task',
      { taskStatus: 'cancelled', depsDone: true, workstreamState: null },
      BoardStatus.Done,
    ],
    [
      'cancelled run',
      { taskStatus: 'open', depsDone: true, workstreamState: 'CANCELLED' },
      BoardStatus.Ready,
    ],
    [
      'done in a batch that is shipping',
      { taskStatus: 'done', depsDone: true, workstreamState: 'DONE', batchState: 'SHIPPING' },
      BoardStatus.InProgress,
    ],
    [
      'done in a batch that failed to ship',
      { taskStatus: 'done', depsDone: true, workstreamState: 'DONE', batchState: 'FAILED' },
      BoardStatus.Blocked,
    ],
    [
      'done in a batch that is still open',
      { taskStatus: 'done', depsDone: true, workstreamState: 'DONE', batchState: 'OPEN' },
      BoardStatus.Done,
    ],
    [
      'done in a batch whose pull request is open',
      { taskStatus: 'done', depsDone: true, workstreamState: 'DONE', batchState: 'SHIPPED' },
      BoardStatus.Done,
    ],
    [
      'done in a batch that closed without a pull request',
      { taskStatus: 'done', depsDone: true, workstreamState: 'DONE', batchState: 'CLOSED' },
      BoardStatus.Done,
    ],
    [
      'done with no batch',
      { taskStatus: 'done', depsDone: true, workstreamState: 'DONE', batchState: null },
      BoardStatus.Done,
    ],
    [
      'removed from a batch that is shipping',
      {
        taskStatus: 'cancelled',
        depsDone: true,
        workstreamState: 'CANCELLED',
        batchState: 'SHIPPING',
      },
      BoardStatus.Done,
    ],
  ] as const)('%s', (_name, input, expected) => {
    expect(deriveBoardStatus(input)).toBe(expected);
  });
});
