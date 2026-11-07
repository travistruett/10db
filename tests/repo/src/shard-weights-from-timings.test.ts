import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runWithFakeGh, type GhReply } from './fake-gh';
import {
  everyShard,
  NoTimingsError,
  renderShardWeights,
  shardWeights,
  type MainRun,
} from './shard-weights-from-timings';
import type { ShardTimings } from './test-report';
import { repoRoot } from './workspace';

type Row = readonly [file: string, seconds: number];

const shard = (index: number, files: readonly Row[], count = 1): ShardTimings => ({
  shard: { index, count },
  files: files.map(([file, seconds]) => ({ file, tests: 1, seconds })),
});

/** A run of one shard holding `files`. */
const run = (id: number, files: readonly Row[]): MainRun => ({ id, shards: [shard(1, files)] });

describe('shardWeights', () => {
  it.each<{ name: string; runs: MainRun[]; weights: Row[] }>([
    {
      name: 'one run gives its seconds, rounded',
      runs: [run(1, [['a.test.ts', 6.4]])],
      weights: [['a.test.ts', 6]],
    },
    {
      name: 'three runs give the middle one, so one slow run moves nothing',
      runs: [
        run(1, [['a.test.ts', 10]]),
        run(2, [['a.test.ts', 100]]),
        run(3, [['a.test.ts', 12]]),
      ],
      weights: [['a.test.ts', 12]],
    },
    {
      name: 'two runs give the mean of the two',
      runs: [run(1, [['a.test.ts', 10]]), run(2, [['a.test.ts', 13]])],
      weights: [['a.test.ts', 12]],
    },
    {
      name: 'a file missing from a run takes the median of the runs that ran it',
      runs: [run(1, [['a.test.ts', 8]]), run(2, [['b.test.ts', 9]]), run(3, [['b.test.ts', 9]])],
      weights: [
        ['b.test.ts', 9],
        ['a.test.ts', 8],
      ],
    },
    {
      name: 'a file two shards or projects ran counts once in its run, summed',
      runs: [{ id: 1, shards: [shard(1, [['a.test.ts', 3]], 2), shard(2, [['a.test.ts', 2]], 2)] }],
      weights: [['a.test.ts', 5]],
    },
    {
      name: 'a file at 4 s is listed and one under it is not',
      runs: [
        run(1, [
          ['at.test.ts', 4],
          ['under.test.ts', 3.9],
        ]),
      ],
      weights: [['at.test.ts', 4]],
    },
    {
      name: 'the cut-off applies to the median, not to any one run',
      runs: [run(1, [['a.test.ts', 9]]), run(2, [['a.test.ts', 2]]), run(3, [['a.test.ts', 3]])],
      weights: [],
    },
    {
      name: 'slowest first, then by path, so a refresh changes only the lines that moved',
      runs: [
        run(1, [
          ['c.test.ts', 5],
          ['b.test.ts', 7],
          ['a.test.ts', 5],
        ]),
      ],
      weights: [
        ['b.test.ts', 7],
        ['a.test.ts', 5],
        ['c.test.ts', 5],
      ],
    },
  ])('$name', ({ runs, weights }) => {
    expect(shardWeights(runs)).toEqual(weights);
  });

  it('refuses no runs, so a failed lookup never writes an empty list', () => {
    expect(() => shardWeights([])).toThrow(NoTimingsError);
  });
});

describe('everyShard', () => {
  it.each<{ name: string; shards: ShardTimings[]; complete: boolean }>([
    { name: 'all of them', shards: [shard(1, [], 2), shard(2, [], 2)], complete: true },
    { name: 'one missing', shards: [shard(1, [], 2)], complete: false },
    {
      name: 'one twice and one missing',
      shards: [shard(1, [], 2), shard(1, [], 2)],
      complete: false,
    },
    {
      name: 'shards of two different splits',
      shards: [shard(1, [], 2), shard(2, [], 3)],
      complete: false,
    },
    { name: 'none', shards: [], complete: false },
  ])('$name: $complete', ({ shards, complete }) => {
    expect(everyShard(shards)).toBe(complete);
  });
});

describe('renderShardWeights', () => {
  it('writes the module the sequencer imports, naming the runs and the command', () => {
    const text = renderShardWeights(
      [
        ['apps/a.test.ts', 12],
        ["it's.test.ts", 5],
      ],
      [7, 9],
    );
    expect(text).toContain('`make shard-weights`');
    expect(text).toContain('main runs 7 and 9');
    expect(text).toContain(
      [
        'export const SHARD_WEIGHTS: Readonly<Record<string, number>> = {',
        "  'apps/a.test.ts': 12,",
        "  'it\\'s.test.ts': 5,",
        '};',
      ].join('\n'),
    );
    expect(text.endsWith('export const UNWEIGHTED_FILE_SECONDS = 1;\n')).toBe(true);
  });
});

describe('scripts/shard-weights.mjs', () => {
  const script = join(repoRoot, 'scripts/shard-weights.mjs');
  const repository = 'owner/repo';
  const runs = `api repos/${repository}/actions/workflows/ci.yml/runs`;
  const artifacts = (id: number) => `api repos/${repository}/actions/runs/${String(id)}/artifacts`;
  const listed = (names: readonly string[], expired = false) => ({
    stdout: JSON.stringify({ artifacts: names.map((name) => ({ name, expired })) }),
  });
  const bothShards = ['test-timings-1', 'test-timings-2'];
  /** A download of a two-shard run in which `a.test.ts` took `seconds`; `firstOnly` drops shard 2. */
  const download = (id: number, seconds: number, firstOnly = false): GhReply => ({
    args: `run download ${String(id)}`,
    downloads: {
      'test-timings-1/test-timings.json': JSON.stringify(shard(1, [['a.test.ts', seconds]], 2)),
      ...(firstOnly
        ? {}
        : { 'test-timings-2/test-timings.json': JSON.stringify(shard(2, [['b.test.ts', 1]], 2)) }),
    },
  });

  function refresh(replies: readonly GhReply[]) {
    const dir = mkdtempSync(join(tmpdir(), 'shard-weights-'));
    const out = join(dir, 'shard-weights.ts');
    writeFileSync(out, 'before\n');
    try {
      const repo = { args: 'repo view', stdout: `${repository}\n` };
      const result = runWithFakeGh(script, [repo, ...replies], {}, undefined, [out]);
      return { ...result, written: readFileSync(out, 'utf8') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('takes the newest three runs that left every shard, and skips the rest', () => {
    const result = refresh([
      {
        args: runs,
        stdout: JSON.stringify({
          workflow_runs: [{ id: 6 }, { id: 5 }, { id: 4 }, { id: 3 }, { id: 2 }, { id: 1 }],
        }),
      },
      { args: artifacts(6), ...listed(['test-timings-1']) },
      { args: artifacts(5), ...listed(bothShards, true) },
      { args: artifacts(4), ...listed(bothShards) },
      { args: artifacts(3), ...listed(bothShards) },
      { args: artifacts(2), ...listed(bothShards) },
      download(6, 999, true),
      download(4, 20),
      download(3, 10),
      download(2, 30),
    ]);
    expect(result.stderr).toContain('run 6');
    expect(result.status).toBe(0);
    const downloaded = result.calls.flatMap(({ args }) =>
      args.startsWith('run download') ? [args.split(' ')[2]] : [],
    );
    expect(downloaded).toEqual(['6', '4', '3', '2']);
    expect(result.calls.some(({ args }) => args.startsWith(artifacts(1)))).toBe(false);
    expect(result.written).toContain("  'a.test.ts': 20,\n");
    expect(result.written).toContain('main runs 4, 3 and 2');
  });

  it('writes nothing and fails when fewer than three runs left every shard', () => {
    const result = refresh([
      { args: runs, stdout: JSON.stringify({ workflow_runs: [{ id: 2 }, { id: 1 }] }) },
      { args: artifacts(2), ...listed(bothShards) },
      { args: artifacts(1), ...listed(bothShards) },
      download(2, 20),
      download(1, 10),
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('2 of 3');
    expect(result.written).toBe('before\n');
  });
});
