import { relative } from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { SHARD_WEIGHTS, UNWEIGHTED_FILE_SECONDS } from './shard-weights';

/**
 * Splits `files` into `count` shards of about the same seconds: the slowest file first, each into
 * the lightest shard so far. It depends only on its arguments and sorts its input, so each of CI's
 * shard jobs computes the same split on its own, and every file lands in exactly one shard.
 */
export function assignShards(
  files: readonly string[],
  weights: Readonly<Record<string, number>>,
  unweighted: number,
  count: number,
): string[][] {
  const seconds = (file: string): number => weights[file] ?? unweighted;
  const shards = Array.from({ length: count }, () => ({ files: [] as string[], seconds: 0 }));
  const slowestFirst = [...files].sort(
    (a, b) => seconds(b) - seconds(a) || (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const file of slowestFirst) {
    const lightest = shards.reduce((best, shard) => (shard.seconds < best.seconds ? shard : best));
    lightest.files.push(file);
    lightest.seconds += seconds(file);
  }
  return shards.map((shard) => shard.files);
}

/**
 * Vitest's own shards split by a hash of the path, which leaves slow files together: six shards took
 * 2m22 to 5m05. This keeps its ordering inside a shard and splits by seconds instead.
 */
export class WeightedShardSequencer extends BaseSequencer {
  override shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    if (!shard) return Promise.resolve(files);
    const pathOf = (file: TestSpecification): string => relative(root, file.moduleId);
    const paths = [...new Set(files.map(pathOf))];
    const shards = assignShards(paths, SHARD_WEIGHTS, UNWEIGHTED_FILE_SECONDS, shard.count);
    const chosen = new Set(shards[shard.index - 1]);
    return Promise.resolve(files.filter((file) => chosen.has(pathOf(file))));
  }
}
