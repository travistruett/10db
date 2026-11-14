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
  activeClaims,
  getBatch,
  getPass,
  getTask,
  getWorkstreamRow,
  listInbox,
  listSharedChanges,
  listTaskThreadRows,
  openHolds,
  schema,
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
  joinPass,
  keepTurnWork,
  keptRef,
  passFolderOn,
  putBackKeptWork,
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
  wrote: (): Promise<void> => Promise.resolve(),
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

  describe('with a page taken out and put back by Add Page, it still finishes', () => {
    /** Settings' turn edits its page; the page is taken out, then Add Page puts it back. */
    async function takenOutAndBack(): Promise<void> {
      w = await openPassWorld();
      const turn = w.startTurn(w.settings);
      w.write('src/settings/page.tsx', 'settings, the turn\n');
      await keepTurnWork(w.deps, { workstreamId: w.runOf(w.settings), turnId: turn.id });
      w.endTurn(turn);
      await takeOutSteps(deps(), { taskId: w.settings.id, within: TakeOutWithin.Alone });
      await joinPass(
        w.h.ctx,
        w.opened.pass.id,
        { pages: [], taskIds: [w.settings.id], firstMessage: null },
        { leaseMs: 60_000, putBack: (input) => putBackKeptWork(w.deps, input) },
      );
      expect(read('src/settings/page.tsx')).toBe('settings, the turn\n');
    }

    function expectBothOut(): void {
      const db = w.h.store.db;
      expect(getPass(db, w.opened.pass.id).state).toBe(PassState.Abandoned);
      for (const task of [w.settings, w.people]) {
        expect(getTask(db, task.id)).toMatchObject({ passId: null, status: 'open' });
        expect(getWorkstreamRow(db, w.runOf(task)).state).toBe(WorkstreamState.Cancelled);
      }
      expect(read('src/settings/page.tsx')).toBe('settings\n');
      expect(w.h.git$('show', `${keptRef(w.settings.id)}:src/settings/page.tsx`)).toBe(
        'settings, the turn',
      );
      expect(w.h.git$('symbolic-ref', '--short', 'HEAD')).toBe('main');
    }

    it.each([
      { name: 'in one daemon', restart: false },
      { name: 'after a restart', restart: true },
    ])('$name', async ({ restart }) => {
      await takenOutAndBack();
      const result = await abandonPass(deps(restart ? w.restart() : w.deps), w.opened.pass.id);
      expectBothOut();
      expect(result.reverted).toEqual(expect.arrayContaining([w.settings.id, w.people.id]));
    });

    it('when a restart finds the Abandon stopped at its take-outs', async () => {
      await takenOutAndBack();
      // Where an Abandon that failed on the page's earlier take-out left the pass.
      w.h.state.write((ctx) => {
        setAbandonStep(ctx, w.opened.pass.id, AbandonStep.Abandoning);
        setAbandonStep(ctx, w.opened.pass.id, AbandonStep.SharedDropped);
      });

      const restarted = deps(w.restart());
      await resumePassWork(restarted);
      await restarted.jobs.idle();

      expectBothOut();
    });
  });

  describe("with Your folder off the pass's branch, it still finishes", () => {
    const rows: {
      readonly name: string;
      /** A turn of Settings is open with a shared hold it has not kept. */
      readonly hold?: boolean;
      readonly run: (world: PassWorld) => Promise<void>;
    }[] = [
      {
        name: 'at once',
        run: async (world) => {
          await abandonPass(deps(world.deps), world.opened.pass.id);
        },
      },
      {
        name: 'with a shared hold its stopped turn left open',
        hold: true,
        run: async (world) => {
          await abandonPass(deps(world.deps), world.opened.pass.id);
        },
      },
      {
        name: 'after a restart cut it short',
        run: async (world) => {
          world.h.state.write((ctx) => {
            setAbandonStep(ctx, world.opened.pass.id, AbandonStep.Abandoning);
          });
          const restarted = deps(world.restart());
          await resumePassWork(restarted);
          await restarted.jobs.idle();
        },
      },
    ];
    it.each(rows)('$name', async ({ run, hold }) => {
      w = await worked();
      if (hold === true) {
        w.startTurn(w.settings);
        await grantSharedHold(w.deps, { workstreamId: w.runOf(w.settings), area: 'src' });
      }
      // The builder switched to the branch the pass came from, taking the pages' files along; the
      // pass's folder card says so.
      w.h.git$('switch', '-q', 'main');
      await passFolderOn(w.deps, w.opened.pass.id);

      await run(w);

      const db = w.h.store.db;
      expect(getPass(db, w.opened.pass.id).state).toBe(PassState.Abandoned);
      for (const task of [w.settings, w.people]) {
        expect(getTask(db, task.id)).toMatchObject({ passId: null, status: 'open' });
        expect(getWorkstreamRow(db, w.runOf(task)).state).toBe(WorkstreamState.Cancelled);
      }
      // No file is written on a branch the pass does not own: each stays as the builder has it.
      expect(read('src/settings/page.tsx')).toBe('edited before the pass\nand in the turn\n');
      expect(existsSync(join(w.h.repo, 'src/settings/old.tsx'))).toBe(false);
      expect(read('src/people/new.tsx')).toBe('added by People\n');
      // What the turn kept stays with its task.
      expect(w.h.git$('show', `${keptRef(w.settings.id)}:src/settings/page.tsx`)).toBe(
        'edited before the pass\nand in the turn',
      );
      expect(w.h.git$('symbolic-ref', '--short', 'HEAD')).toBe('main');
      // No hold stays open on an abandoned pass: one its turn left is let go, its files left as
      // they are.
      expect(openHolds(db, w.opened.pass.id)).toEqual([]);
      expect(activeClaims(db, w.runOf(w.settings))).toEqual([]);
      // An abandoned pass waits for no folder.
      expect(
        listInbox(db, { states: [InboxState.Open] }).filter(
          (item) => item.detail?.['passCard'] === 'folder',
        ),
      ).toEqual([]);
      expect(
        listTaskThreadRows(db, w.settings.id)
          .filter((m) => m.kind === 'notice')
          .map((m) => m.body),
      ).toContain(
        "Your folder was on main, not on the pass's branch, so the page's files were left as they are.",
      );
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

  it('keeps naming the files it left when a Move on its card is refused', async () => {
    w = await openPassWorld();
    // A page landed on the pass's branch, as a sign-off will, so the folder stays there.
    w.h.commit('src/settings/page.tsx', 'landed\n');
    w.write('src/people/page.tsx', 'people, by its page\n');
    let n = 0;
    const racing: Git = {
      ...w.deps.git,
      hashOnDisk: (repo, paths) => {
        n += 1;
        w.write('src/people/page.tsx', `written again (${String(n)})\n`);
        return w.deps.git.hashOnDisk(repo, paths);
      },
    };
    await abandonPass(deps(w.deps, racing), w.opened.pass.id);
    const [card] = abandonCards();
    if (!card) throw new Error('no Abandon card');
    const left = `- src/people/page.tsx (${w.people.title})`;
    expect(card.body).toContain(left);

    // An uncommitted edit lies where the switch writes, so the Move is refused.
    w.write('src/settings/page.tsx', 'an uncommitted edit\n');
    answerPassCard(w.deps, card, { choice: 'Move to main' });
    await w.h.jobs.idle();

    const [again] = abandonCards();
    expect(again?.body).toContain('10db could not move it');
    expect(again?.body).toContain(left);
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

    it('finishes past a hold that cannot be kept, letting it go', async () => {
      w = await openPassWorld();
      w.startTurn(w.settings);
      await grantSharedHold(w.deps, { workstreamId: w.runOf(w.settings), area: 'src' });
      w.write('src/button.ts', 'a button\n');
      w.h.store.db
        .update(schema.passHolds)
        .set({ recordSha: '0'.repeat(40) })
        .run();

      await abandonPass(deps(), w.opened.pass.id);

      expect(getPass(w.h.store.db, w.opened.pass.id).state).toBe(PassState.Abandoned);
      expect(openHolds(w.h.store.db, w.opened.pass.id)).toEqual([]);
    });

    it('names a change a take-out could not drop, which it dropped itself, and the file it left', async () => {
      w = await openPassWorld();
      await sharedTurn(w.settings, 'settings\n');
      // The builder edits the file after the Drop is chosen: the take-out keeps the change.
      w.write('src/shared.ts', "settings\nand the builder's edit\n");
      await takeOutSteps(deps(), {
        taskId: w.settings.id,
        within: TakeOutWithin.Alone,
        shared: [{ seq: 1, choice: 'drop' }],
      });

      const result = await abandonPass(deps(), w.opened.pass.id);

      expect(result.droppedShared).toEqual([{ seq: 1, paths: ['src/shared.ts'] }]);
      expect(result.left).toEqual([
        { path: 'src/shared.ts', page: `a shared change of ${w.settings.title}` },
      ]);
      expect(read('src/shared.ts')).toBe("settings\nand the builder's edit\n");
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
