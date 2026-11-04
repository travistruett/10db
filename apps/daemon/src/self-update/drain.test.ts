import { describe, expect, it } from 'vitest';
import { createDrain, holdBoth } from './drain';

const SINCE = new Date('2026-11-03T12:00:00.000Z');
const settled = () => new Promise((resolve) => setImmediate(resolve));

describe('the drain', () => {
  it('lets work start while it is not draining', async () => {
    const drain = createDrain();
    expect(drain.draining).toBe(false);
    expect(drain.since).toBeNull();
    expect(await drain.untilClear()).toBe(true);
    expect(drain.parked()).toBe(0);
  });

  it('holds work from the moment it begins, and says since when', async () => {
    const drain = createDrain();
    drain.begin(SINCE);
    expect(drain.draining).toBe(true);
    expect(drain.since).toEqual(SINCE);
    let released: boolean | null = null;
    void drain.untilClear().then((result) => {
      released = result;
    });
    await settled();
    expect(released).toBeNull();
    expect(drain.parked()).toBe(1);
  });

  it('releases every waiter with true when it ends, and counts none parked after', async () => {
    const drain = createDrain();
    drain.begin(SINCE);
    const waiting = [drain.untilClear(), drain.untilClear()];
    expect(drain.parked()).toBe(2);
    drain.end();
    expect(await Promise.all(waiting)).toEqual([true, true]);
    expect(drain.parked()).toBe(0);
    expect(drain.draining).toBe(false);
    expect(drain.since).toBeNull();
  });

  it('keeps the first start when it begins twice', () => {
    const drain = createDrain();
    drain.begin(SINCE);
    drain.begin(new Date(SINCE.getTime() + 60_000));
    expect(drain.since).toEqual(SINCE);
  });

  it('releases a waiter whose signal aborts with false, and it is no longer parked', async () => {
    const drain = createDrain();
    drain.begin(SINCE);
    const abort = new AbortController();
    const waiting = drain.untilClear(abort.signal);
    expect(drain.parked()).toBe(1);
    abort.abort();
    expect(await waiting).toBe(false);
    expect(drain.parked()).toBe(0);
  });

  it('releases waiters with true on shutdown', async () => {
    const drain = createDrain();
    drain.begin(SINCE);
    const waiting = drain.untilClear();
    drain.stop();
    expect(await waiting).toBe(true);
  });
});

describe('holdBoth', () => {
  const load = () => {
    let overloaded = false;
    const waiters: (() => void)[] = [];
    return {
      holding: () => overloaded,
      set(value: boolean) {
        overloaded = value;
        if (!value) for (const wake of waiters.splice(0)) wake();
      },
      untilClear: (): Promise<boolean> =>
        overloaded
          ? new Promise<boolean>((resolve) => {
              waiters.push(() => {
                resolve(true);
              });
            })
          : Promise.resolve(true),
    };
  };

  it('waits until both are clear, even when one clears while the other starts holding', async () => {
    const guard = load();
    const drain = createDrain();
    const hold = holdBoth([guard, drain]);
    guard.set(true);
    let released = false;
    void hold.untilClear().then(() => {
      released = true;
    });
    await settled();
    // The drain begins while the load still holds; clearing the load must not let work through.
    drain.begin(SINCE);
    guard.set(false);
    await settled();
    expect(released).toBe(false);
    drain.end();
    await settled();
    expect(released).toBe(true);
  });

  it('says it holds while any of them does', () => {
    const guard = load();
    const drain = createDrain();
    const hold = holdBoth([guard, drain]);
    expect(hold.holding()).toBe(false);
    drain.begin(SINCE);
    expect(hold.holding()).toBe(true);
    drain.end();
    guard.set(true);
    expect(hold.holding()).toBe(true);
    guard.set(false);
    expect(hold.holding()).toBe(false);
  });

  it('resolves false when the signal aborts while held', async () => {
    const drain = createDrain();
    drain.begin(SINCE);
    const hold = holdBoth([drain]);
    const abort = new AbortController();
    const waiting = hold.untilClear(abort.signal);
    abort.abort();
    expect(await waiting).toBe(false);
  });
});
