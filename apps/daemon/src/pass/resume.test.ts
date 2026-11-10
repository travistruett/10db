import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InboxState, TakeOutStep } from '@10db/contracts';
import { getTask, lastTakeOut, listInbox } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import { answerPassCard, keepTurnWork, resumePassWork, takeOutSteps, TakeOutWithin } from './index';

// Workbench spec §12: at start-up a pass goes on from its rows. A folder switched away from the pass's
// branch while the daemon was down is one card, never a repoint; an unfinished take-out goes on.

let w: PassWorld;
afterEach(() => {
  w.close();
});

const deps = (world: PassWorld) => ({
  ...world.deps,
  stopLane: (): Promise<void> => Promise.resolve(),
});

const folderCards = (world: PassWorld) =>
  listInbox(world.h.store.db, { states: [InboxState.Open] }).filter(
    (item) => item.detail?.['passId'] === world.opened.pass.id,
  );

describe('resumePassWork', () => {
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

    await resumePassWork(deps(w));
    await w.h.jobs.idle();

    expect(lastTakeOut(w.h.store.db, w.settings.id)?.step).toBe(TakeOutStep.Done);
    expect(getTask(w.h.store.db, w.settings.id).passId).toBeNull();
    expect(readFileSync(join(w.h.repo, 'src/settings/page.tsx'), 'utf8')).toBe('settings\n');
  });
});
