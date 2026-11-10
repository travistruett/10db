import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AbandonStep, InboxState, TakeOutStep } from '@10db/contracts';
import {
  abandonPassAndBatch,
  activeClaims,
  getTask,
  getTaskKeptWork,
  lastTakeOut,
  listInbox,
  listSharedChanges,
  listTaskThread,
  openHolds,
  schema,
  setAbandonStep,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import { PassFolderOffBranchError } from '../git';
import {
  answerPassCard,
  grantSharedHold,
  holdRef,
  joinPass,
  keepHold,
  keepTurnWork,
  resumePassWork,
  takeOutSteps,
  TakeOutWithin,
} from './index';

// Workbench spec §12: at start-up a pass goes on from its rows. A folder switched away from the pass's
// branch while the daemon was down is one card, never a repoint; an unfinished take-out goes on.

let w: PassWorld;
afterEach(() => {
  w.close();
});

const deps = (world: PassWorld) => ({
  ...world.deps,
  stopLane: (): Promise<void> => Promise.resolve(),
  wrote: (): Promise<void> => Promise.resolve(),
});

const folderCards = (world: PassWorld) =>
  listInbox(world.h.store.db, { states: [InboxState.Open] }).filter(
    (item) => item.detail?.['passId'] === world.opened.pass.id,
  );

describe('resumePassWork', () => {
  it('lets go of a hold whose record is gone, freeing its area and saying so', async () => {
    w = await openPassWorld();
    w.startTurn(w.settings);
    await grantSharedHold(w.deps, { workstreamId: w.runOf(w.settings), area: 'src' });
    w.write('src/button.ts', 'a button\n');
    const [hold] = openHolds(w.h.store.db, w.opened.pass.id);
    if (!hold) throw new Error('no hold');
    // The record's commit is gone with its ref.
    w.h.store.db
      .update(schema.passHolds)
      .set({ recordSha: '0'.repeat(40) })
      .run();
    w.h.git$('update-ref', '-d', holdRef(w.opened.pass.id, hold.claimId));

    const restarted = deps({ ...w, deps: w.restart() });
    await resumePassWork(restarted);
    await restarted.jobs.idle();

    expect(openHolds(w.h.store.db, w.opened.pass.id)).toEqual([]);
    expect(activeClaims(w.h.store.db, w.runOf(w.settings)).map((c) => c.name)).not.toContain('src');
    expect(listTaskThread(w.h.store.db, w.settings.id).at(-1)?.body).toMatch(
      /^What this page changed in shared src during its turn could not be kept/,
    );
  });

  it('leaves a shared hold open while the folder is off the pass branch, and keeps it once back', async () => {
    w = await openPassWorld();
    w.startTurn(w.settings);
    await grantSharedHold(w.deps, { workstreamId: w.runOf(w.settings), area: 'src' });
    w.write('src/button.ts', 'a button\n');
    const [hold] = openHolds(w.h.store.db, w.opened.pass.id);
    if (!hold) throw new Error('no hold');
    // The builder switched the folder away while the daemon was down.
    w.h.git$('switch', '-q', 'main');

    await expect(keepHold(w.deps, { claimId: hold.claimId })).rejects.toThrow(
      PassFolderOffBranchError,
    );
    await expect(
      grantSharedHold(w.deps, { workstreamId: w.runOf(w.people), area: 'src' }),
    ).rejects.toThrow(PassFolderOffBranchError);
    const restarted = deps({ ...w, deps: w.restart() });
    await resumePassWork(restarted);
    await restarted.jobs.idle();
    expect(openHolds(w.h.store.db, w.opened.pass.id).map((h) => h.claimId)).toEqual([hold.claimId]);
    expect(listSharedChanges(w.h.store.db, w.opened.pass.id)).toEqual([]);

    w.h.git$('switch', '-q', w.branch);
    const again = deps({ ...w, deps: w.restart() });
    await resumePassWork(again);
    await again.jobs.idle();
    expect(openHolds(w.h.store.db, w.opened.pass.id)).toEqual([]);
    expect(listSharedChanges(w.h.store.db, w.opened.pass.id)[0]?.paths).toEqual(['src/button.ts']);
  });

  it("keeps a shared hold the stop left open on the chain, releases it, and remakes a lost hold's ref", async () => {
    w = await openPassWorld();
    w.write('src/shared.ts', "the builder's edit\n");
    w.startTurn(w.settings);
    await grantSharedHold(w.deps, { workstreamId: w.runOf(w.settings), area: 'src' });
    w.write('src/button.ts', 'a button\n');
    const [hold] = openHolds(w.h.store.db, w.opened.pass.id);
    if (!hold) throw new Error('no hold');
    const ref = holdRef(w.opened.pass.id, hold.claimId);
    // The daemon died with the hold open, and the hold's ref was lost with it.
    w.h.git$('update-ref', '-d', ref);

    const restarted = deps({ ...w, deps: w.restart() });
    await resumePassWork(restarted);

    expect(openHolds(w.h.store.db, w.opened.pass.id)).toEqual([]);
    expect(activeClaims(w.h.store.db, w.runOf(w.settings)).map((c) => c.name)).not.toContain('src');
    expect(listSharedChanges(w.h.store.db, w.opened.pass.id)).toMatchObject([
      { seq: hold.seq, paths: ['src/button.ts'] },
    ]);
    expect(w.h.git$('rev-parse', ref)).toBe(hold.recordSha);
    await restarted.jobs.idle();
  });

  it('raises one card for a folder switched away while the daemon was down; its answer switches back', async () => {
    w = await openPassWorld();
    w.write('src/settings/page.tsx', 'edited, not committed\n');
    w.h.git$('switch', '-q', 'main');

    await resumePassWork(deps(w));
    await resumePassWork(deps(w));
    // Nothing moved HEAD: the folder stays where the builder put it, with one card saying so.
    expect(w.h.git$('symbolic-ref', '--short', 'HEAD')).toBe('main');
    const [card] = folderCards(w);
    expect(folderCards(w)).toHaveLength(1);
    if (!card) throw new Error('no folder card');
    expect(card.options.map((o) => o.label)).toEqual([`Switch to ${w.branch}`]);

    answerPassCard(w.deps, card, { choice: `Switch to ${w.branch}` });
    await w.h.jobs.idle();

    expect(w.h.git$('symbolic-ref', '--short', 'HEAD')).toBe(w.branch);
    expect(readFileSync(join(w.h.repo, 'src/settings/page.tsx'), 'utf8')).toBe(
      'edited, not committed\n',
    );
    expect(folderCards(w)).toEqual([]);
    // Turns go on: the page's work is kept again.
    const kept = await keepTurnWork(w.deps, { workstreamId: w.runOf(w.settings), turnId: null });
    expect(kept.pageFiles.map((f) => f.path)).toEqual(['src/settings/page.tsx']);
  });

  it('says why when the switch back would write over an uncommitted file, and leaves it', async () => {
    w = await openPassWorld();
    w.h.git$('switch', '-q', 'main');
    w.h.commit('src/people/page.tsx', 'committed on main\n');
    w.write('src/people/page.tsx', 'edited on main\n');
    await resumePassWork(deps(w));
    const [card] = folderCards(w);
    if (!card) throw new Error('no folder card');

    answerPassCard(w.deps, card, { choice: `Switch to ${w.branch}` });
    await w.h.jobs.idle();

    expect(w.h.git$('symbolic-ref', '--short', 'HEAD')).toBe('main');
    const [again] = folderCards(w);
    expect(again?.body).toContain('src/people/page.tsx');
  });

  it("switches nothing for a pass that no longer holds the folder, and says when the pass's branch is gone", async () => {
    w = await openPassWorld();
    w.h.git$('switch', '-q', 'main');
    await resumePassWork(deps(w));
    const [card] = folderCards(w);
    if (!card) throw new Error('no folder card');

    w.h.git$('branch', '-D', w.branch);
    answerPassCard(w.deps, card, { choice: `Switch to ${w.branch}` });
    await w.h.jobs.idle();
    expect(w.h.git$('symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(folderCards(w)[0]?.body).toContain("the pass's branch is gone");

    w.h.git$('branch', w.branch, w.opened.pass.startSha);
    w.h.state.write((ctx) => {
      setAbandonStep(ctx, w.opened.pass.id, AbandonStep.Abandoning);
      abandonPassAndBatch(ctx, w.opened.pass.id);
    });
    answerPassCard(w.deps, card, { choice: `Switch to ${w.branch}` });
    await w.h.jobs.idle();
    expect(w.h.git$('symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(folderCards(w)).toEqual([]);
  });

  it('goes on with a take-out the daemon stopped in', async () => {
    w = await openPassWorld();
    w.write('src/settings/page.tsx', 'the turn\n');
    const crashing = {
      ...deps(w),
      git: {
        ...w.h.git,
        restoreFiles: () => Promise.reject(new Error('the daemon died')),
      },
    };
    await expect(
      takeOutSteps(crashing, { taskId: w.settings.id, within: TakeOutWithin.Alone }),
    ).rejects.toThrow('the daemon died');
    expect(lastTakeOut(w.h.store.db, w.settings.id)?.step).toBe(TakeOutStep.Checked);

    const restarted = {
      ...w.restart(),
      stopLane: (): Promise<void> => Promise.resolve(),
      wrote: (): Promise<void> => Promise.resolve(),
    };
    await resumePassWork(restarted);
    await restarted.jobs.idle();

    expect(lastTakeOut(w.h.store.db, w.settings.id)?.step).toBe(TakeOutStep.Done);
    expect(getTask(w.h.store.db, w.settings.id).passId).toBeNull();
    expect(readFileSync(join(w.h.repo, 'src/settings/page.tsx'), 'utf8')).toBe('settings\n');
  });

  it('puts back the saved work of a page Add Page put back into the pass it was taken out of', async () => {
    w = await openPassWorld();
    w.write('src/settings/page.tsx', 'the turn\n');
    await takeOutSteps(deps(w), { taskId: w.settings.id, within: TakeOutWithin.Alone });
    // The daemon stopped before the join's put-back wrote a file.
    await joinPass(
      w.h.ctx,
      w.opened.pass.id,
      { pages: [], taskIds: [w.settings.id], firstMessage: null },
      { leaseMs: 60_000, putBack: () => Promise.reject(new Error('the daemon died')) },
    );
    expect(readFileSync(join(w.h.repo, 'src/settings/page.tsx'), 'utf8')).toBe('settings\n');

    const restarted = {
      ...w.restart(),
      stopLane: (): Promise<void> => Promise.resolve(),
      wrote: (): Promise<void> => Promise.resolve(),
    };
    await resumePassWork(restarted);
    await restarted.jobs.idle();

    expect(readFileSync(join(w.h.repo, 'src/settings/page.tsx'), 'utf8')).toBe('the turn\n');
    expect(getTaskKeptWork(w.h.store.db, w.settings.id)).toBeNull();
  });
});
