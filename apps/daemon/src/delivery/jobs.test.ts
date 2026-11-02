import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../log';
import { createDeliveryJobs, jobKey, JobQueue } from './index';

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('delivery jobs', () => {
  it("runs one key's jobs in order and other keys alongside", async () => {
    const jobs = createDeliveryJobs(silentLogger);
    const order: string[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    jobs.run('a', async () => {
      await gate;
      order.push('a1');
    });
    jobs.run('a', () => {
      order.push('a2');
      return Promise.resolve();
    });
    jobs.run('b', () => {
      order.push('b1');
      return Promise.resolve();
    });
    await tick();
    expect(order).toEqual(['b1']);
    release();
    await jobs.idle();
    expect(order).toEqual(['b1', 'a1', 'a2']);
  });

  it('logs a failing job and runs the next one', async () => {
    const errors: unknown[] = [];
    const jobs = createDeliveryJobs({ ...silentLogger, error: (obj) => errors.push(obj) });
    const ran: string[] = [];
    jobs.run('a', () => Promise.reject(new Error('boom')));
    jobs.run('a', () => {
      ran.push('next');
      return Promise.resolve();
    });
    await jobs.idle();
    expect(ran).toEqual(['next']);
    expect(errors).toHaveLength(1);
  });

  it('aborts the running job on stop, waits for it, and takes no new jobs', async () => {
    const jobs = createDeliveryJobs(silentLogger);
    let sawAbort = false;
    jobs.run(
      'a',
      (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            sawAbort = true;
            resolve();
          });
        }),
    );
    // A job starts on a microtask; let it start so it is the running job that stop() aborts.
    await tick();
    await jobs.stop();
    expect(sawAbort).toBe(true);
    let ranAfterStop = false;
    jobs.run('a', () => {
      ranAfterStop = true;
      return Promise.resolve();
    });
    await jobs.idle();
    expect(ranAfterStop).toBe(false);
  });

  it("a separate copy's cut queue job runs while its ship queue job waits", async () => {
    const project = { projectId: mintId('Project'), worktreePath: '/copies/one' };
    const jobs = createDeliveryJobs(silentLogger);
    const order: string[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    jobs.run(jobKey(project, JobQueue.Ship), async () => {
      await gate;
      order.push('ship');
    });
    jobs.run(jobKey(project, JobQueue.Cut), () => {
      order.push('cut');
      return Promise.resolve();
    });
    await tick();
    expect(order).toEqual(['cut']);
    release();
    await jobs.idle();
    expect(order).toEqual(['cut', 'ship']);
  });

  it("keeps one queue for a shared batch and gives a copy's batch its own two", () => {
    const projectId = mintId('Project');
    const shared = { projectId, worktreePath: null };
    const copy = { projectId, worktreePath: '/copies/one' };
    expect(jobKey(shared, JobQueue.Cut)).toBe(projectId);
    expect(jobKey(shared, JobQueue.Ship)).toBe(projectId);
    expect(jobKey(copy, JobQueue.Cut)).toBe(`${projectId}:cut`);
    expect(jobKey(copy, JobQueue.Ship)).toBe(`${projectId}:ship`);
  });

  it("a copy's work does not wait behind the shared batch's queue", async () => {
    const projectId = mintId('Project');
    const jobs = createDeliveryJobs(silentLogger);
    const order: string[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    jobs.run(jobKey({ projectId, worktreePath: null }, JobQueue.Cut), async () => {
      await gate;
      order.push('shared');
    });
    jobs.run(jobKey({ projectId, worktreePath: '/copies/one' }, JobQueue.Cut), () => {
      order.push('copy cut');
      return Promise.resolve();
    });
    jobs.run(jobKey({ projectId, worktreePath: '/copies/one' }, JobQueue.Ship), () => {
      order.push('copy ship');
      return Promise.resolve();
    });
    await tick();
    expect(order).toEqual(['copy cut', 'copy ship']);
    release();
    await jobs.idle();
    expect(order).toEqual(['copy cut', 'copy ship', 'shared']);
  });
});
