import { describe, expect, it } from 'vitest';
import {
  createGh,
  jobIdsOfLink,
  parseJobLog,
  parseRequiredChecks,
  type GhCall,
  type GhExec,
  type GhOutput,
} from './index';

const CALL: GhCall = { env: {}, timeoutMs: 5_000 };
const REPO = 'acme/widgets';
const PR = 'https://github.com/acme/widgets/pull/8';
const JOB_LINK = 'https://github.com/acme/widgets/actions/runs/1111/job/2222';

const out = (exitCode: number, stdout = '', stderr = ''): GhOutput => ({
  exitCode,
  stdout,
  stderr,
});

/**
 * What gh prints for `gh pr checks --required --json name,state,bucket,link,workflow,description`: a
 * JSON list on stdout, with `description` "" when a check has none. Exit 0 when every check passed, 1
 * when one failed and 8 when one is pending (gh's documented codes); none is an error on stderr with
 * exit 1 and nothing on stdout. The `SPIKE_*` fixtures are verbatim from T3's spike with gh 2.83.2
 * (docs/architecture/research/spike-15-gh-ci-checks.md); pending, failing, cancelled, no checks at
 * all and a run in progress were not on hand then, so those follow gh 2.83.2's source and strings.
 */
const check = (
  name: string,
  bucket: string,
  over: Record<string, string | null> = {},
): Record<string, string | null> => ({
  name,
  state: bucket === 'pass' ? 'SUCCESS' : bucket === 'fail' ? 'FAILURE' : 'IN_PROGRESS',
  bucket,
  link: `https://github.com/acme/widgets/actions/runs/1111/job/${String(name.length)}000`,
  workflow: 'CI',
  description: '',
  ...over,
});

/** Spike: `gh pr checks <#193> --required --json …` on a pull request whose required checks passed. */
const SPIKE_PASSING = out(
  0,
  '[{"bucket":"pass","description":"","link":"https://github.com/travistruett/10db/actions/runs/41233997988/job/124633840932","name":"desktop","state":"SUCCESS","workflow":"ci"},{"bucket":"pass","description":"","link":"https://github.com/travistruett/10db/actions/runs/41233997988/job/124633840808","name":"policy","state":"SUCCESS","workflow":"ci"},{"bucket":"pass","description":"","link":"https://github.com/travistruett/10db/actions/runs/41233997988/job/124633840877","name":"gate","state":"SUCCESS","workflow":"ci"},{"bucket":"pass","description":"","link":"https://github.com/travistruett/10db/actions/runs/41233997988/job/124633840887","name":"dependency-review","state":"SUCCESS","workflow":"ci"},{"bucket":"pass","description":"","link":"https://github.com/travistruett/10db/actions/runs/41233997988/job/124633840663","name":"cargo-deny","state":"SUCCESS","workflow":"ci"}]\n',
);
/** Spike: the same on #194, a pull request into a base with checks but none required. */
const SPIKE_NO_REQUIRED = out(
  1,
  '',
  "no required checks reported on the 'fix/next-live-test-logger' branch\n",
);
/** Spike: any gh call with no sign-in. */
const SPIKE_SIGNED_OUT = out(
  4,
  '',
  'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n',
);
/**
 * Spike: the head of `gh run view --job 124622919963 --log-failed` for a completed failed job. Each line
 * is `<job>\t<step>\t<timestamp> <text>`; gh 2.83.2 named every step UNKNOWN STEP and printed the whole
 * job's log, and the first line carries a byte order mark.
 */
const SPIKE_FAILED_LOG = [
  "desktop\tUNKNOWN STEP\t﻿2026-10-31T18:37:15.7644390Z Current runner version: '2.338.2'",
  'desktop\tUNKNOWN STEP\t2026-10-31T18:37:15.7661290Z ##[group]Runner Image Provisioner',
  'desktop\tUNKNOWN STEP\t2026-10-31T18:37:17.7695600Z Complete job name: desktop',
  '',
].join('\n');

const list = (...checks: Record<string, string | null>[]): string => JSON.stringify(checks);

describe('jobIdsOfLink', () => {
  it.each([
    {
      name: 'an Actions job link',
      link: JOB_LINK,
      ids: { runId: '1111', jobId: '2222' },
    },
    {
      name: 'a job link on another host (an enterprise server)',
      link: 'https://ghe.example.com/acme/widgets/actions/runs/7/job/9',
      ids: { runId: '7', jobId: '9' },
    },
    {
      name: 'a job link with a trailing slash, a query and a step anchor',
      link: `${JOB_LINK}/?pr=8#step:3:1`,
      ids: { runId: '1111', jobId: '2222' },
    },
    {
      name: 'a link to the run, not to a job',
      link: 'https://github.com/acme/widgets/actions/runs/1111',
      ids: { runId: '1111', jobId: null },
    },
    {
      name: 'a commit status from another CI',
      link: 'https://ci.example.com/build/42',
      ids: { runId: null, jobId: null },
    },
    {
      name: 'a link that is not https',
      link: 'http://github.com/acme/widgets/actions/runs/1111/job/2222',
      ids: { runId: null, jobId: null },
    },
    {
      name: 'a ref in the path that only looks like a job',
      link: 'https://ci.example.com/x/actions/runs/1/job/2/extra',
      ids: { runId: null, jobId: null },
    },
    { name: 'no link', link: null, ids: { runId: null, jobId: null } },
    { name: 'an empty link', link: '', ids: { runId: null, jobId: null } },
    { name: 'text that is no URL', link: 'not a url', ids: { runId: null, jobId: null } },
  ])('reads $name', ({ link, ids }) => {
    expect(jobIdsOfLink(link)).toEqual(ids);
  });
});

describe('what the spike saw gh print', () => {
  it('reads passing required checks as passing', () => {
    expect(parseRequiredChecks(['pr', 'checks'], SPIKE_PASSING)).toEqual({
      state: 'passing',
      failing: [],
      pending: [],
    });
  });

  it('reads a real check link as its run and job, and an empty description as none', () => {
    const items = JSON.parse(SPIKE_PASSING.stdout) as { link: string; name: string }[];
    const failed = JSON.stringify([{ ...items[0], bucket: 'fail', state: 'FAILURE' }]);
    expect(parseRequiredChecks(['pr', 'checks'], out(1, failed))).toEqual({
      state: 'failing',
      failing: [
        {
          name: 'desktop',
          link: 'https://github.com/travistruett/10db/actions/runs/41233997988/job/124633840932',
          runId: '41233997988',
          jobId: '124633840932',
          description: null,
        },
      ],
      pending: [],
    });
  });

  it('reads "no required checks reported" as none', () => {
    expect(parseRequiredChecks(['pr', 'checks'], SPIKE_NO_REQUIRED)).toEqual({
      state: 'none',
      failing: [],
      pending: [],
    });
  });

  it('reads signed out as signed out, never none', () => {
    expect(() => parseRequiredChecks(['pr', 'checks'], SPIKE_SIGNED_OUT)).toThrow(
      expect.objectContaining({ name: 'GhError', kind: 'signed_out' }) as Error,
    );
    expect(() => parseJobLog(['run', 'view'], SPIKE_SIGNED_OUT)).toThrow(
      expect.objectContaining({ name: 'GhError', kind: 'signed_out' }) as Error,
    );
  });

  it('reads a completed failed job’s log as it is, step names and byte order mark included', () => {
    expect(parseJobLog(['run', 'view'], out(0, SPIKE_FAILED_LOG))).toEqual({
      kind: 'ready',
      log: SPIKE_FAILED_LOG,
    });
  });
});

describe('parseRequiredChecks', () => {
  const job = (name: string, over: Record<string, string | null> = {}) => ({
    name,
    link: `https://github.com/acme/widgets/actions/runs/1111/job/${String(name.length)}000`,
    runId: '1111',
    jobId: `${String(name.length)}000`,
    description: null,
    ...over,
  });

  it.each([
    {
      name: 'every required check passed (exit 0)',
      out: out(0, list(check('build', 'pass'), check('lint', 'pass'))),
      expected: { state: 'passing', failing: [], pending: [] },
    },
    {
      name: 'passed and skipped',
      out: out(0, list(check('build', 'pass'), check('deploy', 'skipping'))),
      expected: { state: 'passing', failing: [], pending: [] },
    },
    {
      name: 'one still running (exit 8)',
      out: out(8, list(check('build', 'pass'), check('test', 'pending'))),
      expected: { state: 'pending', failing: [], pending: [job('test')] },
    },
    {
      name: 'one failed (exit 1, with the list on stdout)',
      out: out(1, list(check('build', 'pass'), check('lint', 'fail', { description: 'Failed' }))),
      expected: {
        state: 'failing',
        failing: [job('lint', { description: 'Failed' })],
        pending: [],
      },
    },
    {
      name: 'one failed and one pending: failing wins and both are listed',
      out: out(1, list(check('test', 'pending'), check('lint', 'fail'))),
      expected: { state: 'failing', failing: [job('lint')], pending: [job('test')] },
    },
    {
      name: 'one cancelled and none failed: pending, the run is usually replaced by a newer push',
      out: out(1, list(check('build', 'pass'), check('test', 'cancel'))),
      expected: { state: 'pending', failing: [], pending: [job('test')] },
    },
    {
      name: 'one cancelled and one failed: failing',
      out: out(1, list(check('test', 'cancel'), check('lint', 'fail'))),
      expected: { state: 'failing', failing: [job('lint')], pending: [job('test')] },
    },
    {
      name: 'a failing check with no Actions job (a commit status)',
      out: out(
        1,
        list(check('ci/other', 'fail', { link: 'https://ci.example.com/build/42', workflow: '' })),
      ),
      expected: {
        state: 'failing',
        failing: [
          {
            name: 'ci/other',
            link: 'https://ci.example.com/build/42',
            runId: null,
            jobId: null,
            description: null,
          },
        ],
        pending: [],
      },
    },
    {
      name: 'a failing check with no link at all',
      out: out(1, list(check('ci/other', 'fail', { link: null }))),
      expected: {
        state: 'failing',
        failing: [{ name: 'ci/other', link: null, runId: null, jobId: null, description: null }],
        pending: [],
      },
    },
    {
      name: 'a link that is not https is dropped, with its ids',
      out: out(1, list(check('lint', 'fail', { link: 'javascript:alert(1)' }))),
      expected: {
        state: 'failing',
        failing: [{ name: 'lint', link: null, runId: null, jobId: null, description: null }],
        pending: [],
      },
    },
    {
      name: 'an empty list',
      out: out(0, '[]'),
      expected: { state: 'none', failing: [], pending: [] },
    },
    {
      name: '"no required checks reported" (exit 1, on stderr, nothing on stdout)',
      out: out(1, '', "no required checks reported on the 'feature' branch\n"),
      expected: { state: 'none', failing: [], pending: [] },
    },
    {
      name: '"no required checks reported" in any case',
      out: out(1, '', "No Required Checks reported on the 'x' branch"),
      expected: { state: 'none', failing: [], pending: [] },
    },
    {
      // gh says this, with --required too, when the head commit has no checks at all: a base with no
      // CI, or a pull request pushed before GitHub lists its runs (spec §4).
      name: '"no checks reported" (the head has no checks at all, exit 1, on stderr)',
      out: out(1, '', "no checks reported on the 'feature' branch\n"),
      expected: { state: 'none', failing: [], pending: [] },
    },
    {
      name: '"no checks reported" on a branch name with spaces and quotes',
      out: out(1, '', "no checks reported on the 'fix/it's done' branch"),
      expected: { state: 'none', failing: [], pending: [] },
    },
  ])('reads $name', ({ out: output, expected }) => {
    expect(parseRequiredChecks(['pr', 'checks'], output)).toEqual(expected);
  });

  // The exit code alone does not tell "none" from a failed call: exit 1 is both. Stderr decides.
  it.each([
    {
      name: 'a network error with the same exit code as none',
      out: out(
        1,
        '',
        'Post "https://api.github.com/graphql": dial tcp 140.82.112.6:443: i/o timeout',
      ),
      kind: 'unreachable',
    },
    {
      name: 'a DNS failure',
      out: out(
        1,
        '',
        'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com',
      ),
      kind: 'unreachable',
    },
    {
      name: 'an auth failure with exit 1',
      out: out(1, '', 'To get started with GitHub CLI, please run:  gh auth login'),
      kind: 'signed_out',
    },
    { name: 'an auth failure with exit 4', out: out(4), kind: 'signed_out' },
    {
      name: 'a server error',
      out: out(1, '', 'HTTP 502: Bad Gateway (https://api.github.com/graphql)'),
      kind: 'failed',
    },
    {
      name: 'a pull request gh cannot find',
      out: out(1, '', 'no pull requests found for branch "x"'),
      kind: 'failed',
    },
    {
      name: 'the words of none inside another error',
      out: out(1, '', "HTTP 502: proxy said no checks reported on the 'x' branch, retry"),
      kind: 'failed',
    },
    {
      name: 'the words of none beside a network error',
      out: out(
        1,
        '',
        "no checks reported on the 'x' branch\ndial tcp 1.2.3.4:443: connection refused",
      ),
      kind: 'unreachable',
    },
    {
      name: 'the words of none with exit 8',
      out: out(8, '', "no checks reported on the 'x' branch"),
      kind: 'failed',
    },
    { name: 'exit 8 with nothing on stdout', out: out(8), kind: 'failed' },
    { name: 'exit 1 with nothing at all', out: out(1), kind: 'failed' },
    {
      name: 'a message of none beside output on stdout that is not a list',
      out: out(1, 'oops', 'no required checks reported on the x branch'),
      kind: 'failed',
    },
    {
      name: 'an auth failure printed with a list of exit 4',
      out: out(4, list(check('build', 'pass')), 'gh auth login'),
      kind: 'signed_out',
    },
    { name: 'output that is not JSON', out: out(0, 'not json'), kind: 'failed' },
    { name: 'JSON that is not a list', out: out(0, '{"a":1}'), kind: 'failed' },
    {
      name: 'a check missing its name',
      out: out(0, JSON.stringify([{ bucket: 'pass' }])),
      kind: 'failed',
    },
    {
      name: 'a bucket 10db does not know',
      out: out(0, list(check('build', 'mystery'))),
      kind: 'failed',
    },
  ])('is unknown, never none, for $name', ({ out: output, kind }) => {
    let thrown: unknown;
    try {
      parseRequiredChecks(['pr', 'checks'], output);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ name: 'GhError', kind });
  });
});

describe('parseJobLog', () => {
  it('reads the log of a completed failed job', () => {
    const log = 'lint\tRun lint\t2026-10-31T12:00:00.0000000Z error: boom\n';
    expect(parseJobLog(['run', 'view'], out(0, log))).toEqual({ kind: 'ready', log });
  });

  it('reads a completed job with nothing failed as an empty log, not as not yet', () => {
    expect(parseJobLog(['run', 'view'], out(0, ''))).toEqual({ kind: 'ready', log: '' });
  });

  it.each([
    'job 2222 is still in progress; logs will be available when it is complete',
    'run 1111 is still in progress; logs will be available when it is complete',
    'Job 2222 Is Still In Progress; logs will be available when it is complete\n',
  ])('answers not yet while the run is in progress: %s', (stderr) => {
    expect(parseJobLog(['run', 'view'], out(1, '', stderr))).toEqual({ kind: 'not_yet' });
  });

  it.each([
    { name: 'a log that is gone', out: out(1, '', 'HTTP 410: Gone'), kind: 'failed' },
    {
      name: 'a job that does not exist',
      out: out(1, '', 'HTTP 404: Not Found (https://api.github.com/repos/a/b/actions/jobs/1)'),
      kind: 'failed',
    },
    {
      name: 'a network error',
      out: out(1, '', 'Get "https://api.github.com/x": dial tcp 1.2.3.4:443: i/o timeout'),
      kind: 'unreachable',
    },
    { name: 'signed out', out: out(4), kind: 'signed_out' },
  ])('fails on $name, not as not yet', ({ out: output, kind }) => {
    let thrown: unknown;
    try {
      parseJobLog(['run', 'view'], output);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ name: 'GhError', kind });
  });
});

describe('Gh.prRequiredChecks, Gh.jobLog and Gh.rerunFailed', () => {
  const gh = (answer: GhOutput | Error) => {
    const seen: (readonly string[])[] = [];
    const exec: GhExec = (args) => {
      seen.push(args);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    };
    return { gh: createGh(exec), seen };
  };

  it('asks for the required checks of the pull request by URL', async () => {
    const { gh: client, seen } = gh(out(0, list(check('build', 'pass'))));
    await expect(client.prRequiredChecks({ repo: REPO, url: PR }, CALL)).resolves.toEqual({
      state: 'passing',
      failing: [],
      pending: [],
    });
    expect(seen).toEqual([
      [
        'pr',
        'checks',
        PR,
        '-R',
        REPO,
        '--required',
        '--json',
        'name,state,bucket,link,workflow,description',
      ],
    ]);
  });

  it('answers none for no required checks, and throws for a failed call with the same exit code', async () => {
    await expect(
      gh(out(1, '', "no required checks reported on the 'x' branch")).gh.prRequiredChecks(
        { repo: REPO, url: PR },
        CALL,
      ),
    ).resolves.toEqual({ state: 'none', failing: [], pending: [] });
    await expect(
      gh(out(1, '', 'dial tcp 1.2.3.4:443: connection refused')).gh.prRequiredChecks(
        { repo: REPO, url: PR },
        CALL,
      ),
    ).rejects.toMatchObject({ name: 'GhError', kind: 'unreachable' });
  });

  it('reads a failed job log by job id', async () => {
    const { gh: client, seen } = gh(out(0, 'the log\n'));
    await expect(client.jobLog({ repo: REPO, jobId: '2222' }, CALL)).resolves.toEqual({
      kind: 'ready',
      log: 'the log\n',
    });
    expect(seen).toEqual([['run', 'view', '--job', '2222', '-R', REPO, '--log-failed']]);
  });

  it('answers not yet for a job whose run is in progress', async () => {
    const { gh: client } = gh(
      out(1, '', 'job 2222 is still in progress; logs will be available when it is complete'),
    );
    await expect(client.jobLog({ repo: REPO, jobId: '2222' }, CALL)).resolves.toEqual({
      kind: 'not_yet',
    });
  });

  it.each(['', '--repo', '12 34', '1a', '-1'])(
    'refuses job id %j before running gh',
    async (jobId) => {
      const { gh: client, seen } = gh(out(0));
      await expect(client.jobLog({ repo: REPO, jobId }, CALL)).rejects.toMatchObject({
        name: 'GhError',
        kind: 'failed',
      });
      await expect(client.rerunFailed({ repo: REPO, runId: jobId }, CALL)).rejects.toMatchObject({
        name: 'GhError',
        kind: 'failed',
      });
      expect(seen).toEqual([]);
    },
  );

  it('reruns the failed jobs of a run', async () => {
    const { gh: client, seen } = gh(
      out(0, '', '✓ Requested rerun (failed jobs only) of run 1111\n'),
    );
    await expect(client.rerunFailed({ repo: REPO, runId: '1111' }, CALL)).resolves.toBeUndefined();
    expect(seen).toEqual([['run', 'rerun', '1111', '-R', REPO, '--failed']]);
  });

  it('throws gh’s reason when a rerun is refused', async () => {
    const { gh: client } = gh(
      out(1, '', 'run 1111 cannot be rerun; This workflow is already running'),
    );
    await expect(client.rerunFailed({ repo: REPO, runId: '1111' }, CALL)).rejects.toMatchObject({
      name: 'GhError',
      kind: 'failed',
      message: expect.stringContaining('already running') as unknown,
    });
  });
});
