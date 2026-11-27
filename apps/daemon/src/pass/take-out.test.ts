import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  AbandonStep,
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
  setAbandonStep,
  setTaskKeptWork,
  transitionWorkstream,
  type Store,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { noticesPosted } from '../../test/notices-posted';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import type { Git } from '../git';
import { silentLogger } from '../log';
import { createWatcher } from '../watcher';
import {
  grantSharedHold,
  joinPass,
  keptRef,
  keepTurnWork,
  passKeptRef,
  putBackKeptWork,
  takeOut,
  takeOutSteps,
  TakeOutWithin,
} from './index';
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
  wrote: (): Promise<void> => Promise.resolve(),
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
function expectTakenOut(world: PassWorld, label: string): void {
  const db = world.h.store.db;
  const task = getTask(db, world.settings.id);
  // The page's files are as they were before the pass: the earlier edit back, the task's file gone.
  expect.soft(read(world, 'src/settings/page.tsx'), label).toBe('edited before the pass\n');
  expect.soft(read(world, 'src/settings/old.tsx'), label).toBe('old\n');
  expect.soft(existsSync(join(world.h.repo, 'src/settings/new.tsx')), label).toBe(false);
  // The folder's own index was refreshed for the file put back as HEAD has it.
  expect
    .soft(world.h.git$('diff-files', '--name-only'), label)
    .not.toContain('src/settings/old.tsx');
  // Its work, the hand edit and the untracked file included, is at its own ref.
  const ref = keptRef(task.id);
  expect
    .soft(world.h.git$('show', `${ref}:src/settings/new.tsx`), label)
    .toBe('added in the turn\nand by hand');
  expect
    .soft(world.h.git$('show', `${ref}:src/settings/page.tsx`), label)
    .toBe('edited before the pass\nand in the turn');
  expect
    .soft(world.h.git$('for-each-ref', passKeptRef(world.opened.pass.id, task.id)), label)
    .toBe('');
  expect.soft(getTaskKeptWork(db, task.id), label).toEqual({
    keptSha: world.h.git$('rev-parse', ref),
    keptBaseSha: world.opened.pass.startSha,
  });
  // Back on the Board, open, with its thread and no pass; its run cancelled, its page released.
  expect.soft(task, label).toMatchObject({ passId: null, status: 'open' });
  const run = world.runOf(world.settings);
  expect.soft(getWorkstreamRow(db, run).state, label).toBe(WorkstreamState.Cancelled);
  expect.soft(activeClaims(db, run), label).toEqual([]);
  expect.soft(lastTakeOut(db, task.id), label).toMatchObject({ step: TakeOutStep.Done, left: [] });
  // The other page is untouched, and the branch never moved.
  expect.soft(read(world, 'src/people/page.tsx'), label).toBe('people\n');
  expect.soft(world.h.git$('rev-parse', 'HEAD'), label).toBe(world.opened.pass.startSha);
}

describe('takeOut', () => {
  // Two worlds, each taking the page out twice.
  it(
    "keeps the page's work with its task, puts its files back as before the pass, returns it to the Board, and takes it out again once Add Page put it back, in one daemon or after a restart",
    { timeout: 180_000 },
    async () => {
      for (const [at, restart] of [false, true].entries()) {
        if (at > 0) w.close();
        const label = restart ? 'after a restart' : 'in one daemon';
        w = await worked();
        const result = await takeOut(takeOutDeps(w), {
          taskId: w.settings.id,
          within: TakeOutWithin.Alone,
        });
        expect.soft(result, label).toEqual({
          taskId: w.settings.id,
          passId: w.opened.pass.id,
          tookOut: true,
          keptSha: w.h.git$('rev-parse', keptRef(w.settings.id)),
          stillChanging: [],
          left: [],
        });
        expect.soft(stopped, label).toEqual([w.runOf(w.settings)]);
        expectTakenOut(w, label);
        expect
          .soft(notices(w).at(-1), label)
          .toBe('Taken out of the pass "Polish": its work is kept with the task (3 files).');

        await joinPass(
          w.h.ctx,
          w.opened.pass.id,
          { pages: [], taskIds: [w.settings.id], firstMessage: null },
          { leaseMs: 60_000, putBack: (input) => putBackKeptWork(w.deps, input) },
        );
        expect(read(w, 'src/settings/new.tsx'), label).toBe('added in the turn\nand by hand\n');
        w.write('src/settings/new.tsx', 'added in the turn\nand by hand\nand after Add Page\n');

        const base = restart ? { ...takeOutDeps(w), ...w.restart() } : takeOutDeps(w);
        const again = await takeOut(base, { taskId: w.settings.id, within: TakeOutWithin.Alone });

        expect.soft(again.tookOut, label).toBe(true);
        const db = w.h.store.db;
        expect
          .soft(getTask(db, w.settings.id), label)
          .toMatchObject({ passId: null, status: 'open' });
        expect.soft(lastTakeOut(db, w.settings.id), label).toMatchObject({
          passId: w.opened.pass.id,
          step: TakeOutStep.Done,
        });
        expect.soft(read(w, 'src/settings/page.tsx'), label).toBe('edited before the pass\n');
        expect.soft(existsSync(join(w.h.repo, 'src/settings/new.tsx')), label).toBe(false);
        expect
          .soft(w.h.git$('show', `${keptRef(w.settings.id)}:src/settings/new.tsx`), label)
          .toBe('added in the turn\nand by hand\nand after Add Page');
      }
    },
  );

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

  it("raises no card for the files its own put-back wrote, while another page's lane works", async () => {
    w = await worked();
    const db = w.h.store.db;
    // People's lane is working, so a write outside every claim is carded as its shell's.
    w.h.state.write((ctx) => {
      for (const to of [WorkstreamState.Starting, WorkstreamState.Running])
        transitionWorkstream(ctx, w.runOf(w.people), { to, fence: null });
    });
    const heard = new Map<string, (rel: string) => void>();
    const watcher = createWatcher({
      state: w.h.state,
      inbox: w.h.inbox,
      git: w.h.git,
      logger: silentLogger,
      clock: w.h.ctx.clock,
      watch: (root, onChange) => {
        heard.set(root, onChange);
        return { close: () => undefined };
      },
      // A stray cards at its first batch, so a write after the put-back shows at once.
      strayWaitMs: 0,
    });
    // A write outside every claim to an ordinary path is a notice in Activity, not a card.
    const strays = () => noticesPosted(db).filter((n) => n.key.startsWith('stray-write:'));
    const change = async (rel: string) => {
      for (const onChange of heard.values()) onChange(rel);
      await watcher.flush();
    };
    try {
      watcher.sync();
      await takeOutSteps(
        { ...takeOutDeps(w), wrote: (repo, paths) => watcher.daemonWrote(repo, paths) },
        { taskId: w.settings.id, within: TakeOutWithin.Alone },
      );
      // The file went back to its earlier uncommitted content, outside every claim now.
      expect(read(w, 'src/settings/page.tsx')).toBe('edited before the pass\n');
      await change('src/settings/page.tsx');
      expect(strays()).toEqual([]);

      // A write to it after the put-back is someone's.
      w.write('src/settings/page.tsx', 'written after the take-out\n');
      await change('src/settings/page.tsx');
      expect(strays().map((c) => c.body)).toEqual([
        expect.stringContaining('src/settings/page.tsx'),
      ]);
    } finally {
      watcher.stop();
    }
  });

  it('leaves saved work from an earlier take-out as it is when the page made none since, and refuses a take-out asked for alone once the pass is no longer open, writing no row', async () => {
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

    w.h.state.write((ctx) => {
      setAbandonStep(ctx, w.opened.pass.id, AbandonStep.Abandoning);
    });
    await expect(
      takeOutSteps(takeOutDeps(w), { taskId: w.people.id, within: TakeOutWithin.Alone }),
    ).rejects.toThrow(/abandoning/);
    expect(lastTakeOut(w.h.store.db, w.people.id)).toBeUndefined();
    // Only Settings' take-out stopped a lane: the refused one stopped none.
    expect(stopped).toEqual([w.runOf(w.settings)]);
  });

  // Two worlds, each with a refused take-out and a finished one.
  it(
    "leaves no row when a take-out asked for alone fails off the pass's branch, so the page goes on, and inside a Close or an Abandon finishes there with a shared hold left open",
    { timeout: 180_000 },
    async () => {
      for (const [at, within] of [TakeOutWithin.Close, TakeOutWithin.Abandon].entries()) {
        if (at > 0) w.close();
        const label = `inside ${within}`;
        w = await worked();
        w.startTurn(w.settings);
        await grantSharedHold(w.deps, { workstreamId: w.runOf(w.settings), area: 'src' });
        w.write('src/button.ts', 'a shared button\n');
        // The builder moved Your folder off the pass's branch: nothing of the page can be kept.
        w.h.git$('switch', '-q', 'main');

        await expect(
          takeOut(takeOutDeps(w), { taskId: w.settings.id, within: TakeOutWithin.Alone }),
          label,
        ).rejects.toThrow(/not on the pass's branch/);
        expect.soft(lastTakeOut(w.h.store.db, w.settings.id), label).toBeUndefined();
        expect.soft(getTask(w.h.store.db, w.settings.id).passId, label).toBe(w.opened.pass.id);
        expect
          .soft(read(w, 'src/settings/new.tsx'), label)
          .toBe('added in the turn\nand by hand\n');

        const out = await takeOutSteps(takeOutDeps(w), { taskId: w.settings.id, within });

        expect.soft(out.tookOut, label).toBe(true);
        expect.soft(getTask(w.h.store.db, w.settings.id).passId ?? null, label).toBeNull();
        // Nothing is written on a branch the pass does not own.
        expect.soft(read(w, 'src/button.ts'), label).toBe('a shared button\n');
      }
    },
  );

  /**
   * Dies at the `nth` call it is given, as the daemon dying inside that call would: the call never
   * returns, so nothing after it runs, not even a catch.
   */
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
  // A world per crash point.
  it(
    'goes on from the step it reached after a restart, wherever the daemon died',
    { timeout: 300_000 },
    async () => {
      for (const [at, { name, crash, step }] of crashes.entries()) {
        if (at > 0) w.close();
        w = await worked();
        const calls = new Map<number, number>();
        let died: () => void = () => undefined;
        const dead = new Promise<void>((resolve) => {
          died = resolve;
        });
        const die: Die = (nth, real) => {
          const n = (calls.get(nth) ?? 0) + 1;
          calls.set(nth, n);
          if (n !== nth) return real();
          died();
          return new Promise(() => undefined);
        };
        const crashing = crash(w.h.git, die);
        const input = { taskId: w.settings.id, within: TakeOutWithin.Alone };
        void takeOutSteps(takeOutDeps(w, crashing), input);
        await dead;
        expect.soft(lastTakeOut(w.h.store.db, w.settings.id)?.step, name).toBe(step);

        // A daemon started again reads the step from the database file, holding nothing else.
        await takeOutSteps({ ...takeOutDeps(w), ...w.restart() }, input);
        expectTakenOut(w, name);
      }
    },
  );

  it('stops a take-out asked for alone after three tries of a page whose files keep changing, the task staying in the pass, and goes on inside an Abandon, leaving those files as they are', async () => {
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

    const inside = await takeOutSteps(takeOutDeps(w, racing(w)), {
      taskId: w.settings.id,
      within: TakeOutWithin.Abandon,
    });
    expect(inside).toMatchObject({
      tookOut: true,
      stillChanging: ['src/settings/page.tsx'],
      left: ['src/settings/page.tsx'],
    });
    expect(read(w, 'src/settings/page.tsx')).toMatch(/^written again/);
    expect(read(w, 'src/settings/old.tsx')).toBe('old\n');
    expect(getTask(w.h.store.db, w.settings.id).passId).toBeNull();
  });

  it(
    'discards a page: its changes are deleted, a Board task goes back open and a task the pass made is retired, after a restart too',
    { timeout: 120_000 },
    async () => {
      stopped = [];
      w = await openPassWorld({ peopleByPass: true });
      const db = w.h.store.db;
      const pass = w.opened.pass.id;
      const settingsTurn = w.startTurn(w.settings);
      w.write('src/settings/page.tsx', 'settings, by the task\n');
      w.write('src/settings/new.tsx', 'added by the task\n');
      await keepTurnWork(w.deps, { workstreamId: w.runOf(w.settings), turnId: settingsTurn.id });
      w.endTurn(settingsTurn);
      const peopleTurn = w.startTurn(w.people);
      w.write('src/people/page.tsx', 'people, by the task\n');
      await keepTurnWork(w.deps, { workstreamId: w.runOf(w.people), turnId: peopleTurn.id });
      w.endTurn(peopleTurn);

      // Settings came from the Board: its Discard runs whole in one daemon.
      const result = await takeOut(takeOutDeps(w), {
        taskId: w.settings.id,
        within: TakeOutWithin.Alone,
        discard: true,
      });
      expect.soft(result.tookOut).toBe(true);
      expect.soft(read(w, 'src/settings/page.tsx')).toBe('settings\n');
      expect.soft(existsSync(join(w.h.repo, 'src/settings/new.tsx'))).toBe(false);
      for (const ref of [keptRef(w.settings.id), passKeptRef(pass, w.settings.id)])
        expect.soft(w.h.git$('for-each-ref', ref), ref).toBe('');
      expect.soft(getTaskKeptWork(db, w.settings.id)).toBeNull();
      expect.soft(getTask(db, w.settings.id)).toMatchObject({ passId: null, status: 'open' });
      expect.soft(notices(w).at(-1)).toBe('Discarded from Polish; its changes were deleted.');
      expect.soft(lastTakeOut(db, w.settings.id)).toMatchObject({ discarded: true });

      // People, which the pass made, was cut short after its row was written: the restart's
      // take-out, asked for with no Discard, still deletes, as the row says.
      w.h.state.write((ctx) =>
        insertTakeOut(ctx, { taskId: w.people.id, passId: pass, drops: [], discarded: true }),
      );
      await takeOut(
        { ...takeOutDeps(w), ...w.restart() },
        {
          taskId: w.people.id,
          within: TakeOutWithin.Alone,
        },
      );
      expect.soft(read(w, 'src/people/page.tsx')).toBe('people\n');
      for (const ref of [keptRef(w.people.id), passKeptRef(pass, w.people.id)])
        expect.soft(w.h.git$('for-each-ref', ref), ref).toBe('');
      expect.soft(getTask(db, w.people.id)).toMatchObject({ passId: null, status: 'cancelled' });
      // The branch never moved.
      expect.soft(w.h.git$('rev-parse', 'HEAD')).toBe(w.opened.pass.startSha);
    },
  );
});

describe('leavePassForBoard', () => {
  /** Moves the workstream from QUEUED to `to` by the shortest run of allowed transitions. */
  function moveTo(store: Store, id: WorkstreamId, to: WorkstreamState): void {
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

  it('cancels a run in every state that is not terminal and takes the task out of its pass in one write', () => {
    const states = Object.values(WorkstreamState).filter((s) => !isTerminal(s));
    for (const state of states) {
      const { store, close } = createTestStore();
      try {
        const project = seedProject(store, { repoPath: '/tmp/none' });
        const task = store.write((ctx) =>
          insertTask(ctx, project.id, {
            title: 'Settings',
            acceptanceCriteria: ['ok'],
            areas: ['api'],
          }),
        ).value;
        const run = store.write((ctx) =>
          insertWorkstream(ctx, task.id, {
            first: { model: 'claude-sonnet-5-5', effort: 'medium' },
          }),
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
        moveTo(store, run.id, state);

        store.write((ctx) => {
          leavePassForBoard(ctx, {
            taskId: task.id,
            passId,
            kept: { keptSha: 'b'.repeat(40), keptBaseSha: 'a'.repeat(40) },
            files: 1,
          });
        });

        expect
          .soft(getWorkstreamRow(store.db, run.id).state, state)
          .toBe(WorkstreamState.Cancelled);
        expect.soft(getTask(store.db, task.id).passId, state).toBeNull();
        expect.soft(lastTakeOut(store.db, task.id)?.step, state).toBe(TakeOutStep.Done);
      } finally {
        close();
      }
    }
  });
});
