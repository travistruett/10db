import { describe, expect, it } from 'vitest';
import { simulateFactory, type ScheduleItem } from './preview-schedule';

// Shape spec §10.2 and §15: two tasks clashing on an area, work already queued holding a lane, and
// unsized running work (whose remaining hours the caller estimates before it gets here).

const item = (key: string, hours: number, rest: Partial<ScheduleItem> = {}): ScheduleItem => ({
  key,
  title: key.toUpperCase(),
  hours,
  areas: [key],
  dependsOn: [],
  existing: null,
  ...rest,
});

const startsOf = (result: ReturnType<typeof simulateFactory>): Record<string, number> =>
  Object.fromEntries(
    result.lanes.flatMap((lane) => lane.items.map((i) => [i.key, i.startHours] as const)),
  );

describe('the lane schedule', () => {
  it('runs unrelated tasks side by side', () => {
    const out = simulateFactory(2, [item('a', 2), item('b', 3)]);
    expect(startsOf(out)).toEqual({ a: 0, b: 0 });
    expect(out.scheduleHours).toBe(3);
    expect(out.lanes).toHaveLength(2);
  });

  it('runs tasks that claim one area one after the other, though a lane is free', () => {
    const out = simulateFactory(2, [
      item('a', 2, { areas: ['desktop'] }),
      item('b', 1, { areas: ['desktop'] }),
    ]);
    expect(startsOf(out)).toEqual({ a: 0, b: 2 });
    expect(out.scheduleHours).toBe(3);
    expect(out.clashes).toEqual([
      {
        area: 'desktop',
        titles: ['A', 'B'],
        text: "A and B both claim desktop: they'll run one after the other",
      },
    ]);
  });

  it('names every task of an area claimed by three, once', () => {
    const out = simulateFactory(3, [
      item('a', 1, { areas: ['desktop'] }),
      item('b', 1, { areas: ['desktop'] }),
      item('c', 1, { areas: ['desktop'] }),
    ]);
    expect(out.clashes).toEqual([
      {
        area: 'desktop',
        titles: ['A', 'B', 'C'],
        text: "A, B and C all claim desktop: they'll run one after the other",
      },
    ]);
  });

  it('makes no clash of tasks that already run in order', () => {
    const out = simulateFactory(2, [
      item('a', 1, { areas: ['desktop'] }),
      item('b', 1, { areas: ['desktop'], dependsOn: ['a'] }),
    ]);
    expect(out.clashes).toEqual([]);
    expect(startsOf(out)).toEqual({ a: 0, b: 1 });
  });

  it('holds a task until what it depends on has ended', () => {
    const out = simulateFactory(2, [item('a', 2), item('b', 1, { dependsOn: ['a'] })]);
    expect(startsOf(out)).toEqual({ a: 0, b: 2 });
  });

  it('takes a dependency outside the plan as already met', () => {
    const out = simulateFactory(1, [item('a', 1, { dependsOn: ['finished-earlier'] })]);
    expect(startsOf(out)).toEqual({ a: 0 });
  });

  it('starts the longest chain first when lanes are short', () => {
    const out = simulateFactory(1, [
      item('short', 1),
      item('head', 1),
      item('tail', 4, { dependsOn: ['head'] }),
    ]);
    expect(startsOf(out)).toEqual({ head: 0, tail: 1, short: 5 });
  });
});

describe('work already in the project', () => {
  it('lets running work hold its lane for its remaining hours', () => {
    const out = simulateFactory(1, [item('run', 3, { existing: 'running' }), item('new', 1)]);
    expect(startsOf(out)).toEqual({ run: 0, new: 3 });
    expect(out.lanes[0]?.items.map((i) => i.existing)).toEqual([true, false]);
  });

  it('lets queued work take a lane ahead of the draft', () => {
    const out = simulateFactory(1, [item('queued', 2, { existing: 'queued' }), item('new', 1)]);
    expect(startsOf(out)).toEqual({ queued: 0, new: 2 });
  });

  it('holds the areas running work claims', () => {
    const out = simulateFactory(2, [
      item('run', 2, { existing: 'running', areas: ['desktop'] }),
      item('new', 1, { areas: ['desktop'] }),
    ]);
    expect(startsOf(out)).toEqual({ run: 0, new: 2 });
    expect(out.clashes[0]?.text).toBe("NEW claims desktop, which RUN holds: it'll wait for it");
  });

  it('keeps running work on lanes beyond the cap, so the schedule shows it', () => {
    const out = simulateFactory(1, [
      item('r1', 1, { existing: 'running' }),
      item('r2', 1, { existing: 'running' }),
      item('new', 1),
    ]);
    expect(out.lanes).toHaveLength(2);
    expect(startsOf(out)['new']).toBe(1);
  });
});

describe('the critical path', () => {
  it('follows the chain of dependencies that ends last', () => {
    const out = simulateFactory(2, [
      item('a', 2),
      item('b', 3, { dependsOn: ['a'] }),
      item('c', 1),
    ]);
    expect(out.criticalPath).toEqual(['a', 'b']);
    const marked = out.lanes.flatMap((l) => l.items).filter((i) => i.critical);
    expect(marked.map((i) => i.key).sort()).toEqual(['a', 'b']);
  });

  it('runs through a task that held the lane or the area', () => {
    const out = simulateFactory(1, [item('a', 2), item('b', 3)]);
    expect(out.criticalPath).toEqual(['b', 'a']);
  });

  it('is empty for an empty plan', () => {
    const out = simulateFactory(2, []);
    expect(out).toMatchObject({ criticalPath: [], scheduleHours: 0, clashes: [] });
  });
});
