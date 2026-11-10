import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { AbandonStep } from '@10db/contracts';
import {
  abandonPassAndBatch,
  getTask,
  getTaskKeptWork,
  listTaskThreadRows,
  setAbandonStep,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import { openPass } from '../delivery';
import {
  foldHandEdits,
  keepTurnWork,
  keptRef,
  putBackKeptWork,
  takeOutSteps,
  TakeOutWithin,
} from './index';

// Workbench spec §5.4: a later pass that takes a taken-out task puts its kept work back file by file:
// a file still as the take-out left it takes the kept version, any other merges three ways, and one
// that does not merge is left and named on the thread.

let w: PassWorld;
afterEach(() => {
  w.close();
});

const stopLane = (): Promise<void> => Promise.resolve();
const read = (rel: string) => readFileSync(join(w.h.repo, rel), 'utf8');
const lastNotice = () =>
  listTaskThreadRows(w.h.store.db, w.settings.id)
    .filter((m) => m.kind === 'notice')
    .at(-1)?.body;

/** Settings worked a turn (its page edited in a block of lines, a file added, one deleted), then taken out. */
async function takenOut(): Promise<void> {
  w = await openPassWorld();
  w.h.commit('src/settings/long.tsx', 'one\ntwo\nthree\nfour\nfive\nsix\n');
  const turn = w.startTurn(w.settings);
  w.write('src/settings/long.tsx', 'one\ntwo, by the task\nthree\nfour\nfive\nsix\n');
  w.write('src/settings/new.tsx', 'added by the task\n');
  unlinkSync(join(w.h.repo, 'src/settings/old.tsx'));
  await keepTurnWork(w.deps, { workstreamId: w.runOf(w.settings), turnId: turn.id });
  w.endTurn(turn);
  await takeOutSteps(
    { ...w.deps, stopLane },
    { taskId: w.settings.id, within: TakeOutWithin.Alone },
  );
  expect(read('src/settings/long.tsx')).toBe('one\ntwo\nthree\nfour\nfive\nsix\n');
}

const putBack = () => putBackKeptWork(w.deps, { repo: w.h.repo, taskId: w.settings.id });

describe('putBackKeptWork', () => {
  it('gives each file still as the take-out left it the kept version', async () => {
    await takenOut();
    expect(await putBack()).toEqual({
      applied: ['src/settings/long.tsx', 'src/settings/new.tsx', 'src/settings/old.tsx'],
      left: [],
    });
    expect(read('src/settings/long.tsx')).toBe('one\ntwo, by the task\nthree\nfour\nfive\nsix\n');
    expect(read('src/settings/new.tsx')).toBe('added by the task\n');
    expect(existsSync(join(w.h.repo, 'src/settings/old.tsx'))).toBe(false);
    // The work is in the folder now; its ref stays until it lands.
    expect(getTaskKeptWork(w.h.store.db, w.settings.id)).toBeNull();
    expect(w.h.git$('for-each-ref', keptRef(w.settings.id))).not.toBe('');
    expect(lastNotice()).toBe('Put back its saved Workbench work: 3 files.');
  });

  it('merges a file changed since three ways, and names one that does not merge', async () => {
    await takenOut();
    w.write('src/settings/long.tsx', 'one\ntwo\nthree\nfour\nfive\nsix, edited since\n');
    w.write('src/settings/new.tsx', 'the builder made this file too\n');

    expect(await putBack()).toEqual({
      applied: ['src/settings/long.tsx', 'src/settings/old.tsx'],
      left: ['src/settings/new.tsx'],
    });
    expect(read('src/settings/long.tsx')).toBe(
      'one\ntwo, by the task\nthree\nfour\nfive\nsix, edited since\n',
    );
    expect(read('src/settings/new.tsx')).toBe('the builder made this file too\n');
    expect(lastNotice()).toBe(
      'Put back its saved Workbench work: 2 files.\n' +
        'Left as they are, because the saved work does not merge with them:\n' +
        '- src/settings/new.tsx',
    );
  });

  it('runs when a later pass takes the task', async () => {
    await takenOut();
    await takeOutSteps(
      { ...w.deps, stopLane },
      { taskId: w.people.id, within: TakeOutWithin.Alone },
    );
    w.h.state.write((ctx) => {
      setAbandonStep(ctx, w.opened.pass.id, AbandonStep.Abandoning);
      abandonPassAndBatch(ctx, w.opened.pass.id);
    });
    // The folder goes home with what landed on the pass's branch, as a close's fast-forward leaves it.
    w.h.git$('branch', '-f', 'main', 'HEAD');
    w.h.git$('switch', '-q', 'main');

    await openPass(
      w.h.ctx,
      { projectId: w.h.project.id, name: 'Again', taskIds: [w.settings.id] },
      {
        leaseMs: 60_000,
        putBack: (input) => putBackKeptWork(w.deps, input),
      },
    );
    expect(read('src/settings/long.tsx')).toBe('one\ntwo, by the task\nthree\nfour\nfive\nsix\n');
    expect(getTaskKeptWork(w.h.store.db, w.settings.id)).toBeNull();
    // What went back is the task's own work, kept with it in the new pass: never a hand edit.
    const run = getTask(w.h.store.db, w.settings.id).workstreamId;
    if (run === null) throw new Error('Settings has no run in the new pass');
    expect(await foldHandEdits(w.deps, { workstreamId: run })).toMatchObject({
      byHand: [],
      whileWorking: null,
    });
  });
});
