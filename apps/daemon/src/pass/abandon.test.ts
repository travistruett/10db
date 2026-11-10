import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  AbandonStep,
  InboxState,
  PassState,
  WorkstreamState,
  type WorkstreamId,
} from '@10db/contracts';
import {
  getBatch,
  getPass,
  getTask,
  getWorkstreamRow,
  listInbox,
  listSharedChanges,
  setAbandonStep,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import { openPass } from '../delivery';
import type { Git } from '../git';
import {
  abandonPass,
  answerPassCard,
  closeHoldsOf,
  dropShared,
  grantSharedHold,
  keepTurnWork,
  keptRef,
  resumePassWork,
  takeOutSteps,
  TakeOutWithin,
  type PassWorkDeps,
} from './index';
import { abandonPassSteps } from './abandon';

// Workbench spec §5.4 (D23): Abandon Pass puts every unsigned page back to its state before the pass,
// keeps its work with its task, and ends the pass and its batch ABANDONED, going on from its recorded
// step after a restart; it always finishes.

let w: PassWorld;
afterEach(() => {
  w.close();
});

const read = (rel: string) => readFileSync(join(w.h.repo, rel), 'utf8');
const deps = (base: PassWorkDeps = w.deps, git: Git = base.git) => ({
  ...base,
  git,
  stopLane: (): Promise<void> => Promise.resolve(),
});
const abandonCards = () =>
  listInbox(w.h.store.db, { states: [InboxState.Open] }).filter(
    (item) => item.detail?.['passCard'] === 'abandon',
  );

/**
 * A pass on a folder whose Settings page and shared file were edited before it opened; Settings'
 * turn edits the page, deletes a file and, holding the shared area, edits the shared file further
 * and adds a button, and People's adds a page file.
 */
async function worked(): Promise<PassWorld> {
  const world = await openPassWorld({
    before: ({ write }) => {
      write('src/settings/page.tsx', 'edited before the pass\n');
      write('src/shared.ts', 'shared, edited before the pass\n');
    },
  });
  const turn = world.startTurn(world.settings);
  await grantSharedHold(world.deps, { workstreamId: world.runOf(world.settings), area: 'src' });
  world.write('src/settings/page.tsx', 'edited before the pass\nand in the turn\n');
  unlinkSync(join(world.h.repo, 'src/settings/old.tsx'));
  world.write('src/shared.ts', 'shared, edited before the pass\nand in the turn\n');
  world.write('src/button.ts', 'a shared button\n');
  await closeHoldsOf(world.deps, world.runOf(world.settings));
  await keepTurnWork(world.deps, { workstreamId: world.runOf(world.settings), turnId: turn.id });
  world.endTurn(turn);
  world.write('src/people/new.tsx', 'added by People\n');
  return world;
}

/** What a finished Abandon of `worked()` left, however many restarts it took. */
function expectAbandoned(world: PassWorld): void {
  const db = world.h.store.db;
  const { pass, batch } = world.opened;
  expect(getPass(db, pass.id)).toMatchObject({ state: PassState.Abandoned });
  expect(getBatch(db, batch.id).state).toBe('ABANDONED');
  // Every page is as it was before the pass, the earlier dirt included.
  expect(read('src/settings/page.tsx')).toBe('edited before the pass\n');
  expect(read('src/settings/old.tsx')).toBe('old\n');
  expect(existsSync(join(world.h.repo, 'src/people/new.tsx'))).toBe(false);
  // The shared change is dropped: its files are as its hold found them, the earlier edit included.
  expect(read('src/shared.ts')).toBe('shared, edited before the pass\n');
  expect(existsSync(join(world.h.repo, 'src/button.ts'))).toBe(false);
  expect(listSharedChanges(db, pass.id).map((c) => [c.seq, c.droppedBy, c.dropOf])).toEqual([
    [1, 2, null],
    [2, null, 1],
  ]);
  // Each page's work is kept with its task, which is back on the Board.
  expect(world.h.git$('show', `${keptRef(world.settings.id)}:src/settings/page.tsx`)).toBe(
    'edited before the pass\nand in the turn',
  );
  expect(world.h.git$('show', `${keptRef(world.people.id)}:src/people/new.tsx`)).toBe(
    'added by People',
  );
  for (const task of [world.settings, world.people]) {
    expect(getTask(db, task.id)).toMatchObject({ passId: null, status: 'open' });
    expect(getWorkstreamRow(db, world.runOf(task)).state).toBe(WorkstreamState.Cancelled);
  }
  // Nothing landed, so the folder is back where the pass came from.
  expect(world.h.git$('symbolic-ref', '--short', 'HEAD')).toBe('main');
}

describe('abandonPass', () => {
  it('puts every unsigned page back, keeps its work with its task, and ends ABANDONED with the folder home', async () => {
    w = await worked();
    const stopped: WorkstreamId[] = [];

    const result = await abandonPass(
      {
        ...deps(),
        stopLane: (id) => {
          stopped.push(id);
          return Promise.resolve();
        },
      },
      w.opened.pass.id,
    );

    expectAbandoned(w);
    expect(result).toEqual({
      reverted: [w.settings.id, w.people.id],
      stays: [],
      left: [],
      folder: { branch: 'main', returned: true },
      droppedShared: [{ seq: 1, paths: ['src/button.ts', 'src/shared.ts'] }],
      pullRequestLeftOpen: null,
    });
    expect(stopped).toEqual(expect.arrayContaining([w.runOf(w.settings), w.runOf(w.people)]));
    expect(abandonCards()).toEqual([]);
    // The built batch Abandon refuses the pass's batch, and a new pass opens on the folder.
    expect(() => w.h.shipper.abandon(w.opened.batch.id)).toThrow(/pass/i);
    const next = w.h.addTask('Settings: again', { areas: ['settings'] });
    const opened = await openPass(
      w.h.ctx,
      { projectId: w.h.project.id, name: 'Again', taskIds: [next.id] },
      { leaseMs: 60_000, putBack: () => Promise.resolve({ applied: [], left: [] }) },
    );
    expect(opened.pass.state).toBe(PassState.Open);
  });

  it('refuses the built batch Abandon on an open pass, changing nothing', async () => {
    w = await openPassWorld();
    expect(() => w.h.shipper.abandon(w.opened.batch.id)).toThrow(/pass/i);
    expect(getPass(w.h.store.db, w.opened.pass.id).state).toBe(PassState.Open);
    expect(getBatch(w.h.store.db, w.opened.batch.id).state).toBe('OPEN');
  });

  describe('a restart after each step goes on from the step it reached', () => {
    /** Dies at the `nth` call, as the daemon dying inside that call would. */
    const dying = <A extends unknown[], T>(nth: number, real: (...a: A) => Promise<T>) => {
      let n = 0;
      return (...a: A): Promise<T> => {
        n += 1;
        return n === nth ? Promise.reject(new Error('the daemon died')) : real(...a);
      };
    };
    const kills: {
      readonly name: string;
      readonly step: AbandonStep;
      readonly kill: (world: PassWorld) => Promise<void>;
    }[] = [
      {
        name: 'after it began',
        step: AbandonStep.Abandoning,
        kill: (world) => {
          world.h.state.write((ctx) => {
            setAbandonStep(ctx, world.opened.pass.id, AbandonStep.Abandoning);
          });
          return Promise.resolve();
        },
      },
      {
        name: 'while it stopped the sessions',
        step: AbandonStep.ShipAborted,
        kill: async (world) => {
          await expect(
            abandonPassSteps(
              { ...deps(world.deps), stopLane: dying(1, () => Promise.resolve()) },
              world.opened.pass.id,
            ),
          ).rejects.toThrow('the daemon died');
        },
      },
      {
        name: 'while it dropped a shared change',
        step: AbandonStep.SessionsStopped,
        kill: async (world) => {
          const git = world.deps.git;
          await expect(
            abandonPassSteps(
              deps(world.deps, {
                ...git,
                restoreFiles: dying(1, (...a: Parameters<Git['restoreFiles']>) =>
                  git.restoreFiles(...a),
                ),
              }),
              world.opened.pass.id,
            ),
          ).rejects.toThrow('the daemon died');
        },
      },
      {
        name: "between a shared drop's files and its row",
        step: AbandonStep.SessionsStopped,
        kill: async (world) => {
          const git = world.deps.git;
          await expect(
            abandonPassSteps(
              deps(world.deps, {
                ...git,
                chainCommit: dying(1, (...a: Parameters<Git['chainCommit']>) =>
                  git.chainCommit(...a),
                ),
              }),
              world.opened.pass.id,
            ),
          ).rejects.toThrow('the daemon died');
        },
      },
      {
        name: "during the first page's take-out",
        step: AbandonStep.SharedDropped,
        kill: async (world) => {
          const git = world.deps.git;
          await expect(
            abandonPassSteps(
              deps(world.deps, {
                ...git,
                pageChanges: dying(1, (...a: Parameters<Git['pageChanges']>) =>
                  git.pageChanges(...a),
                ),
              }),
              world.opened.pass.id,
            ),
          ).rejects.toThrow('the daemon died');
        },
      },
      {
        name: "during the second page's put-back",
        step: AbandonStep.SharedDropped,
        kill: async (world) => {
          const git = world.deps.git;
          await expect(
            abandonPassSteps(
              deps(world.deps, {
                ...git,
                // The first call puts the shared change back, the second the first page.
                restoreFiles: dying(3, (...a: Parameters<Git['restoreFiles']>) =>
                  git.restoreFiles(...a),
                ),
              }),
              world.opened.pass.id,
            ),
          ).rejects.toThrow('the daemon died');
        },
      },
      {
        name: 'after every page was taken out',
        step: AbandonStep.SignedOffKept,
        kill: async (world) => {
          const id = world.opened.pass.id;
          for (const step of [
            AbandonStep.Abandoning,
            AbandonStep.ShipAborted,
            AbandonStep.SessionsStopped,
          ])
            world.h.state.write((ctx) => {
              setAbandonStep(ctx, id, step);
            });
          await dropShared(world.deps, { passId: id, seq: 1, force: true });
          world.h.state.write((ctx) => {
            setAbandonStep(ctx, id, AbandonStep.SharedDropped);
          });
          for (const task of [world.settings, world.people])
            await takeOutSteps(deps(world.deps), {
              taskId: task.id,
              within: TakeOutWithin.Abandon,
            });
          for (const step of [AbandonStep.PagesTakenOut, AbandonStep.SignedOffKept])
            world.h.state.write((ctx) => {
              setAbandonStep(ctx, id, step);
            });
        },
      },
      {
        name: 'before the folder went home',
        step: AbandonStep.Abandoned,
        kill: async (world) => {
          const git = world.deps.git;
          await expect(
            abandonPassSteps(
              deps(world.deps, {
                ...git,
                pointHeadAt: dying(1, (...a: Parameters<Git['pointHeadAt']>) =>
                  git.pointHeadAt(...a),
                ),
              }),
              world.opened.pass.id,
            ),
          ).rejects.toThrow('the daemon died');
        },
      },
    ];
    it.each(kills)('$name', async ({ kill, step }) => {
      w = await worked();
      await kill(w);
      expect(getPass(w.h.store.db, w.opened.pass.id).state).not.toBe(PassState.Open);
      expect(
        w.h.store.db.$client
          .prepare('select abandon_step as step from passes where id = ?')
          .get(w.opened.pass.id),
      ).toEqual({ step });

      // A daemon started again on the same database goes on with the Abandon by itself.
      const restarted = deps(w.restart());
      await resumePassWork(restarted);
      await restarted.jobs.idle();

      expectAbandoned(w);
      expect(getPass(w.h.store.db, w.opened.pass.id)).toMatchObject({ state: PassState.Abandoned });
    });
  });

  it('leaves the folder on the branch that holds landed work, with a card whose answer moves it home', async () => {
    w = await openPassWorld();
    // A page landed on the pass's branch, as a sign-off will.
    w.h.commit('src/settings/page.tsx', 'landed\n');
    w.write('src/people/page.tsx', 'people, by its page\n');

    const result = await abandonPass(deps(), w.opened.pass.id);

    expect(result.folder).toEqual({ branch: w.branch, returned: false });
    expect(w.h.git$('symbolic-ref', '--short', 'HEAD')).toBe(w.branch);
    expect(read('src/people/page.tsx')).toBe('people\n');
    const [card] = abandonCards();
    if (!card) throw new Error('no Abandon card');
    expect(card.body).toContain(`Your folder stays on ${w.branch}`);
    expect(card.options.map((o) => o.label)).toEqual(['Move to main']);

    w.write('src/shared.ts', 'an uncommitted edit\n');
    answerPassCard(w.deps, card, { choice: 'Move to main' });
    await w.h.jobs.idle();

    expect(w.h.git$('symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(read('src/settings/page.tsx')).toBe('settings\n');
    expect(read('src/shared.ts')).toBe('an uncommitted edit\n');
    expect(abandonCards()).toEqual([]);
  });

  it('finishes when a page keeps changing, leaving its files and naming them on the card with the page', async () => {
    w = await worked();
    let n = 0;
    const racing: Git = {
      ...w.deps.git,
      hashOnDisk: (repo, paths) => {
        n += 1;
        w.write('src/settings/page.tsx', `written again (${String(n)})\n`);
        return w.deps.git.hashOnDisk(repo, paths);
      },
    };

    const result = await abandonPass(deps(w.deps, racing), w.opened.pass.id);

    expect(getPass(w.h.store.db, w.opened.pass.id).state).toBe(PassState.Abandoned);
    expect(result.left).toEqual([{ path: 'src/settings/page.tsx', page: w.settings.title }]);
    expect(read('src/settings/page.tsx')).toMatch(/^written again/);
    expect(read('src/settings/old.tsx')).toBe('old\n');
    expect(getTask(w.h.store.db, w.settings.id).passId).toBeNull();
    const [card] = abandonCards();
    expect(card?.body).toContain(`- src/settings/page.tsx (${w.settings.title})`);
  });

  describe('the shared changes it names', () => {
    /** `task` holds `src` for a turn that writes `src/shared.ts` as `content`. */
    async function sharedTurn(task: PassWorld['settings'], content: string): Promise<void> {
      w.startTurn(task);
      await grantSharedHold(w.deps, { workstreamId: w.runOf(task), area: 'src' });
      w.write('src/shared.ts', content);
      await closeHoldsOf(w.deps, w.runOf(task));
    }

    it('names no file left when two changes to one file are both put back', async () => {
      w = await openPassWorld();
      await sharedTurn(w.settings, 'settings\n');
      await sharedTurn(w.people, 'settings\npeople\n');

      const result = await abandonPass(deps(), w.opened.pass.id);

      expect(read('src/shared.ts')).toBe('shared\n');
      expect(result.left).toEqual([]);
      expect(result.droppedShared).toEqual([
        { seq: 2, paths: ['src/shared.ts'] },
        { seq: 1, paths: ['src/shared.ts'] },
      ]);
    });

    it('leaves out a drop an earlier take-out made', async () => {
      w = await openPassWorld();
      await sharedTurn(w.settings, 'settings\n');
      await takeOutSteps(deps(), {
        taskId: w.settings.id,
        within: TakeOutWithin.Alone,
        shared: [{ seq: 1, choice: 'drop' }],
      });
      w.write('src/shared.ts', "the builder's own edit since\n");

      const result = await abandonPass(deps(), w.opened.pass.id);

      expect(result.droppedShared).toEqual([]);
      expect(result.left).toEqual([]);
    });
  });
});
