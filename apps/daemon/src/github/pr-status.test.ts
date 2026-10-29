import { describe, expect, it } from 'vitest';
import {
  createGh,
  summariseChecks,
  type CheckRollupItem,
  type GhCall,
  type GhExec,
  type GhOutput,
} from './index';

const CALL: GhCall = { env: {}, timeoutMs: 5_000 };

const run = (
  name: string,
  conclusion: string | null,
  over: Partial<CheckRollupItem> = {},
): CheckRollupItem =>
  ({
    __typename: 'CheckRun',
    name,
    status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
    conclusion,
    detailsUrl: `https://github.com/acme/widgets/actions/runs/${name}`,
    ...over,
  }) as CheckRollupItem;

const status = (
  context: string,
  state: string,
  targetUrl: string | null = null,
): CheckRollupItem => ({
  __typename: 'StatusContext',
  context,
  state,
  targetUrl,
});

describe('summariseChecks', () => {
  it.each<{
    name: string;
    rollup: CheckRollupItem[];
    checks: string;
    failing: { name: string; url: string | null }[];
  }>([
    {
      name: 'every check passed',
      rollup: [run('build', 'SUCCESS'), status('ci/deploy', 'SUCCESS')],
      checks: 'passing',
      failing: [],
    },
    {
      name: 'one check failed',
      rollup: [run('build', 'SUCCESS'), run('lint', 'FAILURE')],
      checks: 'failing',
      failing: [{ name: 'lint', url: 'https://github.com/acme/widgets/actions/runs/lint' }],
    },
    {
      name: 'a run is still going',
      rollup: [run('build', 'SUCCESS'), run('test', null)],
      checks: 'pending',
      failing: [],
    },
    {
      name: 'a status is pending',
      rollup: [run('build', 'SUCCESS'), status('ci/deploy', 'PENDING')],
      checks: 'pending',
      failing: [],
    },
    {
      name: 'a status is expected',
      rollup: [status('ci/deploy', 'EXPECTED')],
      checks: 'pending',
      failing: [],
    },
    {
      name: 'one failed and one pending: failing wins',
      rollup: [run('test', null), run('lint', 'TIMED_OUT')],
      checks: 'failing',
      failing: [{ name: 'lint', url: 'https://github.com/acme/widgets/actions/runs/lint' }],
    },
    {
      name: 'only cancelled, skipped, neutral and stale runs',
      rollup: [run('a', 'CANCELLED'), run('b', 'SKIPPED'), run('c', 'NEUTRAL'), run('d', 'STALE')],
      checks: 'passing',
      failing: [],
    },
    { name: 'no checks at all', rollup: [], checks: 'none', failing: [] },
    {
      name: 'a status in ERROR',
      rollup: [status('ci/deploy', 'ERROR', 'https://ci.example.com/job/1')],
      checks: 'failing',
      failing: [{ name: 'ci/deploy', url: 'https://ci.example.com/job/1' }],
    },
    {
      name: 'a status in FAILURE',
      rollup: [status('ci/deploy', 'FAILURE')],
      checks: 'failing',
      failing: [{ name: 'ci/deploy', url: null }],
    },
    {
      name: 'a conclusion nobody has heard of',
      rollup: [run('build', 'SOMETHING_NEW')],
      checks: 'passing',
      failing: [],
    },
    {
      name: 'ACTION_REQUIRED and STARTUP_FAILURE fail',
      rollup: [run('a', 'ACTION_REQUIRED', { detailsUrl: null }), run('b', 'STARTUP_FAILURE')],
      checks: 'failing',
      failing: [
        { name: 'a', url: null },
        { name: 'b', url: 'https://github.com/acme/widgets/actions/runs/b' },
      ],
    },
    {
      name: 'a link that is not https is dropped',
      rollup: [
        run('a', 'FAILURE', { detailsUrl: 'javascript:alert(1)' }),
        status('b', 'FAILURE', 'http://x.test/1'),
      ],
      checks: 'failing',
      failing: [
        { name: 'a', url: null },
        { name: 'b', url: null },
      ],
    },
  ])('$name', ({ rollup, checks, failing }) => {
    expect(summariseChecks(rollup)).toEqual({ checks, failingChecks: failing });
  });
});

describe('Gh.prStatus', () => {
  const view = (answer: Partial<GhOutput> & { exitCode: number }) => {
    const seen: (readonly string[])[] = [];
    const exec: GhExec = (args) => {
      seen.push(args);
      return Promise.resolve({ stdout: '', stderr: '', ...answer });
    };
    return { gh: createGh(exec), seen };
  };
  const INPUT = { repo: 'acme/widgets', ref: 'https://github.com/acme/widgets/pull/8' };

  it('reads state and checks, and asks for the rollup', async () => {
    const { gh, seen } = view({
      exitCode: 0,
      stdout: JSON.stringify({
        url: INPUT.ref,
        state: 'OPEN',
        statusCheckRollup: [
          {
            __typename: 'CheckRun',
            name: 'build',
            status: 'COMPLETED',
            conclusion: 'FAILURE',
            detailsUrl: 'https://github.com/acme/widgets/actions/runs/1',
            workflowName: 'CI',
            startedAt: '2026-10-29T12:00:00Z',
          },
          { __typename: 'StatusContext', context: 'ci/x', state: 'SUCCESS', targetUrl: '' },
        ],
      }),
    });
    await expect(gh.prStatus(INPUT, CALL)).resolves.toEqual({
      url: INPUT.ref,
      state: 'OPEN',
      checks: 'failing',
      failingChecks: [{ name: 'build', url: 'https://github.com/acme/widgets/actions/runs/1' }],
    });
    expect(seen[0]).toEqual([
      'pr',
      'view',
      INPUT.ref,
      '-R',
      'acme/widgets',
      '--json',
      'url,state,statusCheckRollup',
    ]);
  });

  it('reads a pull request with no checks', async () => {
    const { gh } = view({
      exitCode: 0,
      stdout: JSON.stringify({ url: INPUT.ref, state: 'MERGED', statusCheckRollup: [] }),
    });
    await expect(gh.prStatus(INPUT, CALL)).resolves.toMatchObject({
      state: 'MERGED',
      checks: 'none',
    });
  });

  it('answers null when there is no pull request', async () => {
    const { gh } = view({ exitCode: 1, stderr: 'no pull requests found for branch "x"' });
    await expect(gh.prStatus(INPUT, CALL)).resolves.toBeNull();
  });

  it('is signed out on exit 4', async () => {
    const { gh } = view({ exitCode: 4 });
    await expect(gh.prStatus(INPUT, CALL)).rejects.toMatchObject({
      name: 'GhError',
      kind: 'signed_out',
    });
  });

  it.each([
    ['output that is not JSON', 'not json'],
    [
      'an unreadable rollup',
      JSON.stringify({
        url: INPUT.ref,
        state: 'OPEN',
        statusCheckRollup: [{ __typename: 'Mystery' }],
      }),
    ],
  ])('fails on %s', async (_name, stdout) => {
    const { gh } = view({ exitCode: 0, stdout });
    await expect(gh.prStatus(INPUT, CALL)).rejects.toMatchObject({
      name: 'GhError',
      kind: 'failed',
    });
  });
});
