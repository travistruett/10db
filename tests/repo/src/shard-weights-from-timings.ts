import type { ShardTimings } from './test-report';

/** Files whose median is at least this many seconds are listed; the rest count as one second. */
export const LISTED_FROM_SECONDS = 4;

/** The test timings one run of CI on `main` left, one entry per shard. */
export interface MainRun {
  readonly id: number;
  readonly shards: readonly ShardTimings[];
}

/** A test file and the whole seconds it is weighted at. */
export type Weight = readonly [file: string, seconds: number];

/**
 * The runs gave no file slow enough to list. Writing that would weigh every file the same and undo
 * the split, so nothing is written.
 */
export class NoWeightsError extends Error {
  override readonly name = 'NoWeightsError';
  constructor() {
    super(`no test file took ${String(LISTED_FROM_SECONDS)} s or more in the runs on main`);
  }
}

/** Whether `shards` are every shard of one split, each once. */
export function everyShard(shards: readonly ShardTimings[]): boolean {
  const count = shards[0]?.shard.count;
  if (count === undefined || shards.length !== count) return false;
  if (shards.some(({ shard }) => shard.count !== count || shard.index > count)) return false;
  return new Set(shards.map(({ shard }) => shard.index)).size === count;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? 0) + upper) / 2;
}

/**
 * Each file's median seconds over `runs`, for the files at `LISTED_FROM_SECONDS` or more: slowest
 * first, then by path. A file two shards or projects ran is summed within its run, and a file a run
 * didn't have takes the median of the runs that had it, so a renamed or new file still gets a weight.
 * Throws `NoWeightsError` when no file is listed.
 */
export function shardWeights(runs: readonly MainRun[]): Weight[] {
  const seconds = new Map<string, number[]>();
  for (const { shards } of runs) {
    const inRun = new Map<string, number>();
    for (const { file, seconds: taken } of shards.flatMap(({ files }) => files)) {
      inRun.set(file, (inRun.get(file) ?? 0) + taken);
    }
    for (const [file, taken] of inRun) seconds.set(file, [...(seconds.get(file) ?? []), taken]);
  }
  const weights = [...seconds].flatMap(([file, taken]): Weight[] => {
    const middle = median(taken);
    return middle < LISTED_FROM_SECONDS ? [] : [[file, Math.round(middle)]];
  });
  if (weights.length === 0) throw new NoWeightsError();
  return weights.sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0));
}

const quoted = (text: string): string =>
  `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

function listOf(ids: readonly number[]): string {
  const names = ids.map(String);
  const last = names.pop() ?? '';
  return names.length === 0 ? last : `${names.join(', ')} and ${last}`;
}

/** The source of `shard-weights.ts`, as Prettier formats it. */
export function renderShardWeights(weights: readonly Weight[], runIds: readonly number[]): string {
  return [
    '/**',
    ' * Seconds a test file takes on CI, for the files slow enough to unbalance a shard. A file that',
    " * isn't listed counts as `UNWEIGHTED_FILE_SECONDS`. These only steer the split: a stale number",
    ' * makes the shards a little less even, and no number can leave a file out.',
    ' *',
    ' * Written by `make shard-weights` (`scripts/shard-weights.mjs`), never by hand: each file is its',
    ` * median over main runs ${listOf(runIds)}, listed from ${String(LISTED_FROM_SECONDS)} s.`,
    ' */',
    'export const SHARD_WEIGHTS: Readonly<Record<string, number>> = {',
    ...weights.map(([file, seconds]) => `  ${quoted(file)}: ${String(seconds)},`),
    '};',
    '',
    `/** About what a test file under the listed threshold of ${String(LISTED_FROM_SECONDS)} s takes. */`,
    'export const UNWEIGHTED_FILE_SECONDS = 1;',
    '',
  ].join('\n');
}
