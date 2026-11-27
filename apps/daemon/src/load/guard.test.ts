import { expect, test } from 'vitest';
import { ManualClock } from '../clock';
import { silentLogger } from '../log';
import { createLoadGuard, CULPRITS_WAIT_MS } from './guard';

test('a read of the busy processes that never ends does not keep new work held once the load falls', async () => {
  const clock = new ManualClock();
  let load = 100;
  const guard = createLoadGuard({
    clock,
    logger: silentLogger,
    read: () => ({ load, cores: 8 }),
    // ps or lsof that never answers.
    culprits: () => new Promise(() => undefined),
    onOverloaded: () => undefined,
    onCleared: () => undefined,
    sustainedMs: 0,
  });

  const overloaded = guard.sample();
  expect(guard.holding()).toBe(true);
  clock.advance(CULPRITS_WAIT_MS);
  await overloaded;

  load = 1;
  await guard.sample();
  expect(guard.holding()).toBe(false);
});
