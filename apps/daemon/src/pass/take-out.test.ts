import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  isTerminal,
  mintId,
  TakeOutStep,
  WORKSTREAM_TRANSITIONS,
  WorkstreamState,
  type WorkstreamId,
} from '@10db/contracts';
import {
  activeClaims,
  createTestStore,
  getTask,
  getTaskKeptWork,
  getWorkstreamRow,
  insertPass,
  insertTakeOut,
  insertTask,
  insertWorkstream,
  lastTakeOut,
  listTaskThreadRows,
  seedProject,
  setTaskKeptWork,
  transitionWorkstream,
  type Store,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import type { Git } from '../git';
import { keptRef, keepTurnWork, passKeptRef, takeOut, takeOutSteps, TakeOutWithin } from './index';
import { leavePassForBoard } from './take-out';

// Workbench spec §5.4: taking a task out of its pass keeps its work at a ref of its own, puts its
// page's files back as they were without it, and returns it to the Board, step by recorded step.

let w: PassWorld;
afterEach(() => {
  w.close();
});

/** The lanes a take-out stopped, as the runner's stop would hear of them. */
let stopped: WorkstreamId[] = [];
const takeOutDeps = (world: PassWorld, git: Git = world.h.git) => ({
  ...world.deps,
  git,
  stopLane: (id: WorkstreamId) => {
    stopped.push(id);
    return Promise.resolve();
  },
});

const read = (world: PassWorld, rel: string) => readFileSync(join(world.h.repo, rel), 'utf8');
const notices = (world: PassWorld) =>
  listTaskThreadRows(world.h.store.db, world.settings.id)
    .filter((m) => m.kind === 'notice')
    .map((m) => m.body);

/**
 * A pass on a folder whose Settings page was edited before it opened; Settings' turn then edits the
 * page again, adds a file and deletes one, and the builder edits a file by hand after the turn.
 */
async function worked(): Promise<PassWorld> {
  stopped = [];
  const world = await openPassWorld({
    before: ({ write }) => {
      write('src/settings/page.tsx', 'edited before the pass\n');
    },
  });
  const turn = world.startTurn(world.settings);
  world.write('src/settings/page.tsx', 'edited before the pass\nand in the turn\n');
  world.write('src/settings/new.tsx', 'added in the turn\n');
  unlinkSync(join(world.h.repo, 'src/settings/old.tsx'));
  await keepTurnWork(world.deps, { workstreamId: world.runOf(world.settings), turnId: turn.id });
  world.endTurn(turn);
  world.write('src/settings/new.tsx', 'added in the turn\nand by hand\n');
  return world;
}

/** What a finished take-out of Settings left, the same however many restarts it took. */
function expectTakenOut(world: PassWorld): void {
  const db = world.h.store.db;
  const task = getTask(db, world.settings.id);
  // The page's files are as they were before the pass: the earlier edit back, the task's file gone.
  expect(read(world, 'src/settings/page.tsx')).toBe('edited before the pass\n');
  expect(read(world, 'src/settings/old.tsx')).toBe('old\n');
  expect(existsSync(join(world.h.repo, 'src/settings/new.tsx'))).toBe(false);
  // The folder's own index was refreshed for the file put back as HEAD has it.
  expect(world.h.git$('diff-files', '--name-only')).not.toContain('src/settings/old.tsx');
  // Its work, the hand edit and the untracked file included, is at its own ref.
  const ref = keptRef(task.id);
  expect(world.h.git$('show', `${ref}:src/settings/new.tsx`)).toBe(
    'added in the turn\nand by hand',
  );
  expect(world.h.git$('show', `${ref}:src/settings/page.tsx`)).toBe(
    'edited before the pass\nand in the turn',
  );
  expect(world.h.git$('for-each-ref', passKeptRef(world.opened.pass.id, task.id))).toBe('');
  expect(getTaskKeptWork(db, task.id)).toEqual({
    keptSha: world.h.git$('rev-parse', ref),
    keptBaseSha: world.opened.pass.startSha,
  });
  // Back on the Board, open, with its thread and no pass; its run cancelled, its page released.
  expect(task).toMatchObject({ passId: null, status: 'open' });
  const run = world.runOf(world.settings);
  expect(getWorkstreamRow(db, run).state).toBe(WorkstreamState.Cancelled);
  expect(activeClaims(db, run)).toEqual([]);
  expect(lastTakeOut(db, task.id)).toMatchObject({ step: TakeOutStep.Done, left: [] });
  // The other page is untouched, and the branch never moved.
  expect(read(world, 'src/people/page.tsx')).toBe('people\n');
  expect(world.h.git$('rev-parse', 'HEAD')).toBe(world.opened.pass.startSha);
}

describe('takeOut', () => {
  it("keeps the page's work with its task, puts its files back as before the pass, and returns it to the Board", async () => {
    w = await worked();
    const result = await takeOut(takeOutDeps(w), {
      taskId: w.settings.id,
      within: TakeOutWithin.Alone,
    });
    expect(result).toEqual({
      taskId: w.settings.id,
      passId: w.opened.pass.id,
      tookOut: true,
      keptSha: w.h.git$('rev-parse', keptRef(w.settings.id)),
      stillChanging: [],
      left: [],
    });
    expect(stopped).toEqual([w.runOf(w.settings)]);
    expectTakenOut(w);
    expect(notices(w).at(-1)).toBe(
      'Taken out of the pass "Polish": its work is kept with the task (3 files).',
    );
  });

  it('puts a file the pass branch landed on during the pass back to the branch version', async () => {
    stopped = [];
    w = await openPassWorld();
    // A sign-off landed the file on the pass's branch.
    const landed = w.h.commit('src/settings/page.tsx', 'landed on the pass branch\n');
    w.write('src/settings/page.tsx', 'landed on the pass branch\nthen the task\n');
    await takeOutSteps(takeOutDeps(w), { taskId: w.settings.id, within: TakeOutWithin.Alone });
    expect(read(w, 'src/settings/page.tsx')).toBe('landed on the pass branch\n');
    expect(getTaskKeptWork(w.h.store.db, w.settings.id)?.keptBaseSha).toBe(landed);
  });

  it('leaves saved work from an earlier take-out as it is when the page made none since', async () => {
    stopped = [];
    w = await openPassWorld();
    const start = w.opened.pass.startSha;
    const earlier = w.h.git$('commit-tree', '-p', start, '-m', 'Earlier', `${start}^{tree}`);
    w.h.git$('update-ref', keptRef(w.settings.id), earlier);
    const saved = { keptSha: earlier, keptBaseSha: start };
    w.h.state.write((ctx) => {
      setTaskKeptWork(ctx, w.settings.id, saved);
    });

    await takeOutSteps(takeOutDeps(w), { taskId: w.settings.id, within: TakeOutWithin.Alone });

    expect(getTaskKeptWork(w.h.store.db, w.settings.id)).toEqual(saved);
    expect(w.h.git$('rev-parse', keptRef(w.settings.id))).toBe(earlier);
  });

  describe('a restart after each step goes on from the step it reached', () => {
    /** Dies at the `nth` call it is given, as the daemon dying inside that call would. */
    type Die = <T>(nth: number, real: () => Promise<T>) => Promise<T>;
    const crashes: {
      readonly name: string;
      readonly step: number;
      readonly crash: (git: Git, die: Die) => Git;
    }[] = [
      {
        name: 'during the fold of hand edits',
        step: TakeOutStep.Stopped,
        crash: (git, die) => ({
          ...git,
          pageChanges: (...a) => die(1, () => git.pageChanges(...a)),
        }),
      },
      {
        // The fold keeps the hand edit first; the second keep is the last kept commit.
        name: 'during the last kept commit',
        step: TakeOutStep.HandEditsFolded,
        crash: (git, die) => ({ ...git, keepWork: (...a) => die(2, () => git.keepWork(...a)) }),
      },
      {
        name: 'during the check',
        step: TakeOutStep.Kept,
        crash: (git, die) => ({ ...git, blobAt: (...a) => die(1, () => git.blobAt(...a)) }),
      },
      {
        name: 'during the put-back',
        step: TakeOutStep.Checked,
        crash: (git, die) => ({
          ...git,
          restoreFiles: (...a) => die(1, () => git.restoreFiles(...a)),
        }),
      },
      {
        name: 'while the work moves to its ref',
        step: TakeOutStep.PutBack,
        crash: (git, die) => ({
          ...git,
          moveKeptRef: (...a) => die(1, () => git.moveKeptRef(...a)),
        }),
      },
    ];
    it.each(crashes)('$name', async ({ crash, step }) => {
      w = await worked();
      const calls = new Map<number, number>();
      const die: Die = (nth, real) => {
        const n = (calls.get(nth) ?? 0) + 1;
        calls.set(nth, n);
        return n === nth ? Promise.reject(new Error('the daemon died')) : real();
      };
      const crashing = crash(w.h.git, die);
      const input = { taskId: w.settings.id, within: TakeOutWithin.Alone };
      await expect(takeOutSteps(takeOutDeps(w, crashing), input)).rejects.toThrow(
        'the daemon died',
      );
      expect(lastTakeOut(w.h.store.db, w.settings.id)?.step).toBe(step);

      await takeOutSteps(takeOutDeps(w), input);
      expectTakenOut(w);
    });
  });

  describe('a page whose files keep changing', () => {
    /** A git whose every hash of the folder sees `src/settings/page.tsx` written again just before. */
    function racing(world: PassWorld): Git {
      let n = 0;
      return {
        ...world.h.git,
        hashOnDisk: (repo, paths) => {
          n += 1;
          world.write('src/settings/page.tsx', `written again (${String(n)})\n`);
          return world.h.git.hashOnDisk(repo, paths);
        },
      };
    }

    it('stops a take-out asked for alone after three tries: the task stays in the pass, its thread says why', async () => {
      w = await worked();
      const result = await takeOut(takeOutDeps(w, racing(w)), {
        taskId: w.settings.id,
        within: TakeOutWithin.Alone,
      });
      expect(result).toMatchObject({
        tookOut: false,
        stillChanging: ['src/settings/page.tsx'],
        left: [],
      });
      expect(getTask(w.h.store.db, w.settings.id).passId).toBe(w.opened.pass.id);
      expect(lastTakeOut(w.h.store.db, w.settings.id)).toBeUndefined();
      expect(getWorkstreamRow(w.h.store.db, w.runOf(w.settings)).state).not.toBe(
        WorkstreamState.Cancelled,
      );
      expect(notices(w).at(-1)).toBe(
        "The page's files kept changing while it was being taken out, so it stays in the pass:\n" +
          '- src/settings/page.tsx',
      );
    });

    it('goes on inside an Abandon, leaving the files that still change as they are', async () => {
      w = await worked();
      const result = await takeOutSteps(takeOutDeps(w, racing(w)), {
        taskId: w.settings.id,
        within: TakeOutWithin.Abandon,
      });
      expect(result).toMatchObject({
        tookOut: true,
        stillChanging: ['src/settings/page.tsx'],
        left: ['src/settings/page.tsx'],
      });
      expect(read(w, 'src/settings/page.tsx')).toMatch(/^written again/);
      expect(read(w, 'src/settings/old.tsx')).toBe('old\n');
      expect(getTask(w.h.store.db, w.settings.id).passId).toBeNull();
    });
  });
});

describe('leavePassForBoard', () => {
  let store: Store;
  let close: () => void;
  afterEach(() => {
    close();
  });

  /** Moves the workstream from QUEUED to `to` by the shortest run of allowed transitions. */
  function moveTo(id: WorkstreamId, to: WorkstreamState): void {
    const previous = new Map<WorkstreamState, WorkstreamState>();
    const queue: WorkstreamState[] = [WorkstreamState.Queued];
    for (let s = queue.shift(); s !== undefined && s !== to; s = queue.shift())
      for (const next of WORKSTREAM_TRANSITIONS[s])
        if (!previous.has(next) && next !== WorkstreamState.Queued) {
          previous.set(next, s);
          queue.push(next);
        }
    const path: WorkstreamState[] = [];
    for (
      let s: WorkstreamState | undefined = to;
      s && s !== WorkstreamState.Queued;
      s = previous.get(s)
    )
      path.unshift(s);
    store.write((ctx) => {
      for (const s of path) transitionWorkstream(ctx, id, { to: s, fence: null });
    });
  }

  const states = Object.values(WorkstreamState).filter((s) => !isTerminal(s));
  it.each(states)(
    'cancels a run in %s and takes the task out of its pass in one write',
    (state) => {
      ({ store, close } = createTestStore());
      const project = seedProject(store, { repoPath: '/tmp/none' });
      const task = store.write((ctx) =>
        insertTask(ctx, project.id, {
          title: 'Settings',
          acceptanceCriteria: ['ok'],
          areas: ['api'],
        }),
      ).value;
      const run = store.write((ctx) =>
        insertWorkstream(ctx, task.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
      ).value;
      const passId = mintId('Pass');
      store.write((ctx) => {
        insertPass(ctx, {
          id: passId,
          projectId: project.id,
          name: 'Polish',
          pageCap: 4,
          returnBranch: 'main',
          startSha: 'a'.repeat(40),
          branch: '10db/polish-abc123',
          baseBranch: 'main',
          repo: null,
          taskIds: [task.id],
          dirt: [],
        });
        insertTakeOut(ctx, { taskId: task.id, passId, drops: [] });
      });
      moveTo(run.id, state);

      store.write((ctx) => {
        leavePassForBoard(ctx, {
          taskId: task.id,
          passId,
          kept: { keptSha: 'b'.repeat(40), keptBaseSha: 'a'.repeat(40) },
          files: 1,
        });
      });

      expect(getWorkstreamRow(store.db, run.id).state).toBe(WorkstreamState.Cancelled);
      expect(getTask(store.db, task.id).passId).toBeNull();
      expect(lastTakeOut(store.db, task.id)?.step).toBe(TakeOutStep.Done);
    },
  );
});
