import { PassClosePageChoice, SharedChoiceKind, WorkstreamState } from '@10db/contracts';
import { getPass, openHolds, transitionWorkstream } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import { createPassCloses, type CloseShip } from './close';
import { closePreview, type CloseListDeps } from './close-lists';
import { grantSharedHold, keepHold, keepTurnWork } from './index';

// Workbench spec §5.4 (D25), W10, §18: Close Pass… lists the unfinished pages, the files no page
// owns, and the commits 10db did not make, stopping nothing, under a token that a stopped turn
// changes only when it changed the lists.

let w: PassWorld;
afterEach(() => {
  w.close();
});

const lists = (): CloseListDeps => ({ ...w.deps, gateWhere: () => 'none' });

/** A ship that is never reached: these closes are refused or shown again before step 2. */
const noShip: CloseShip = {
  gatePassTip: () => Promise.reject(new Error('no gate here')),
  pushPassBranch: () => Promise.reject(new Error('no push here')),
  ensurePassPr: () => Promise.reject(new Error('no pull request here')),
  stopPassChecks: () => Promise.resolve(),
  openFollowOnPr: () => Promise.reject(new Error('no follow-on here')),
};

describe('closePreview', () => {
  it('lists working pages and their shared changes, unowned files with their dirt marked, and hand commits', async () => {
    w = await openPassWorld({
      before: ({ write }) => {
        write('notes.md', 'dirt from before the pass\n');
      },
    });
    // Settings keeps a shared change and a page edit; People's turn is still working.
    const turn = w.startTurn(w.settings);
    const granted = await grantSharedHold(w.deps, {
      workstreamId: w.runOf(w.settings),
      area: 'src',
    });
    if (!granted?.ok) throw new Error('src was not granted');
    w.write('src/button.ts', 'button\n');
    w.write('src/settings/page.tsx', 'settings work\n');
    const [hold] = openHolds(w.h.store.db, w.opened.pass.id);
    if (!hold) throw new Error('no hold');
    await keepHold(w.deps, { claimId: hold.claimId });
    w.endTurn(turn);
    await keepTurnWork(w.deps, { workstreamId: w.runOf(w.settings), turnId: turn.id });
    const working = w.startTurn(w.people);
    w.write('docs/new.md', 'one\ntwo\n');
    const hand = w.h.commit('docs/hand.md', 'typed by hand\n');

    const shown = await closePreview(lists(), w.opened.pass.id);

    expect(shown.unfinished).toEqual([
      {
        taskId: w.settings.id,
        title: 'Settings: UI work',
        working: false,
        sharedUnlanded: [{ seq: 1, paths: ['src/button.ts'], dropRefusal: null, laterPages: [] }],
      },
      { taskId: w.people.id, title: 'People: UI work', working: true, sharedUnlanded: [] },
    ]);
    expect(shown.unowned).toEqual([
      { path: 'docs/new.md', added: 2, removed: 0, fromBeforePass: false },
      { path: 'notes.md', added: 1, removed: 0, fromBeforePass: true },
    ]);
    expect(shown.foreignCommits).toEqual([{ sha: hand, subject: 'Add docs/hand.md' }]);
    expect(shown.summary).toBe(
      'Lands 0 pages and 1 shared change on `main`; opens a pull request for review.',
    );

    // People's turn ends without touching the lists: the token is the same.
    w.endTurn(working);
    expect((await closePreview(lists(), w.opened.pass.id)).token).toBe(shown.token);
  });
});

describe('Close Pass, confirmed', () => {
  it('refuses a Drop of a change a page set to Sign Off Now was built with, naming the page', async () => {
    w = await openPassWorld();
    const closes = createPassCloses({
      ...w.deps,
      stopLane: () => Promise.resolve(),
      wrote: () => Promise.resolve(),
      ship: noShip,
      gateWhere: () => 'none',
    });
    // People's turn keeps a shared change; Settings' turn is kept after it, built with it.
    const shared = w.startTurn(w.people);
    const granted = await grantSharedHold(w.deps, { workstreamId: w.runOf(w.people), area: 'src' });
    if (!granted?.ok) throw new Error('src was not granted');
    w.write('src/button.ts', 'button\n');
    const [hold] = openHolds(w.h.store.db, w.opened.pass.id);
    if (!hold) throw new Error('no hold');
    await keepHold(w.deps, { claimId: hold.claimId });
    w.endTurn(shared);
    const built = w.startTurn(w.settings);
    w.write('src/settings/page.tsx', 'settings work\n');
    w.endTurn(built);
    await keepTurnWork(w.deps, { workstreamId: w.runOf(w.settings), turnId: built.id });
    const shown = await closes.preview(w.opened.pass.id);

    await expect(
      closes.close(w.opened.pass.id, {
        token: shown.token,
        pages: [
          { taskId: w.settings.id, choice: PassClosePageChoice.SignOff },
          { taskId: w.people.id, choice: PassClosePageChoice.TakeOut },
        ],
        files: [],
        shared: [{ seq: 1, choice: SharedChoiceKind.Drop }],
      }),
    ).rejects.toThrow(/Settings: UI work is set to Sign Off Now/);
    expect(getPass(w.h.store.db, w.opened.pass.id).state).toBe('OPEN');
  });

  it('shows the lists again, with what changed, when a file changed after they were shown', async () => {
    w = await openPassWorld();
    const closes = createPassCloses({
      ...w.deps,
      stopLane: () => Promise.resolve(),
      wrote: () => Promise.resolve(),
      ship: noShip,
      gateWhere: () => 'none',
    });
    const shown = await closes.preview(w.opened.pass.id);
    w.write('docs/late.md', 'written after the modal opened\n');

    const answer = await closes.close(w.opened.pass.id, {
      token: shown.token,
      pages: shown.unfinished.map((p) => ({
        taskId: p.taskId,
        choice: PassClosePageChoice.TakeOut,
      })),
      files: [],
      shared: [],
    });

    expect(answer).toMatchObject({
      outcome: 'changed',
      changed: ['docs/late.md changed, and no page owns it'],
    });
    expect(getPass(w.h.store.db, w.opened.pass.id).state).toBe('OPEN');
  });

  it('refuses a file placed in a page that is being taken out, a Drop of a page that signs off, and Sign Off Now of a failed run', async () => {
    w = await openPassWorld();
    const closes = createPassCloses({
      ...w.deps,
      stopLane: () => Promise.resolve(),
      wrote: () => Promise.resolve(),
      ship: noShip,
      gateWhere: () => 'none',
    });
    w.write('docs/new.md', 'new\n');
    const shown = await closes.preview(w.opened.pass.id);
    const pages = [
      { taskId: w.settings.id, choice: PassClosePageChoice.SignOff },
      { taskId: w.people.id, choice: PassClosePageChoice.TakeOut },
    ];

    await expect(
      closes.close(w.opened.pass.id, {
        token: shown.token,
        pages,
        files: [{ path: 'docs/new.md', placeIn: w.people.id }],
        shared: [],
      }),
    ).rejects.toMatchObject({ name: 'ConflictError' });
    await expect(
      closes.close(w.opened.pass.id, {
        token: shown.token,
        pages,
        files: [],
        shared: [{ seq: 1, choice: 'drop' }],
      }),
    ).rejects.toMatchObject({ name: 'ConflictError' });
    w.h.state.write((ctx) => {
      for (const to of [WorkstreamState.Starting, WorkstreamState.Failed])
        transitionWorkstream(ctx, w.runOf(w.people), { to, fence: null });
    });
    await expect(
      closes.close(w.opened.pass.id, {
        token: shown.token,
        pages: [{ taskId: w.people.id, choice: PassClosePageChoice.SignOff }],
        files: [],
        shared: [],
      }),
    ).rejects.toThrow('People: UI work cannot be signed off now: its run failed');
    expect(getPass(w.h.store.db, w.opened.pass.id).state).toBe('OPEN');
  });
});
