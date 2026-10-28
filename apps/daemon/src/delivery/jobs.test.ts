import { mintId, WorkspaceMode } from '@10db/contracts';
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

  it("a cut queue job runs while the same project's ship queue job waits", async () => {
    const project = { id: mintId('Project'), workspaceMode: WorkspaceMode.Worktree };
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

  it('jobKey keeps one queue in shared mode', () => {
    const project = { id: mintId('Project'), workspaceMode: WorkspaceMode.Shared };
    expect(jobKey(project, JobQueue.Cut)).toBe(project.id);
    expect(jobKey(project, JobQueue.Ship)).toBe(project.id);
  });
});
