import { ConflictError, type TaskLanding } from '@10db/contracts';
import { getTask, insertBatch, insertWorkstream, patchProject, setTaskStatus } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { moveRetiredLandings } from './retired-landings';

// Tasks made while `next` was the integration branch keep landing there after it is gone. Main takes
// pull requests directly now, so such a task could not join a batch that merges into main.

let h: DeliveryHarness;
afterEach(() => {
  h.close();
});

const NEXT: TaskLanding = { kind: 'branch', branch: 'next' };
const landingOf = (id: string) => getTask(h.store.db, id as never).landing;
const run = () => moveRetiredLandings(h.ctx, new AbortController().signal);
const cards = () => h.cards().filter((c) => c.title.includes('no longer exists'));

describe('a task whose landing names a branch that is gone from origin', () => {
  it('takes the default landing, started or not, and a card lists the tasks that moved', async () => {
    h = createDeliveryHarness();
    const fresh = h.addTask('Fresh', { landing: NEXT });
    const started = h.addTask('Started', { landing: NEXT });
    h.state.write((w) => {
      insertWorkstream(w, started.id);
    });
    const kept = h.addTask('Kept');

    const moved = await run();

    expect(moved.map((t) => t.id).sort()).toEqual([fresh.id, started.id].sort());
    expect(landingOf(fresh.id)).toEqual({ kind: 'base' });
    expect(landingOf(started.id)).toEqual({ kind: 'base' });
    expect(landingOf(kept.id)).toEqual({ kind: 'base' });
    const [card] = cards();
    expect(cards()).toHaveLength(1);
    expect(card?.body).toContain(`Fresh (${fresh.id})`);
    expect(card?.body).toContain(`Started (${started.id})`);
    expect(card?.body).not.toContain('Kept');
    expect(card?.body).toContain('next');
    expect(card?.body).toContain('main');
  });

  it('can then join a batch that merges into main', async () => {
    h = createDeliveryHarness();
    const old = h.addTask('Old', { landing: NEXT });
    const current = h.addTask('Current');
    expect(() =>
      h.starter.startBatch(h.project.id, { title: 'Both', taskIds: [old.id, current.id] }),
    ).toThrow(ConflictError);

    await run();

    const batch = h.only(
      h.starter.startBatch(h.project.id, { title: 'Both', taskIds: [old.id, current.id] }),
    );
    await h.jobs.idle();
    expect(batch).toMatchObject({ baseBranch: 'main', autoMerge: true });
  });

  it("takes the project's default when that is to hold", async () => {
    h = createDeliveryHarness({ landing: 'hold' });
    const old = h.addTask('Old', { landing: NEXT });
    await run();
    expect(landingOf(old.id)).toEqual({ kind: 'hold' });
  });

  it('is left alone when the branch is on origin', async () => {
    h = createDeliveryHarness();
    h.teammatePush('next', 'src/api/x.txt');
    const task = h.addTask('Alive', { landing: NEXT });
    expect(await run()).toEqual([]);
    expect(landingOf(task.id)).toEqual(NEXT);
    expect(cards()).toEqual([]);
  });

  it('is left alone while an unfinished batch is based on the branch', async () => {
    h = createDeliveryHarness();
    const task = h.addTask('Busy', { landing: NEXT });
    h.state.write((w) => {
      insertBatch(w, {
        projectId: h.project.id,
        title: 'On next',
        baseBranch: 'next',
        worktreePath: '/nowhere',
      });
    });
    expect(await run()).toEqual([]);
    expect(landingOf(task.id)).toEqual(NEXT);
  });

  it('is left alone when it is finished', async () => {
    h = createDeliveryHarness();
    const task = h.addTask('Done', { landing: NEXT });
    h.state.write((w) => {
      setTaskStatus(w, task.id, 'done');
    });
    expect(await run()).toEqual([]);
    expect(landingOf(task.id)).toEqual(NEXT);
  });

  it('is left alone when the project default names the same missing branch', async () => {
    h = createDeliveryHarness();
    const task = h.addTask('Old', { landing: NEXT });
    h.state.write((w) => {
      patchProject(w, h.project.id, { landing: 'branch', landingBranch: 'next' });
    });
    expect(await run()).toEqual([]);
    expect(landingOf(task.id)).toEqual(NEXT);
  });

  it('is left alone when origin cannot be asked', async () => {
    h = createDeliveryHarness(
      {},
      {
        wrapGit: (git) => ({
          ...git,
          branchOnOrigin: () => Promise.reject(new Error('offline')),
        }),
      },
    );
    const task = h.addTask('Old', { landing: NEXT });
    expect(await run()).toEqual([]);
    expect(landingOf(task.id)).toEqual(NEXT);
    expect(cards()).toEqual([]);
  });

  it('does nothing twice', async () => {
    h = createDeliveryHarness();
    h.addTask('Old', { landing: NEXT });
    expect(await run()).toHaveLength(1);
    expect(await run()).toEqual([]);
    expect(cards()).toHaveLength(1);
  });
});
