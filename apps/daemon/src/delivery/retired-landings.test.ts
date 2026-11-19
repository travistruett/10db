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
const notices = () => h.notices().filter((n) => n.line.includes('no longer exists'));

describe('a task whose landing names a branch that is gone from origin', () => {
  it('takes the default landing, started or not, a notice lists the tasks that moved, it does nothing twice, and the task can then join a batch that merges into main', async () => {
    h = createDeliveryHarness();
    const fresh = h.addTask('Fresh', { landing: NEXT });
    const started = h.addTask('Started', { landing: NEXT });
    h.state.write((w) => {
      insertWorkstream(w, started.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } });
    });
    const kept = h.addTask('Kept');
    expect(() =>
      h.starter.startBatch(h.project.id, { title: 'Both', taskIds: [fresh.id, kept.id] }),
    ).toThrow(ConflictError);

    const moved = await run();

    expect(moved.map((t) => t.id).sort()).toEqual([fresh.id, started.id].sort());
    expect(landingOf(fresh.id)).toEqual({ kind: 'base' });
    expect(landingOf(started.id)).toEqual({ kind: 'base' });
    expect(landingOf(kept.id)).toEqual({ kind: 'base' });
    const [notice] = notices();
    expect(notices()).toHaveLength(1);
    expect(h.cards()).toEqual([]);
    expect(notice).toMatchObject({ key: 'retired-landings:next', tone: 'info', taskId: null });
    expect(notice?.body).toContain(`Fresh (${fresh.id})`);
    expect(notice?.body).toContain(`Started (${started.id})`);
    expect(notice?.body).not.toContain('Kept');
    expect(notice?.body).toContain('next');
    expect(notice?.body).toContain('main');

    expect(await run()).toEqual([]);
    expect(notices()).toHaveLength(1);

    const batch = h.only(
      h.starter.startBatch(h.project.id, { title: 'Both', taskIds: [fresh.id, kept.id] }),
    );
    await h.jobs.idle();
    expect(batch).toMatchObject({ baseBranch: 'main', autoMerge: true });
  });

  it('moves the tasks and posts the notice when the branch names make the key longer than a notice key allows', async () => {
    h = createDeliveryHarness();
    const names = ['a', 'b', 'c', 'd'].map((c) => `retired/${c.repeat(70)}`);
    const tasks = names.map((branch, i) =>
      h.addTask(`Old ${String(i)}`, { landing: { kind: 'branch', branch } }),
    );

    const moved = await run();

    expect(moved).toHaveLength(tasks.length);
    for (const task of tasks) expect(landingOf(task.id)).toEqual({ kind: 'base' });
    const notice = h.only(notices());
    expect(notice.key.startsWith('retired-landings:retired/')).toBe(true);
    expect(notice.key.length).toBeLessThanOrEqual(200);
  });

  it("takes the project's default when that is to hold", async () => {
    h = createDeliveryHarness({ landing: 'hold' });
    const old = h.addTask('Old', { landing: NEXT });
    await run();
    expect(landingOf(old.id)).toEqual({ kind: 'hold' });
  });

  it('is left alone when the branch is on origin, while an unfinished batch is based on the branch, or when it is finished', async () => {
    h = createDeliveryHarness();
    // Each task lands on a branch of its own, so no one reason leaves another task alone.
    const ALIVE: TaskLanding = { kind: 'branch', branch: 'alive' };
    const BUSY: TaskLanding = { kind: 'branch', branch: 'busy' };
    h.teammatePush('alive', 'src/api/x.txt');
    const alive = h.addTask('Alive', { landing: ALIVE });
    const busy = h.addTask('Busy', { landing: BUSY });
    h.state.write((w) => {
      insertBatch(w, {
        projectId: h.project.id,
        title: 'On busy',
        baseBranch: 'busy',
        worktreePath: '/nowhere',
      });
    });
    const done = h.addTask('Done', { landing: NEXT });
    h.state.write((w) => {
      setTaskStatus(w, done.id, 'done');
    });

    expect(await run()).toEqual([]);
    expect.soft(landingOf(alive.id), 'on origin').toEqual(ALIVE);
    expect.soft(landingOf(busy.id), 'an unfinished batch on it').toEqual(BUSY);
    expect.soft(landingOf(done.id), 'finished').toEqual(NEXT);
    expect(notices()).toEqual([]);
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
    expect(notices()).toEqual([]);
  });
});
