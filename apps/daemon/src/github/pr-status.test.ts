import { describe, expect, it } from 'vitest';
import {
  createGh,
  summariseChecks,
  UNREADABLE_CHECK,
  type CheckRollupEntry,
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
    rollup: CheckRollupEntry[];
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
    {
      name: 'an entry 10db cannot read beside passing checks',
      rollup: [run('build', 'SUCCESS'), UNREADABLE_CHECK],
      checks: 'unknown',
      failing: [],
    },
    {
      name: 'only entries 10db cannot read',
      rollup: [UNREADABLE_CHECK],
      checks: 'unknown',
      failing: [],
    },
    {
      name: 'an entry 10db cannot read beside a failing check: failing wins',
      rollup: [UNREADABLE_CHECK, run('lint', 'FAILURE')],
      checks: 'failing',
      failing: [{ name: 'lint', url: 'https://github.com/acme/widgets/actions/runs/lint' }],
    },
    {
      name: 'an entry 10db cannot read beside a running check: pending',
      rollup: [UNREADABLE_CHECK, run('test', null)],
      checks: 'pending',
      failing: [],
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
  const HEAD = '0123456789abcdef0123456789abcdef01234567';

  it('reads state and checks, and asks for the rollup', async () => {
    const { gh, seen } = view({
      exitCode: 0,
      stdout: JSON.stringify({
        url: INPUT.ref,
        state: 'OPEN',
        headRefOid: HEAD,
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
      headSha: HEAD,
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
      'url,state,statusCheckRollup,headRefOid',
    ]);
  });

  it("reads a merged pull request's head commit, and none when gh gives none", async () => {
    const merged = view({
      exitCode: 0,
      stdout: JSON.stringify({ url: INPUT.ref, state: 'MERGED', headRefOid: HEAD }),
    });
    await expect(merged.gh.prStatus(INPUT, CALL)).resolves.toMatchObject({ headSha: HEAD });
    const bare = view({
      exitCode: 0,
      stdout: JSON.stringify({ url: INPUT.ref, state: 'MERGED', headRefOid: '' }),
    });
    await expect(bare.gh.prStatus(INPUT, CALL)).resolves.toMatchObject({ headSha: null });
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

  // gh looks a URL up by number and prints GitHub's GraphQL error as it came (go-gh's GraphQLError:
  // "GraphQL: <message> (<path>)"); "no pull requests found" is only its branch lookup's wording.
  it.each([
    [
      'the pull request',
      'GraphQL: Could not resolve to a PullRequest with the number of 8. (repository.pullRequest)',
    ],
    [
      'its repository, deleted or closed to the account',
      "GraphQL: Could not resolve to a Repository with the name 'acme/widgets'. (repository)",
    ],
  ])('answers null when GitHub cannot find %s', async (_name, stderr) => {
    const { gh } = view({ exitCode: 1, stderr });
    await expect(gh.prStatus(INPUT, CALL)).resolves.toBeNull();
  });

  // gh prints its own line for a DNS failure and Go's error text for any other network failure.
  it.each([
    [
      'a DNS failure',
      'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com',
    ],
    [
      'a connection that timed out',
      'Post "https://api.github.com/graphql": dial tcp 140.82.112.6:443: i/o timeout',
    ],
    [
      'a refused connection',
      'Post "https://api.github.com/graphql": dial tcp 140.82.112.6:443: connect: connection refused',
    ],
    [
      'a TLS handshake that timed out',
      'Post "https://api.github.com/graphql": net/http: TLS handshake timeout',
    ],
  ])('fails as unreachable on %s', async (_name, stderr) => {
    const { gh } = view({ exitCode: 1, stderr });
    await expect(gh.prStatus(INPUT, CALL)).rejects.toMatchObject({
      name: 'GhError',
      kind: 'unreachable',
      message: `gh pr view failed (exit 1): ${stderr}`,
    });
  });

  it('fails on a GitHub server error as an answer, not as unreachable', async () => {
    const { gh } = view({
      exitCode: 1,
      stderr: 'HTTP 502: Bad Gateway (https://api.github.com/graphql)',
    });
    await expect(gh.prStatus(INPUT, CALL)).rejects.toMatchObject({
      name: 'GhError',
      kind: 'failed',
    });
  });

  it('fails on any other GitHub error', async () => {
    const { gh } = view({
      exitCode: 1,
      stderr:
        'GraphQL: Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization. (repository)',
    });
    await expect(gh.prStatus(INPUT, CALL)).rejects.toMatchObject({
      name: 'GhError',
      kind: 'failed',
    });
  });

  it('is signed out on exit 4', async () => {
    const { gh } = view({ exitCode: 4 });
    await expect(gh.prStatus(INPUT, CALL)).rejects.toMatchObject({
      name: 'GhError',
      kind: 'signed_out',
    });
  });

  it.each([
    {
      name: 'a kind of entry GitHub adds later, beside a passing run',
      rollup: [
        { __typename: 'Mystery', name: 'deploy', result: 'BAD' },
        { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
      checks: 'unknown',
      failing: [],
    },
    {
      name: 'a check run missing its name, beside a failing status',
      rollup: [
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
        { __typename: 'StatusContext', context: 'ci/x', state: 'ERROR', targetUrl: null },
      ],
      checks: 'failing',
      failing: [{ name: 'ci/x', url: null }],
    },
  ])(
    'reads the state and the rest of the rollup around $name',
    async ({ rollup, checks, failing }) => {
      const { gh } = view({
        exitCode: 0,
        stdout: JSON.stringify({ url: INPUT.ref, state: 'OPEN', statusCheckRollup: rollup }),
      });
      await expect(gh.prStatus(INPUT, CALL)).resolves.toEqual({
        url: INPUT.ref,
        state: 'OPEN',
        headSha: null,
        checks,
        failingChecks: failing,
      });
    },
  );

  it.each([
    ['output that is not JSON', 'not json'],
    [
      'a rollup that is not a list',
      JSON.stringify({ url: INPUT.ref, state: 'OPEN', statusCheckRollup: { contexts: [] } }),
    ],
    [
      'a state 10db does not know',
      JSON.stringify({ url: INPUT.ref, state: 'DRAFTED', statusCheckRollup: [] }),
    ],
  ])('fails on %s', async (_name, stdout) => {
    const { gh } = view({ exitCode: 0, stdout });
    await expect(gh.prStatus(INPUT, CALL)).rejects.toMatchObject({
      name: 'GhError',
      kind: 'failed',
    });
  });
});
