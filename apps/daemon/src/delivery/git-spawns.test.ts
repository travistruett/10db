import { getBatch, listWorkstreams } from '@10db/db';
import { afterEach, expect, it, vi } from 'vitest';

/** Every git subcommand line the daemon and harness spawned, in order, from the child_process wrapper. */
const spawned = vi.hoisted(() => [] as string[]);
vi.mock('node:child_process', async (importOriginal) => {
  const real: Record<string, unknown> = await importOriginal();
  const spawn = real['spawn'] as (...a: unknown[]) => unknown;
  return {
    ...real,
    spawn: (cmd: string, args: string[], ...rest: unknown[]) => {
      spawned.push(args.join(' '));
      return spawn(cmd, args, ...rest);
    },
  };
});

import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';

let h: DeliveryHarness;
afterEach(() => {
  h.close();
});

const count = (word: string): number => spawned.filter((line) => line.includes(word)).length;

// docs/architecture/research/delivery-test-timings.md: a start-and-ship flow spawned 16
// `rev-parse --absolute-git-dir` before each cut and ship read the git dirs once per operation.
it('a start and a ship each ask git for the git dirs once, not once per git call', async () => {
  h = createDeliveryHarness();
  const task = h.addTask('Alpha');
  spawned.length = 0;
  const batch = h.only(h.starter.startBatch(h.project.id, { title: 'G', taskIds: [task.id] }));
  await h.jobs.idle();
  expect(count('--absolute-git-dir')).toBe(1);

  h.commit(`src/api/${batch.id}.txt`);
  for (const ws of listWorkstreams(h.store.db, { batchId: batch.id })) h.settle(ws.id, 'DONE');
  await h.jobs.idle();
  expect(getBatch(h.store.db, batch.id).state).toBe('SHIPPED');
  expect(count('--absolute-git-dir')).toBeLessThanOrEqual(3);
});
