import { existsSync } from 'node:fs';
import { mintId, ScreenKind, ScreenTheme, type TaskId, type TaskScreenDto } from '@10db/contracts';
import {
  createTestStore,
  getTaskScreenRow,
  insertTask,
  listTaskScreens,
  seedProject,
  setTaskStatus,
  type Store,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { pngOfSize } from '../../test/png';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger } from '../log';
import { keepScreen } from './picture-files';
import { prunableTurnScreens, startPruning } from './prune';

// Workbench spec §10 "When", §11: turn pictures are kept 14 days after their task is done or
// cancelled; befores and afters are kept for good, and a file is deleted only once no unpruned row
// names its hash.

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-11-30T12:00:00.000Z');

describe('prunableTurnScreens', () => {
  const taskA = mintId('Task');
  const taskB = mintId('Task');
  const row = (kind: ScreenKind, taskId: TaskId) => ({ id: mintId('TaskScreen'), kind, taskId });
  it.each([
    {
      name: 'a turn picture of a task done 15 days ago',
      kind: ScreenKind.Turn,
      doneDaysAgo: 15,
      pruned: true,
    },
    {
      name: 'one of a task done 13 days ago',
      kind: ScreenKind.Turn,
      doneDaysAgo: 13,
      pruned: false,
    },
    { name: 'one of a task not done', kind: ScreenKind.Turn, doneDaysAgo: null, pruned: false },
    { name: 'a before, however old', kind: ScreenKind.Before, doneDaysAgo: 400, pruned: false },
    { name: 'an after, however old', kind: ScreenKind.After, doneDaysAgo: 400, pruned: false },
  ])('$name: pruned $pruned', ({ kind, doneDaysAgo, pruned }) => {
    const screen = row(kind, taskA);
    const doneAt = new Map<TaskId, string>(
      doneDaysAgo === null ? [] : [[taskA, new Date(NOW - doneDaysAgo * DAY).toISOString()]],
    );
    expect(prunableTurnScreens([screen, row(ScreenKind.Turn, taskB)], doneAt, NOW)).toEqual(
      pruned ? [screen.id] : [],
    );
  });
});

describe('the pruning sweep', () => {
  let dir: TempDir;
  let store: Store;
  let state: StateStore;
  let close: () => void;
  let stop: (() => void) | null = null;
  let clock: ManualClock;
  afterEach(() => {
    stop?.();
    close();
    dir.cleanup();
  });

  function world(): void {
    dir = tempDir('prune');
    clock = new ManualClock(new Date('2026-11-01T12:00:00.000Z'));
    ({ store, close } = createTestStore(() => clock.now()));
    state = createStateStore(store, createEventBus());
  }

  function task(title: string): TaskId {
    const project = seedProject(store, {
      areas: [{ name: 'people', globs: ['src/**'], role: 'page', route: '/people' }],
    });
    return store.write((ctx) =>
      insertTask(ctx, project.id, { title, acceptanceCriteria: ['x'], areas: ['people'] }),
    ).value.id;
  }

  const keep = (taskId: TaskId, kind: ScreenKind, look: number): TaskScreenDto => {
    const kept = keepScreen(state, dir.path, {
      taskId,
      turnId: null,
      kind,
      route: kind === ScreenKind.Turn ? `/people/${String(look)}` : '/people',
      viewport: { width: 400, height: 400 },
      theme: ScreenTheme.Default,
      keptSha: null,
      png: pngOfSize(400, 400, look),
    });
    if (kept === null) throw new Error('not kept');
    return kept;
  };
  const fileOf = (screen: TaskScreenDto) => getTaskScreenRow(store.db, screen.id).storedPath;
  const done = (taskId: TaskId) => {
    store.write((ctx) => {
      setTaskStatus(ctx, taskId, 'done');
    });
  };

  it('prunes turn pictures 14 days after done, keeps befores and afters, and deletes only unnamed files', () => {
    world();
    const old = task('Old');
    const recent = task('Recent');
    const before = keep(old, ScreenKind.Before, 1);
    const shared = keep(old, ScreenKind.Turn, 2);
    const alone = keep(old, ScreenKind.Turn, 3);
    const after = keep(old, ScreenKind.After, 4);
    done(old);
    clock.advance(2 * DAY);
    const recentTurn = keep(recent, ScreenKind.Turn, 2);
    done(recent);
    clock.advance(13 * DAY);

    stop = startPruning({ state, dataDir: dir.path, clock, logger: silentLogger }).stop;
    expect(listTaskScreens(store.db, old).map((s) => s.kind)).toEqual(['before', 'after']);
    expect(getTaskScreenRow(store.db, shared.id).prunedAt).not.toBeNull();
    // A hash a kept row still names stays on disk; one only pruned rows name is deleted.
    expect(existsSync(fileOf(shared))).toBe(true);
    expect(existsSync(fileOf(alone))).toBe(false);
    expect([before, after].map((s) => existsSync(fileOf(s)))).toEqual([true, true]);
    expect(listTaskScreens(store.db, recent).map((s) => s.id)).toEqual([recentTurn.id]);

    // A day later the next sweep reaches the recent task, and the shared file goes with it.
    clock.advance(DAY);
    expect(listTaskScreens(store.db, recent)).toEqual([]);
    expect(existsSync(fileOf(shared))).toBe(false);
  });
});
