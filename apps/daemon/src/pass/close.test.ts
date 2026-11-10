import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PassClosePageChoice,
  SharedChoiceKind,
  type PassCloseRequest,
  type ProjectInput,
  type TaskDto,
} from '@10db/contracts';
import {
  findOpenByFoldKey,
  getBatch,
  getPass,
  getPassChecks,
  getPassProgress,
  getProject,
  getTask,
  getWorkstreamRow,
  openHolds,
  patchProject,
  schema,
  setClosePlan,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from '../../test/fixtures';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import { createPassPullRequests, passGateKind, type PassPullRequests } from '../delivery';
import { silentLogger } from '../log';
import { systemProcesses } from '../recovery';
import { createGateRunner } from '../verify';
import {
  closeSteps,
  createPassCloses,
  gateFailedKey,
  type CloseDeps,
  type CloseShip,
} from './close';
import { closeGateOf } from './close-lists';
import { folderCardOpen } from './folder';
import { grantSharedHold, keepHold, keepTurnWork, startAbandon, type PassWorkDeps } from './index';

// Workbench spec §5.4, §5.5, §12: Close Pass signs off the pages set to it, lands what is kept, gates,
// takes the other pages out, pushes, fast-forwards the folder's branch and closes, step by recorded
// step; a failed gate reopens the pass, and an Abandon takes a closing pass over.

const stopped = (): Promise<void> => Promise.resolve();

let w: PassWorld;
let prs: PassPullRequests | null = null;
afterEach(async () => {
  await prs?.stop();
  prs = null;
  w.close();
});

async function world(project: Partial<ProjectInput>) {
  w = await openPassWorld({
    project,
    before: ({ write }) => {
      write('notes.md', 'dirt from before the pass\n');
    },
  });
}

/** The close's deps on `base`, with 7b's real ship over the harness and its fake gh. */
function closeDeps(base: PassWorkDeps = w.deps): CloseDeps {
  prs = createPassPullRequests({
    ...w.h.ctx,
    state: base.state,
    gate: createGateRunner({ sandbox: null, logger: silentLogger }),
    dataDir: w.h.dataDir,
    sessionEnv: () => ({ PATH: '/usr/bin:/bin' }),
    identifyProcess: (pid) => systemProcesses.identify(pid),
    review: null,
  });
  return {
    ...base,
    stopLane: stopped,
    wrote: stopped,
    ship: prs,
    gateWhere: (pass) => closeGateOf(passGateKind(getProject(base.state.db, pass.projectId))),
  };
}

/** Settings and People each take a turn that writes their page, kept as a turn's end keeps it. */
async function twoTurns(): Promise<void> {
  for (const [task, path] of [
    [w.settings, 'src/settings/page.tsx'],
    [w.people, 'src/people/page.tsx'],
  ] as const) {
    const turn = w.startTurn(task);
    w.write(path, `${task.title} work\n`);
    w.endTurn(turn);
    await keepTurnWork(w.deps, { workstreamId: w.runOf(task), turnId: turn.id });
  }
}

/** `task` takes a turn holding `src`, in which `path` is written, kept as a turn's end keeps it. */
async function sharedTurn(task: TaskDto, path: string): Promise<void> {
  const turn = w.startTurn(task);
  const granted = await grantSharedHold(w.deps, { workstreamId: w.runOf(task), area: 'src' });
  if (!granted?.ok) throw new Error('src was not granted');
  w.write(path, `${task.title} shared\n`);
  for (const hold of openHolds(w.h.store.db, w.opened.pass.id))
    await keepHold(w.deps, { claimId: hold.claimId });
  w.endTurn(turn);
  await keepTurnWork(w.deps, { workstreamId: w.runOf(task), turnId: turn.id });
}

/** Close Pass confirmed on the lists as shown: Settings signed off, People taken out. */
async function confirm(
  deps: CloseDeps,
  files: PassCloseRequest['files'] = [],
  shared: PassCloseRequest['shared'] = [],
) {
  const closes = createPassCloses(deps);
  const shown = await closes.preview(w.opened.pass.id);
  const answer = await closes.close(w.opened.pass.id, {
    token: shown.token,
    pages: [
      { taskId: w.settings.id, choice: PassClosePageChoice.SignOff },
      { taskId: w.people.id, choice: PassClosePageChoice.TakeOut },
    ],
    files,
    shared,
  });
  expect(answer.outcome).toBe('closing');
  await w.h.jobs.idle();
  return closes;
}

const passState = () => getPass(w.h.store.db, w.opened.pass.id).state;
const batchState = () => getBatch(w.h.store.db, w.opened.pass.batchId).state;
const read = (path: string) => readFileSync(join(w.h.repo, path), 'utf8');
const landed = () =>
  w.h
    .git$('log', '--reverse', '--format=%s', `${w.opened.pass.startSha}..${w.branch}`)
    .split('\n')
    .filter(Boolean);

describe('Close Pass', () => {
  it('closes a dirty folder: signs off, places, takes out, pushes, fast-forwards, and writes no other file', async () => {
    await world({ gateCommand: 'true' });
    await twoTurns();
    w.write('docs/new.md', 'a file no page owns\n');

    await confirm(closeDeps(), [
      { path: 'docs/new.md', placeIn: w.settings.id },
      { path: 'notes.md', placeIn: null },
    ]);

    expect(passState()).toBe('CLOSED');
    expect(batchState()).toBe('SHIPPED');
    expect(landed()).toEqual(['Settings: UI work', 'Settings: UI work: docs/new.md']);
    const tip = w.h.git$('rev-parse', w.branch);
    // D8: the branch the folder came from is at the pass's tip, and the folder is back on it.
    expect(w.h.git$('rev-parse', 'main')).toBe(tip);
    expect(w.h.git$('symbolic-ref', '--short', 'HEAD')).toBe('main');
    // The dirt is still there, left out; People's page is back as it was, its work kept.
    expect(read('notes.md')).toBe('dirt from before the pass\n');
    expect(read('src/people/page.tsx')).toBe('people\n');
    expect(w.h.git$('show', `refs/10db/kept/${w.people.id}:src/people/page.tsx`)).toBe(
      'People: UI work work',
    );
    expect(getTask(w.h.store.db, w.people.id).passId).toBeNull();
    expect(getWorkstreamRow(w.h.store.db, w.runOf(w.settings)).state).toBe('DONE');
    expect(w.h.git$('for-each-ref', `refs/10db/passes/${w.opened.pass.id}/${w.settings.id}`)).toBe(
      '',
    );
    // Pushed, and its pull request opened ready for review, never set to merge itself.
    expect(w.h.origin$('rev-parse', w.branch)).toBe(tip);
    expect(w.h.gh.prCreates()).toMatchObject([{ head: w.branch, draft: false }]);
    expect(getPassChecks(w.h.store.db, w.opened.pass.id).gate.state).toBe('passed');
  });

  it.each([
    {
      name: 'in a scratch worktree, before any take-out',
      project: { gateCommand: 'false' },
      takenOut: false,
    },
    {
      name: 'in the folder, after the take-outs',
      project: { gateCommand: 'false', delivery: 'local' as const },
      takenOut: true,
    },
  ])('reopens the pass when its gate fails $name', async ({ project, takenOut }) => {
    await world(project);
    await twoTurns();

    await confirm(closeDeps());

    expect(passState()).toBe('OPEN');
    expect(getPassProgress(w.h.store.db, w.opened.pass.id).closeStep).toBeNull();
    expect(batchState()).toBe('OPEN');
    expect(
      findOpenByFoldKey(w.h.store.db, w.h.project.id, gateFailedKey(w.opened.pass.id)),
    ).toMatchObject({ kind: 'flag', options: [] });
    // Step 2 stands: Settings is signed off; nothing was pushed or fast-forwarded.
    expect(landed()).toEqual(['Settings: UI work']);
    expect(w.h.git$('symbolic-ref', '--short', 'HEAD')).toBe(w.branch);
    expect(getTask(w.h.store.db, w.people.id).passId === null).toBe(takenOut);
  });

  it('lands, at the next close, a shared change chosen Drop when the gate failed before its take-out', async () => {
    await world({ gateCommand: 'true' });
    // The gate fails the first time it runs and passes after.
    const flag = join(w.h.dataDir, 'gate-ran');
    w.h.state.write((ctx) =>
      patchProject(ctx, w.h.project.id, {
        gateCommand: `test -e '${flag}' || { touch '${flag}'; exit 1; }`,
      }),
    );
    await twoTurns();
    await sharedTurn(w.people, 'src/button.ts');

    await confirm(closeDeps(), [], [{ seq: 1, choice: SharedChoiceKind.Drop }]);
    expect(passState()).toBe('OPEN');

    // People is signed off at the next close, with its change kept: the change lands before it.
    const closes = createPassCloses(closeDeps());
    const shown = await closes.preview(w.opened.pass.id);
    await closes.close(w.opened.pass.id, {
      token: shown.token,
      pages: [{ taskId: w.people.id, choice: PassClosePageChoice.SignOff }],
      files: [],
      shared: [],
    });
    await w.h.jobs.idle();

    expect(passState()).toBe('CLOSED');
    expect(landed()).toEqual([
      'Settings: UI work',
      'Shared change 1 of People: UI work',
      'People: UI work',
    ]);
    expect(w.h.git$('show', `${w.branch}:src/button.ts`)).toBe('People: UI work shared');
  });

  it('closes by the fast-forward alone with no origin, and settles at once', async () => {
    await world({ gateCommand: null });
    await twoTurns();
    w.h.git$('remote', 'remove', 'origin');

    await confirm(closeDeps());

    expect(passState()).toBe('SETTLED');
    expect(batchState()).toBe('SHIPPED');
    expect(w.h.git$('rev-parse', 'main')).toBe(w.h.git$('rev-parse', w.branch));
    expect(w.h.gh.prCreates()).toEqual([]);
  });

  it.each([
    { name: 'before the gate', kill: 'gatePassTip' as const, step: 2 },
    { name: 'after the push', kill: 'pushPassBranch' as const, step: 5 },
  ])(
    'goes on from its recorded step after a kill $name, making nothing twice',
    async ({ kill, step }) => {
      await world({ gateCommand: 'true' });
      await twoTurns();
      const deps = closeDeps();
      const crashing: CloseDeps = {
        ...deps,
        ship: {
          ...deps.ship,
          gatePassTip:
            kill === 'gatePassTip'
              ? () => Promise.reject(new Error('the daemon stopped'))
              : (i) => deps.ship.gatePassTip(i),
          pushPassBranch:
            kill === 'pushPassBranch'
              ? async (passId, signal) => {
                  await deps.ship.pushPassBranch(passId, signal);
                  throw new Error('the daemon stopped');
                }
              : (passId, signal) => deps.ship.pushPassBranch(passId, signal),
        },
      };
      await confirm(crashing);
      expect(passState()).toBe('CLOSING');
      expect(getPassProgress(w.h.store.db, w.opened.pass.id).closeStep).toBe(step);

      await closeSteps(closeDeps(w.restart()), w.opened.pass.id, new AbortController().signal);

      expect(passState()).toBe('CLOSED');
      expect(landed()).toEqual(['Settings: UI work']);
      expect(w.h.gh.prCreates()).toHaveLength(1);
      expect(w.h.git$('symbolic-ref', '--short', 'HEAD')).toBe('main');
    },
  );

  it('waits with the folder card while Your folder is off its branch, and goes on once it is back', async () => {
    await world({ gateCommand: null });
    await twoTurns();
    w.h.git$('remote', 'remove', 'origin');
    const tip = w.h.commit('docs/landed.md', 'on the branch\n');
    w.h.state.write((ctx) => {
      setClosePlan(ctx, w.opened.pass.id, { token: 't', pages: [], files: [], shared: [] });
    });
    w.h.git$('switch', '-q', 'main');
    const closing = closeSteps(
      { ...closeDeps(), folderPollMs: 20 },
      w.opened.pass.id,
      new AbortController().signal,
    );

    await waitFor(() => folderCardOpen(w.h.store.db, w.opened.pass));
    expect(passState()).toBe('CLOSING');
    expect(getPassProgress(w.h.store.db, w.opened.pass.id).closeStep).toBe(1);
    w.h.git$('switch', '-q', w.branch);
    await closing;

    expect(passState()).toBe('SETTLED');
    expect(folderCardOpen(w.h.store.db, w.opened.pass)).toBe(false);
    expect(w.h.git$('symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(w.h.git$('rev-parse', 'main')).toBe(tip);
  });

  it.each([
    {
      name: 'its push failed',
      ship: (real: CloseShip): Partial<CloseShip> => {
        let failed = false;
        return {
          pushPassBranch: (passId, signal) => {
            if (failed) return real.pushPassBranch(passId, signal);
            failed = true;
            return Promise.reject(new Error('origin is offline'));
          },
        };
      },
      notice: /^The close stopped: origin is offline\./,
    },
    {
      name: 'its gate was stopped by something other than an Abandon',
      ship: (real: CloseShip): Partial<CloseShip> => {
        let stopped = false;
        return {
          gatePassTip: (i) => {
            if (stopped) return real.gatePassTip(i);
            stopped = true;
            return Promise.resolve({ passed: false, aborted: true, logPath: '', dirtyNamed: [] });
          },
        };
      },
      notice: /^The close stopped: the gate was stopped before it finished\./,
    },
  ])('goes on when Close Pass is asked again after $name', async ({ ship, notice }) => {
    await world({ gateCommand: 'true' });
    await twoTurns();
    const deps = closeDeps();
    const closes = await confirm({ ...deps, ship: { ...deps.ship, ...ship(deps.ship) } });
    expect(passState()).toBe('CLOSING');
    const stuck = getPassProgress(w.h.store.db, w.opened.pass.id).notices.find(
      (n) => n.id === 'close',
    );
    expect(stuck?.text).toMatch(notice);

    const again = await closes.close(w.opened.pass.id, {
      token: '',
      pages: [],
      files: [],
      shared: [],
    });
    await w.h.jobs.idle();

    expect(again.outcome).toBe('closing');
    expect(passState()).toBe('CLOSED');
    expect(landed()).toEqual(['Settings: UI work']);
    expect(getPassProgress(w.h.store.db, w.opened.pass.id).notices).toEqual([]);
  });

  it("waits with the folder card when Your folder leaves the pass's branch as it lands", async () => {
    await world({ gateCommand: 'true' });
    await twoTurns();
    const deps = closeDeps();
    let switched = false;
    const closes = createPassCloses({
      ...deps,
      folderPollMs: 20,
      ship: {
        ...deps.ship,
        stopPassChecks: async (passId) => {
          await deps.ship.stopPassChecks(passId);
          // The builder switches branch just after the close first found the folder on it.
          if (!switched) w.h.git$('switch', '-q', 'main');
          switched = true;
        },
      },
    });
    const shown = await closes.preview(w.opened.pass.id);
    await closes.close(w.opened.pass.id, {
      token: shown.token,
      pages: [{ taskId: w.settings.id, choice: PassClosePageChoice.SignOff }],
      files: [],
      shared: [],
    });

    await waitFor(() => folderCardOpen(w.h.store.db, w.opened.pass));
    expect(passState()).toBe('CLOSING');
    expect(getPassProgress(w.h.store.db, w.opened.pass.id).notices).toEqual([]);
    w.h.git$('switch', '-q', w.branch);
    await w.h.jobs.idle();

    expect(passState()).toBe('CLOSED');
    expect(landed()).toEqual(['Settings: UI work']);
  });

  it('lets go of a hold it cannot keep, and closes', async () => {
    await world({ gateCommand: 'true' });
    await twoTurns();
    w.startTurn(w.people);
    const granted = await grantSharedHold(w.deps, { workstreamId: w.runOf(w.people), area: 'src' });
    if (!granted?.ok) throw new Error('src was not granted');
    w.write('src/button.ts', 'button\n');
    const [hold] = openHolds(w.h.store.db, w.opened.pass.id);
    if (!hold) throw new Error('no hold');
    w.h.state.write((ctx) => {
      setClosePlan(ctx, w.opened.pass.id, {
        token: 't',
        pages: [{ taskId: w.people.id, choice: PassClosePageChoice.TakeOut }],
        files: [],
        shared: [],
      });
    });
    // People's turn held src when the close began, and the hold's record is gone since.
    w.h.store.db
      .update(schema.passHolds)
      .set({ recordSha: '0'.repeat(40) })
      .run();
    w.h.git$('update-ref', '-d', `refs/10db/passes/${w.opened.pass.id}/holds/${hold.claimId}`);

    await closeSteps(closeDeps(), w.opened.pass.id, new AbortController().signal);

    expect(passState()).toBe('CLOSED');
    expect(openHolds(w.h.store.db, w.opened.pass.id)).toEqual([]);
  });

  it('waits for Your folder before its take-outs, so the pages it takes out are put back', async () => {
    await world({ gateCommand: 'true' });
    await twoTurns();
    const deps = closeDeps();
    const closes = createPassCloses({
      ...deps,
      folderPollMs: 20,
      ship: {
        ...deps.ship,
        gatePassTip: async (i) => {
          const ran = await deps.ship.gatePassTip(i);
          // The builder switches branch as the gate finishes, before any page is taken out.
          w.h.git$('switch', '-q', 'main');
          return ran;
        },
      },
    });
    const shown = await closes.preview(w.opened.pass.id);
    await closes.close(w.opened.pass.id, {
      token: shown.token,
      pages: [
        { taskId: w.settings.id, choice: PassClosePageChoice.SignOff },
        { taskId: w.people.id, choice: PassClosePageChoice.TakeOut },
      ],
      files: [],
      shared: [],
    });

    await waitFor(() => folderCardOpen(w.h.store.db, w.opened.pass));
    expect(getPassProgress(w.h.store.db, w.opened.pass.id).closeStep).toBe(3);
    w.h.git$('switch', '-q', w.branch);
    await w.h.jobs.idle();

    expect(passState()).toBe('CLOSED');
    expect(read('src/people/page.tsx')).toBe('people\n');
    expect(getTask(w.h.store.db, w.people.id).passId).toBeNull();
  });

  it(
    "is taken over by an Abandon while its gate runs: the gate's signal is raised and the pass ends ABANDONED",
    { timeout: 120_000 },
    async () => {
      await world({ gateCommand: 'sleep 60' });
      await twoTurns();
      const deps = closeDeps();
      const closes = createPassCloses(deps);
      const shown = await closes.preview(w.opened.pass.id);
      await closes.close(w.opened.pass.id, {
        token: shown.token,
        pages: [],
        files: [],
        shared: [],
      });
      await waitFor(
        () => getPassChecks(w.h.store.db, w.opened.pass.id).gate.state === 'running',
        30_000,
      );

      const asked = Date.now();
      const abandoned = await startAbandon(
        {
          ...deps,
          stopShip: async (passId) => {
            await deps.ship.stopPassChecks(passId);
            await closes.abort(passId);
          },
        },
        w.opened.pass.id,
      );

      // The gate's abort ended it: a gate left to run would hold the Abandon for its whole minute.
      expect(Date.now() - asked).toBeLessThan(20_000);
      expect(passState()).toBe('ABANDONED');
      expect(batchState()).toBe('ABANDONED');
      expect(abandoned.reverted.sort()).toEqual([w.settings.id, w.people.id].sort());
      expect(existsSync(join(w.h.repo, 'src/settings/page.tsx'))).toBe(true);
      expect(read('src/settings/page.tsx')).toBe('settings\n');
      expect(getPassChecks(w.h.store.db, w.opened.pass.id).gate.state).not.toBe('running');
    },
  );
});
