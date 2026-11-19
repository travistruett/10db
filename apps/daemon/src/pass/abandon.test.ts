import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  AbandonStep,
  ConversationOwnerKind,
  ConversationProfile,
  ConversationState,
  InboxState,
  mintId,
  PassState,
  WorkstreamState,
  type WorkstreamId,
} from '@10db/contracts';
import {
  activeClaims,
  getBatch,
  getBatchRow,
  getPass,
  getTask,
  getTaskKeptWork,
  getWorkstreamRow,
  insertChat,
  insertConversation,
  insertPassPageTask,
  insertTask,
  joinPass as joinPassRows,
  lastTakeOut,
  listInbox,
  listSharedChanges,
  listTasks,
  listTaskThreadRows,
  markTasksMadeByPass,
  openHolds,
  schema,
  setAbandonStep,
  setTaskKeptWork,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from '../../test/fixtures';
import { openPassWorld, openWholeProjectWorld, type PassWorld } from '../../test/pass-world';
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
// deletes its changes, and ends the pass and its batch ABANDONED, going on from its recorded step
// after a restart; it always finishes.

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
/** What an Abandon with no Move to offer says: a notice, never a card. */
const abandonNotices = () =>
  w.h.notices().filter((n) => n.key === `pass-abandon:${w.opened.pass.id}`);
const abandonCards = () =>
  listInbox(w.h.store.db, { states: [InboxState.Open] }).filter(
    (item) => item.detail?.['passCard'] === 'abandon',
  );

/** No saved work is left for the task: no kept ref, in the pass or on the Board, and no kept columns. */
function expectNoKeptWork(world: PassWorld, task: PassWorld['settings'], label = ''): void {
  for (const ref of [keptRef(task.id), `refs/10db/passes/${world.opened.pass.id}/${task.id}`])
    expect.soft(world.h.git$('for-each-ref', '--format=%(refname)', ref), label).toBe('');
  expect.soft(getTaskKeptWork(world.h.store.db, task.id), label).toBeNull();
  expect.soft(getTask(world.h.store.db, task.id).keptWork, label).toBe(false);
}

/**
 * Settings, which joined from the Board, is back on it open and its thread says its changes went;
 * People, the task the pass made for its page, is cancelled and off the Board. Neither keeps any work.
 */
function expectBoardAfter(world: PassWorld, label = ''): void {
  const db = world.h.store.db;
  for (const task of [world.settings, world.people]) {
    expectNoKeptWork(world, task, label);
    expect
      .soft(getWorkstreamRow(db, world.runOf(task)).state, label)
      .toBe(WorkstreamState.Cancelled);
  }
  expect
    .soft(getTask(db, world.settings.id), label)
    .toMatchObject({ passId: null, status: 'open' });
  expect
    .soft(getTask(db, world.people.id), label)
    .toMatchObject({ passId: null, status: 'cancelled' });
  const onBoard = listTasks(db, world.h.project.id).map((t) => t.id);
  expect.soft(onBoard, label).toContain(world.settings.id);
  expect.soft(onBoard, label).not.toContain(world.people.id);
  expect
    .soft(
      listTaskThreadRows(db, world.settings.id)
        .filter((m) => m.kind === 'notice')
        .map((m) => m.body),
      label,
    )
    .toContain('Abandoned with Polish; its changes were deleted.');
}

/**
 * A pass on a folder whose Settings page and shared file were edited before it opened, Settings a
 * Board task that joined it and People a page the pass made its task for; Settings' turn edits the
 * page, deletes a file and, holding the shared area, edits the shared file further and adds a
 * button, and People's adds a page file.
 */
async function worked(): Promise<PassWorld> {
  const world = await openPassWorld({
    peopleByPass: true,
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
function expectAbandoned(world: PassWorld, label = ''): void {
  const db = world.h.store.db;
  const { pass, batch } = world.opened;
  expect.soft(getPass(db, pass.id), label).toMatchObject({ state: PassState.Abandoned });
  expect.soft(getBatch(db, batch.id).state, label).toBe('ABANDONED');
  // Every page is as it was before the pass, the earlier dirt included.
  expect.soft(read('src/settings/page.tsx'), label).toBe('edited before the pass\n');
  expect.soft(read('src/settings/old.tsx'), label).toBe('old\n');
  expect.soft(existsSync(join(world.h.repo, 'src/people/new.tsx')), label).toBe(false);
  // The shared change is dropped: its files are as its hold found them, the earlier edit included.
  expect.soft(read('src/shared.ts'), label).toBe('shared, edited before the pass\n');
  expect.soft(existsSync(join(world.h.repo, 'src/button.ts')), label).toBe(false);
  expect
    .soft(
      listSharedChanges(db, pass.id).map((c) => [c.seq, c.droppedBy, c.dropOf]),
      label,
    )
    .toEqual([
      [1, 2, null],
      [2, null, 1],
    ]);
  // Each page's changes are deleted: the joined task is back on the Board, the one the pass made gone.
  expectBoardAfter(world, label);
  // Nothing landed, so the folder is back where the pass came from.
  expect.soft(world.h.git$('symbolic-ref', '--short', 'HEAD'), label).toBe('main');
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

  it('refuses the built batch Abandon on an open pass, changing nothing, then retires a page the pass made before it had a run, and takes a Board task with none out open, its saved work deleted', async () => {
    w = await openPassWorld();
    const pass = w.opened.pass.id;
    expect(() => w.h.shipper.abandon(w.opened.batch.id)).toThrow(/pass/i);
    expect(getPass(w.h.store.db, pass).state).toBe(PassState.Open);
    expect(getBatch(w.h.store.db, w.opened.batch.id).state).toBe('OPEN');

    const { made, joined } = w.h.state.write((ctx) => {
      const page = insertPassPageTask(ctx, w.h.project.id, {
        title: 'Settings: more UI work',
        area: 'settings',
        goalId: null,
      });
      const board = insertTask(ctx, w.h.project.id, {
        title: 'People: copy',
        acceptanceCriteria: ['ok'],
        areas: ['people'],
      });
      // The Board task carries saved work from an earlier pass into this one.
      setTaskKeptWork(ctx, board.id, {
        keptSha: w.opened.pass.startSha,
        keptBaseSha: w.opened.pass.startSha,
      });
      joinPassRows(ctx, pass, [page.id, board.id]);
      markTasksMadeByPass(ctx, pass, [page.id]);
      return { made: page, joined: board };
    });
    w.h.git$('update-ref', keptRef(joined.id), w.opened.pass.startSha);

    await abandonPass(deps(), pass);

    const db = w.h.store.db;
    expect(getTask(db, made.id)).toMatchObject({ passId: null, status: 'cancelled' });
    expect(getTask(db, joined.id)).toMatchObject({ passId: null, status: 'open' });
    expectNoKeptWork(w, joined);
    expect(
      listTaskThreadRows(db, joined.id)
        .filter((m) => m.kind === 'notice')
        .map((m) => m.body),
    ).toContain('Abandoned with Polish; its changes were deleted.');
    expect(listTasks(db, w.h.project.id).map((t) => t.id)).not.toContain(made.id);
  });

  describe('a restart after each step', () => {
    /** Dies at the `nth` call, as the daemon dying inside that call would. */
    const dying = <A extends unknown[], T>(nth: number, real: (...a: A) => Promise<T>) => {
      let n = 0;
      return (...a: A): Promise<T> => {
        n += 1;
        return n === nth ? Promise.reject(new Error('the daemon died')) : real(...a);
      };
    };
    /** Dies just after the `nth` call has done its work, before its caller goes on. */
    const dyingAfter = <A extends unknown[], T>(nth: number, real: (...a: A) => Promise<T>) => {
      let n = 0;
      return async (...a: A): Promise<T> => {
        n += 1;
        const done = await real(...a);
        if (n === nth) throw new Error('the daemon died');
        return done;
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
        name: "at a page's first kept-ref delete, before anything of it is deleted",
        step: AbandonStep.SharedDropped,
        kill: async (world) => {
          const git = world.deps.git;
          await expect(
            abandonPassSteps(
              deps(world.deps, {
                ...git,
                deleteKeptRef: dying(1, (...a: Parameters<Git['deleteKeptRef']>) =>
                  git.deleteKeptRef(...a),
                ),
              }),
              world.opened.pass.id,
            ),
          ).rejects.toThrow('the daemon died');
        },
      },
      {
        name: "after a page's kept refs were deleted and their commit pruned, before its row was written",
        step: AbandonStep.SharedDropped,
        kill: async (world) => {
          const git = world.deps.git;
          await expect(
            abandonPassSteps(
              deps(world.deps, {
                ...git,
                // The pass's ref and then the Board's go, and the daemon dies with the row unwritten.
                deleteKeptRef: dyingAfter(2, (...a: Parameters<Git['deleteKeptRef']>) =>
                  git.deleteKeptRef(...a),
                ),
              }),
              world.opened.pass.id,
            ),
          ).rejects.toThrow('the daemon died');
          // Nothing names the deleted commit any more, so git may drop it before the restart.
          const kept = lastTakeOut(world.h.store.db, world.settings.id)?.keptSha;
          if (kept == null) throw new Error('the take-out kept nothing');
          world.h.git$('reflog', 'expire', '--expire=now', '--all');
          world.h.git$('gc', '--prune=now', '--quiet');
          expect(() => world.h.git$('cat-file', '-e', `${kept}^{commit}`)).toThrow();
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
    // A world per kill point.
    it(
      'goes on from the step it reached, wherever the daemon died',
      { timeout: 600_000 },
      async () => {
        for (const [at, { name, kill, step }] of kills.entries()) {
          if (at > 0) w.close();
          w = await worked();
          await kill(w);
          expect.soft(getPass(w.h.store.db, w.opened.pass.id).state, name).not.toBe(PassState.Open);
          expect
            .soft(
              w.h.store.db.$client
                .prepare('select abandon_step as step from passes where id = ?')
                .get(w.opened.pass.id),
              name,
            )
            .toEqual({ step });

          // A daemon started again on the same database goes on with the Abandon by itself.
          const restarted = deps(w.restart());
          await resumePassWork(restarted);
          await restarted.jobs.idle();

          expectAbandoned(w, name);
          expect
            .soft(getPass(w.h.store.db, w.opened.pass.id), name)
            .toMatchObject({ state: PassState.Abandoned });
        }
      },
    );
  });

  // A world per way the Abandon runs.
  it(
    'still finishes with a page taken out and put back by Add Page, in one daemon, after a restart, or when a restart finds it stopped at its take-outs',
    { timeout: 300_000 },
    async () => {
      const runs: {
        readonly name: string;
        readonly run: () => Promise<void>;
      }[] = [
        {
          name: 'in one daemon',
          run: async () => {
            const result = await abandonPass(deps(w.deps), w.opened.pass.id);
            expect
              .soft(result.reverted, 'in one daemon')
              .toEqual(expect.arrayContaining([w.settings.id, w.people.id]));
          },
        },
        {
          name: 'after a restart',
          run: async () => {
            const result = await abandonPass(deps(w.restart()), w.opened.pass.id);
            expect
              .soft(result.reverted, 'after a restart')
              .toEqual(expect.arrayContaining([w.settings.id, w.people.id]));
          },
        },
        {
          name: 'when a restart finds the Abandon stopped at its take-outs',
          run: async () => {
            // Where an Abandon that failed on the page's earlier take-out left the pass.
            w.h.state.write((ctx) => {
              setAbandonStep(ctx, w.opened.pass.id, AbandonStep.Abandoning);
              setAbandonStep(ctx, w.opened.pass.id, AbandonStep.SharedDropped);
            });
            const restarted = deps(w.restart());
            await resumePassWork(restarted);
            await restarted.jobs.idle();
          },
        },
      ];
      for (const [at, { name, run }] of runs.entries()) {
        if (at > 0) w.close();
        // Settings' turn edits its page; the page is taken out, then Add Page puts it back.
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
        expect(read('src/settings/page.tsx'), name).toBe('settings, the turn\n');

        await run();

        const db = w.h.store.db;
        expect.soft(getPass(db, w.opened.pass.id).state, name).toBe(PassState.Abandoned);
        for (const task of [w.settings, w.people]) {
          expect.soft(getTask(db, task.id), name).toMatchObject({ passId: null, status: 'open' });
          expect
            .soft(getWorkstreamRow(db, w.runOf(task)).state, name)
            .toBe(WorkstreamState.Cancelled);
        }
        expect.soft(read('src/settings/page.tsx'), name).toBe('settings\n');
        // The saved work it carried back in is deleted with the pass's changes.
        expectNoKeptWork(w, w.settings, name);
        expect.soft(w.h.git$('symbolic-ref', '--short', 'HEAD'), name).toBe('main');
      }
    },
  );

  // A world per way the Abandon runs.
  it(
    "still finishes with Your folder off the pass's branch: at once, with a shared hold its stopped turn left open, and after a restart cut it short",
    { timeout: 300_000 },
    async () => {
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
      for (const [at, { name, run, hold }] of rows.entries()) {
        if (at > 0) w.close();
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
        expect.soft(getPass(db, w.opened.pass.id).state, name).toBe(PassState.Abandoned);
        expectBoardAfter(w, name);
        // No file is written on a branch the pass does not own: each stays as the builder has it.
        expect
          .soft(read('src/settings/page.tsx'), name)
          .toBe('edited before the pass\nand in the turn\n');
        expect.soft(existsSync(join(w.h.repo, 'src/settings/old.tsx')), name).toBe(false);
        expect.soft(read('src/people/new.tsx'), name).toBe('added by People\n');
        // The pass's changes are deleted: only the files the builder took along hold them.
        expect.soft(w.h.git$('symbolic-ref', '--short', 'HEAD'), name).toBe('main');
        // No hold stays open on an abandoned pass: one its turn left is let go, its files left as
        // they are.
        expect.soft(openHolds(db, w.opened.pass.id), name).toEqual([]);
        expect.soft(activeClaims(db, w.runOf(w.settings)), name).toEqual([]);
        // An abandoned pass waits for no folder.
        expect
          .soft(
            listInbox(db, { states: [InboxState.Open] }).filter(
              (item) => item.detail?.['passCard'] === 'folder',
            ),
            name,
          )
          .toEqual([]);
        expect
          .soft(
            listTaskThreadRows(db, w.settings.id)
              .filter((m) => m.kind === 'notice')
              .map((m) => m.body),
            name,
          )
          .toContain(
            "Your folder was on main, not on the pass's branch, so the page's files were left as they are.",
          );
      }
    },
  );

  it('abandons a pass of one: the uncommitted file is back as it was, its task is retired and the card says "Whole project"', async () => {
    const one = await openWholeProjectWorld({
      before: ({ write }) => {
        write('notes.md', 'before the pass\n');
      },
    });
    w = one;
    one.startTurn(one.task);
    one.h.commit('src/landed.ts', 'landed\n');
    one.write('notes.md', 'before the pass\nand in the turn\n');
    one.write('src/a.ts', 'a\n');

    const result = await abandonPass(deps(), one.opened.pass.id);

    expect(result.folder).toEqual({ branch: one.branch, returned: false });
    expect(read('notes.md')).toBe('before the pass\n');
    expect(existsSync(join(one.h.repo, 'src/a.ts'))).toBe(false);
    expect(getTask(one.h.store.db, one.task.id)).toMatchObject({
      passId: null,
      status: 'cancelled',
    });
    const [card] = abandonCards();
    if (!card) throw new Error('no Abandon card');
    expect(card.body).toContain('Discards: Whole project (their changes are deleted).');
  });

  it('leaves the folder on the branch that holds landed work, with a card whose answer waits for a chat’s turn and then moves it home', async () => {
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
    // It names the pages whose changes it deleted, as its confirm did, by their labels.
    expect(card.body).toContain('Discards: Settings, People (their changes are deleted).');
    expect(card.options.map((o) => o.label)).toEqual(['Move to main']);

    w.write('src/shared.ts', 'an uncommitted edit\n');
    const me = w.h.state.write((ctx) => {
      const id = mintId('Chat');
      const conv = insertConversation(ctx, {
        projectId: w.h.project.id,
        owner: { kind: ConversationOwnerKind.Chat, id },
        profile: ConversationProfile.Explore,
        state: ConversationState.IdleCold,
      });
      return insertChat(ctx, {
        id,
        projectId: w.h.project.id,
        conversationId: conv.id,
        title: 'Retry login',
        tabPosition: 0,
      }).id;
    });
    w.h.ctx.folderHold.takeTurn(w.h.project.id, me);

    answerPassCard({ ...w.deps, folderHold: w.h.ctx.folderHold }, card, { choice: 'Move to main' });
    // The Move says it waits, naming the chat, before it has switched anything.
    const waiting = await waitFor(
      () =>
        getBatchRow(w.h.store.db, w.opened.batch.id).notices.find((n) => n.key === 'folder-hold')
          ?.line,
    );
    expect(waiting).toBe('Waits for the chat ‘Retry login’ to finish with Your folder');
    expect(w.h.git$('symbolic-ref', '--short', 'HEAD')).toBe(w.branch);

    w.h.ctx.folderHold.releaseTurn(me);
    await w.h.jobs.idle();
    expect(w.h.git$('symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(w.h.ctx.folderHold.holders(w.h.project.id)).toEqual([]);
    expect(read('src/settings/page.tsx')).toBe('settings\n');
    expect(read('src/shared.ts')).toBe('an uncommitted edit\n');
    expect(abandonCards()).toEqual([]);
  });

  it('names on its card only the pages it discarded, not one taken out before it, whose work stays', async () => {
    w = await openPassWorld();
    w.h.commit('src/shared.ts', 'landed\n');
    const turn = w.startTurn(w.settings);
    w.write('src/settings/page.tsx', 'settings, the turn\n');
    await keepTurnWork(w.deps, { workstreamId: w.runOf(w.settings), turnId: turn.id });
    w.endTurn(turn);
    await takeOutSteps(deps(), { taskId: w.settings.id, within: TakeOutWithin.Alone });

    await abandonPass(deps(), w.opened.pass.id);

    const [card] = abandonCards();
    if (!card) throw new Error('no Abandon card');
    expect(card.body).toContain('Discards: People (their changes are deleted).');
    expect(card.body).not.toContain('Settings');
    expect(w.h.git$('show', `${keptRef(w.settings.id)}:src/settings/page.tsx`)).toBe(
      'settings, the turn',
    );
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
    expect(abandonCards()).toEqual([]);
    const notice = w.h.only(abandonNotices());
    expect(notice).toMatchObject({ tone: 'info', taskId: null });
    expect(notice.body).toContain(`- src/settings/page.tsx (${w.settings.title})`);
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
