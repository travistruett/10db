import { WorkspaceMode } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { startCounts, type StartCountTask } from './start-counts';

function task(key: string, extra: Partial<StartCountTask> = {}): StartCountTask {
  return {
    key,
    title: key.toUpperCase(),
    place: WorkspaceMode.Shared,
    waitsOnStart: [],
    waitsOutside: [],
    ...extra,
  };
}

const run = (
  tasks: StartCountTask[],
  extra: { atOnce?: string[]; local?: boolean } = {},
): ReturnType<typeof startCounts> =>
  startCounts({
    tasks,
    startsAtOnce: new Set(extra.atOnce ?? tasks.map((t) => t.key)),
    local: extra.local ?? false,
    cap: 50,
  });

describe('startCounts', () => {
  it('start counts follow dependencies, places, lanes, local delivery and the 50 cap', () => {
    expect(run([task('a'), task('b')])).toMatchObject({ now: 2, forLane: 0, forOthers: 0 });

    const a = task('a');
    const b = task('b', { waitsOnStart: ['a'] });
    const pair = [a, b];
    expect(run(pair)).toMatchObject({ now: 1, forOthers: 1, stay: [], startKeys: ['a', 'b'] });

    const apart = [task('a', { place: WorkspaceMode.Worktree }), b];
    expect(run(apart)).toMatchObject({
      forOthers: 0,
      stay: [{ title: 'B', why: 'waits for A, which runs in another place' }],
    });

    expect(run(pair, { local: true })).toMatchObject({
      now: 1,
      forOthers: 0,
      stay: [{ title: 'B', why: 'waits for A' }],
    });

    expect(run([task('a', { waitsOutside: ['Other'] })]).stay).toEqual([
      { title: 'A', why: 'waits for Other' },
    ]);

    const many = Array.from({ length: 51 }, (_, i) => task(`t${String(i)}`));
    const capped = run(many);
    expect(capped.now).toBe(50);
    expect(capped.stay).toEqual([{ title: 'T50', why: 'a start takes at most 50' }]);

    expect(run([task('a'), task('b')], { atOnce: ['a'] })).toMatchObject({ now: 1, forLane: 1 });
  });
});
