import { describe, expect, it } from 'vitest';
import { assignShards } from './shard-sequencer';

const FILE_SECONDS = 1;

/** The seconds each shard would take, heaviest first. */
function shardSeconds(shards: readonly (readonly string[])[], weights: Record<string, number>) {
  return shards
    .map((files) => files.reduce((sum, file) => sum + (weights[file] ?? FILE_SECONDS), 0))
    .sort((a, b) => b - a);
}

describe('assignShards', () => {
  const files = Array.from({ length: 50 }, (_, index) => `f${String(index)}.test.ts`);
  const slow = { 'f1.test.ts': 150, 'f2.test.ts': 110, 'f3.test.ts': 100, 'f4.test.ts': 90 };

  it.each([
    { name: 'one shard', count: 1 },
    { name: 'six shards', count: 6 },
    { name: 'more shards than the slow files', count: 8 },
  ])('puts every file in exactly one shard: $name', ({ count }) => {
    const shards = assignShards(files, slow, FILE_SECONDS, count);
    expect(shards).toHaveLength(count);
    expect(shards.flat().sort()).toEqual([...files].sort());
  });

  it('gives each shard the same files whatever order the files arrive in', () => {
    const reversed = [...files].reverse();
    expect(assignShards(reversed, slow, FILE_SECONDS, 6)).toEqual(
      assignShards(files, slow, FILE_SECONDS, 6),
    );
  });

  it('keeps the slowest files apart', () => {
    const shards = assignShards(files, slow, FILE_SECONDS, 4);
    const together = shards.filter((shard) => shard.filter((file) => file in slow).length > 1);
    expect(together).toEqual([]);
  });

  it('balances by seconds, so no shard runs far past the average', () => {
    const weights = Object.fromEntries(files.map((file, index) => [file, index + 1]));
    const seconds = shardSeconds(assignShards(files, weights, FILE_SECONDS, 6), weights);
    const average = seconds.reduce((sum, value) => sum + value, 0) / seconds.length;
    expect(seconds[0]).toBeLessThan(average * 1.1);
  });

  it('counts a file with no weight as a small file, so a new test file still runs', () => {
    const shards = assignShards(['new.test.ts'], {}, FILE_SECONDS, 1);
    expect(shards).toEqual([['new.test.ts']]);
  });
});
