import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { silentLogger } from '../log';
import { createLoadGuard, type Culprit, type LoadGuard, type OverloadReport } from './guard';

const CORES = 10;
const MINUTE = 60_000;

let clock: ManualClock;
let load: number;
let culprits: Culprit[];
let reports: OverloadReport[];
let cleared: number;
let guard: LoadGuard;

function build(): LoadGuard {
  return createLoadGuard({
    clock,
    logger: silentLogger,
    read: () => ({ load, cores: CORES }),
    culprits: () => Promise.resolve(culprits),
    onOverloaded: (report) => {
      reports.push(report);
    },
    onCleared: () => {
      cleared += 1;
    },
  });
}

/** A sample now, then one per `step` ms until `ms` have passed, at the current load. */
async function sampleFor(ms: number, step = 30_000): Promise<void> {
  await guard.sample();
  for (let waited = 0; waited < ms; waited += step) {
    clock.advance(step);
    await guard.sample();
  }
}

beforeEach(() => {
  clock = new ManualClock();
  load = 1;
  culprits = [];
  reports = [];
  cleared = 0;
  guard = build();
});

afterEach(() => {
  guard.stop();
});

describe('noticing an overloaded Mac', () => {
  it('is not overloaded at an ordinary load, however long it lasts', async () => {
    load = 2 * CORES;
    await sampleFor(30 * MINUTE);
    expect(guard.overloaded).toBe(false);
    expect(reports).toEqual([]);
  });

  it('is not overloaded by a spike that passes within a few minutes', async () => {
    load = 20 * CORES;
    await sampleFor(3 * MINUTE);
    load = 1;
    await sampleFor(MINUTE);
    expect(guard.overloaded).toBe(false);
    expect(reports).toEqual([]);
  });

  it('a spike that ended does not count towards the next one', async () => {
    load = 20 * CORES;
    await sampleFor(3 * MINUTE);
    load = 1;
    await sampleFor(MINUTE);
    load = 20 * CORES;
    await sampleFor(3 * MINUTE);
    expect(guard.overloaded).toBe(false);
  });

  it('is overloaded once the load stays far above the core count for five minutes', async () => {
    load = 20 * CORES;
    await sampleFor(4 * MINUTE);
    expect(guard.overloaded).toBe(false);
    await sampleFor(MINUTE);
    expect(guard.overloaded).toBe(true);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ load: 20 * CORES, cores: CORES });
  });

  it('reports the top CPU users it found', async () => {
    culprits = [
      {
        pid: 4242,
        cpu: 99.5,
        command: 'yes',
        owner: { kind: 'lane', workstreamId: 'ws_1', label: 'task "Fix the thing"' },
      },
    ];
    load = 20 * CORES;
    await sampleFor(5 * MINUTE);
    expect(reports[0]?.culprits).toEqual(culprits);
  });

  it('reports again on later samples while it lasts, so the card names who is busy now', async () => {
    load = 20 * CORES;
    await sampleFor(5 * MINUTE);
    culprits = [{ pid: 7, cpu: 80, command: 'node', owner: { kind: 'other' } }];
    await sampleFor(MINUTE);
    expect(guard.overloaded).toBe(true);
    expect(reports.at(-1)?.culprits).toEqual(culprits);
    expect(cleared).toBe(0);
  });

  it('stays overloaded while the load is still well above the core count, and clears once it falls', async () => {
    load = 20 * CORES;
    await sampleFor(5 * MINUTE);
    // Below the level that started it but not yet calm: holds.
    load = 3 * CORES;
    await sampleFor(5 * MINUTE);
    expect(guard.overloaded).toBe(true);
    load = CORES;
    await sampleFor(30_000);
    expect(guard.overloaded).toBe(false);
    expect(cleared).toBe(1);
  });

  it('says nothing more after it clears', async () => {
    load = 20 * CORES;
    await sampleFor(5 * MINUTE);
    load = 1;
    await sampleFor(MINUTE);
    const count = reports.length;
    await sampleFor(5 * MINUTE);
    expect(reports).toHaveLength(count);
    expect(cleared).toBe(1);
  });

  it('still reports when it cannot read what is using the CPU', async () => {
    guard.stop();
    guard = createLoadGuard({
      clock,
      logger: silentLogger,
      read: () => ({ load: 20 * CORES, cores: CORES }),
      culprits: () => Promise.reject(new Error('ps is not available')),
      onOverloaded: (report) => {
        reports.push(report);
      },
      onCleared: () => undefined,
    });
    await sampleFor(5 * MINUTE);
    expect(guard.overloaded).toBe(true);
    expect(reports[0]?.culprits).toEqual([]);
  });
});

describe('holding work while overloaded', () => {
  it('untilClear resolves at once when the Mac is fine', async () => {
    await expect(guard.untilClear()).resolves.toBe(true);
  });

  it('untilClear waits for the load to fall, then resolves true', async () => {
    load = 20 * CORES;
    await sampleFor(5 * MINUTE);
    let settled: boolean | null = null;
    void guard.untilClear().then((ok) => {
      settled = ok;
    });
    await sampleFor(MINUTE);
    expect(settled).toBeNull();
    load = 1;
    await sampleFor(30_000);
    expect(settled).toBe(true);
  });

  it('untilClear resolves false when its signal aborts, and leaves the others waiting', async () => {
    load = 20 * CORES;
    await sampleFor(5 * MINUTE);
    const abort = new AbortController();
    const aborted = guard.untilClear(abort.signal);
    let other: boolean | null = null;
    void guard.untilClear().then((ok) => {
      other = ok;
    });
    abort.abort();
    await expect(aborted).resolves.toBe(false);
    await Promise.resolve();
    expect(other).toBeNull();
  });

  it('untilClear resolves false for a signal that is already aborted', async () => {
    load = 20 * CORES;
    await sampleFor(5 * MINUTE);
    await expect(guard.untilClear(AbortSignal.abort())).resolves.toBe(false);
  });

  it('stop releases everyone waiting, so shutdown never hangs on the hold', async () => {
    load = 20 * CORES;
    await sampleFor(5 * MINUTE);
    const waiting = guard.untilClear();
    guard.stop();
    await expect(waiting).resolves.toBe(true);
  });
});

describe('overloadedSince', () => {
  it('is null when the Mac was fine throughout', async () => {
    const since = clock.now();
    await sampleFor(10 * MINUTE);
    expect(guard.overloadedSince(since)).toBeNull();
  });

  it('describes the overload while it lasts', async () => {
    const since = clock.now();
    load = 18 * CORES;
    await sampleFor(5 * MINUTE);
    load = 21 * CORES;
    await sampleFor(MINUTE);
    expect(guard.overloadedSince(since)).toEqual({ peakLoad: 21 * CORES, cores: CORES });
  });

  it('still describes an overload that ended after `since`', async () => {
    const since = clock.now();
    load = 20 * CORES;
    await sampleFor(5 * MINUTE);
    load = 1;
    await sampleFor(MINUTE);
    expect(guard.overloaded).toBe(false);
    expect(guard.overloadedSince(since)).toEqual({ peakLoad: 20 * CORES, cores: CORES });
  });

  it('is null for an overload that ended before `since`', async () => {
    load = 20 * CORES;
    await sampleFor(5 * MINUTE);
    load = 1;
    await sampleFor(MINUTE);
    const since = clock.now();
    clock.advance(MINUTE);
    await guard.sample();
    expect(guard.overloadedSince(since)).toBeNull();
  });
});

describe('the sampling loop', () => {
  it('start samples on a timer until stop', async () => {
    load = 20 * CORES;
    guard.start();
    for (let i = 0; i < 12; i += 1) {
      clock.advance(30_000);
      await Promise.resolve();
      await Promise.resolve();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
    expect(guard.overloaded).toBe(true);
    guard.stop();
    expect(clock.pendingTimers()).toBe(0);
  });
});
