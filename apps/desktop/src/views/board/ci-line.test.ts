import type { BatchDto, RequiredChecksDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { batchDto, workstreamDto } from '../../test/fixtures';
import { ciLine, withFixTaskTitles } from './ci-line';

const PR = 'https://github.com/acme/widgets/pull/9';
const job = (name: string, link: string | null) => ({
  name,
  link,
  jobId: null,
  runId: null,
  description: null,
});
const required = (
  state: RequiredChecksDto['state'],
  jobs: Partial<Pick<RequiredChecksDto, 'failing' | 'pending' | 'cancelled'>> = {},
): RequiredChecksDto => ({ state, failing: [], pending: [], cancelled: [], ...jobs });

const read = (state: 'open' | 'merged' | 'closed' | 'unknown') => ({
  state,
  checks: 'pending' as const,
  failingChecks: [],
  checkedAt: '2026-10-31T12:00:00.000Z',
  unknownReason: null,
});

const shipped = (overrides: Partial<BatchDto> = {}) =>
  batchDto({ state: 'SHIPPED', prUrl: PR, pr: read('open'), ...overrides });

describe('ciLine', () => {
  it('says CI running and links the first running job', () => {
    const batch = shipped({
      prRequired: required('pending', {
        pending: [
          job('build', 'https://github.com/acme/widgets/actions/runs/1/job/2'),
          job('lint', 'https://github.com/acme/widgets/actions/runs/1/job/3'),
        ],
      }),
    });
    expect(ciLine(batch, [batch])).toEqual({
      line: 'Pull request open · CI running',
      color: 'blue',
      link: { url: 'https://github.com/acme/widgets/actions/runs/1/job/2', label: 'CI job' },
    });
  });

  it('says a cancelled required check was cancelled, never running, and links its job', () => {
    const batch = shipped({
      prRequired: required('cancelled', {
        cancelled: [job('desktop', 'https://github.com/acme/widgets/actions/runs/1/job/9')],
      }),
    });
    expect(ciLine(batch, [batch])).toEqual({
      line: 'Pull request open · CI cancelled: desktop',
      color: 'orange',
      link: { url: 'https://github.com/acme/widgets/actions/runs/1/job/9', label: 'CI job' },
    });
  });

  it('links the checks page when a running job has no link, or one that is not on github.com', () => {
    for (const link of [null, 'https://ci.example.com/run/1', 'http://github.com/a/b/runs/1']) {
      const batch = shipped({ prRequired: required('pending', { pending: [job('build', link)] }) });
      expect(ciLine(batch, [batch])?.link).toEqual({ url: `${PR}/checks`, label: 'CI checks' });
    }
  });

  it('says CI passed for an open pull request, linking its checks', () => {
    const batch = shipped({ prRequired: required('passing') });
    expect(ciLine(batch, [batch])).toEqual({
      line: 'Pull request open · CI passed',
      color: 'green',
      link: { url: `${PR}/checks`, label: 'CI checks' },
    });
  });

  it('says CI failed with the job and links it', () => {
    const url = 'https://github.com/acme/widgets/actions/runs/7/job/8';
    const batch = shipped({ prRequired: required('failing', { failing: [job('build', url)] }) });
    expect(ciLine(batch, [batch])).toEqual({
      line: 'Pull request open · CI failed: build',
      color: 'red',
      link: { url, label: 'CI job' },
    });
  });

  it('names the fix task while a fix runs', () => {
    const root = shipped({
      prRequired: required('failing', { failing: [job('build', null)] }),
    });
    const fix = batchDto({
      state: 'OPEN',
      prUrl: null,
      title: 'Fix CI: build on Add greetings',
      ciFixOf: root.id,
      ciFixHead: 'abc',
    });
    expect(ciLine(root, [root, fix])?.line).toBe(
      'Pull request open · CI failed: build · fixing in "Fix CI: build on Add greetings"',
    );
  });

  it('names the fix task, not the fix batch, once the task is renamed (spec §5)', () => {
    const root = shipped({ prRequired: required('failing', { failing: [job('build', null)] }) });
    const fix = batchDto({
      state: 'OPEN',
      title: 'Fix CI: build on Add greetings',
      ciFixOf: root.id,
      ciFixHead: 'abc',
    });
    const other = batchDto({ state: 'OPEN', title: 'Another batch' });
    const workstreams = [
      workstreamDto({ batchId: fix.id, taskTitle: 'Make the build pass again' }),
      workstreamDto({ batchId: other.id, taskTitle: 'Some other task' }),
    ];
    const batches = withFixTaskTitles([root, fix, other], workstreams);
    expect(ciLine(root, batches)?.line).toBe(
      'Pull request open · CI failed: build · fixing in "Make the build pass again"',
    );
    // Only a CI fix batch is retitled; the batch's own title stands when it has no workstream.
    expect(batches.find((b) => b.id === other.id)?.title).toBe('Another batch');
    expect(withFixTaskTitles([root, fix], [])[1]?.title).toBe('Fix CI: build on Add greetings');
  });

  it("names the CI fix task, the batch's oldest workstream, when a person added another (spec §5)", () => {
    const root = shipped({ prRequired: required('failing', { failing: [job('build', null)] }) });
    const fix = batchDto({
      state: 'OPEN',
      title: 'Fix CI: build on Add greetings',
      ciFixOf: root.id,
      ciFixHead: 'abc',
    });
    const created = workstreamDto({
      batchId: fix.id,
      taskTitle: 'Make the build pass again',
      createdAt: '2026-11-01T10:00:00.000Z',
    });
    const added = workstreamDto({
      batchId: fix.id,
      taskTitle: 'Also tidy the lint config',
      createdAt: '2026-11-01T11:00:00.000Z',
    });
    const expected = 'Pull request open · CI failed: build · fixing in "Make the build pass again"';
    // Whichever order the list comes in, the line names the task made first.
    for (const workstreams of [
      [created, added],
      [added, created],
    ]) {
      const batches = withFixTaskTitles([root, fix], workstreams);
      expect(ciLine(root, batches)?.line).toBe(expected);
    }
  });

  it('does not say fixing for a fix batch whose ship failed', () => {
    const root = shipped({ prRequired: required('failing', { failing: [job('build', null)] }) });
    const fix = batchDto({ state: 'FAILED', ciFixOf: root.id, ciFixHead: 'abc' });
    expect(ciLine(root, [root, fix])?.line).toBe('Pull request open · CI failed: build');
  });

  it.each(['CUTTING', 'OPEN', 'SHIPPING'] as const)(
    'says fixing while a fix batch is %s',
    (state) => {
      const root = shipped({ prRequired: required('failing', { failing: [job('build', null)] }) });
      const fix = batchDto({ title: 'Fix', state, ciFixOf: root.id, ciFixHead: 'abc' });
      expect(ciLine(root, [root, fix])?.line).toContain('fixing in');
    },
  );

  it('links nothing outside https github.com for the checks or a conflict', () => {
    for (const prUrl of [
      'http://github.com/acme/widgets/pull/9',
      'https://github.com.example.net/acme/widgets/pull/9',
      'https://ci.example.com/pull/9',
      'not a url',
    ]) {
      const cases = [
        required('passing'),
        required('pending', { pending: [job('build', null)] }),
        required('failing', { failing: [job('build', null)] }),
      ];
      for (const prRequired of cases) {
        const batch = shipped({ prUrl, prRequired });
        expect(ciLine(batch, [batch])?.link ?? null).toBeNull();
        const conflicted = shipped({ prUrl, prRequired, prMergeBlocked: 'conflicts' });
        expect(ciLine(conflicted, [conflicted])?.link ?? null).toBeNull();
      }
      const merged = shipped({ prUrl, pr: read('merged'), prRequired: required('pending') });
      expect(ciLine(merged, [merged])?.link ?? null).toBeNull();
    }
  });

  it('says how many fixes ran once fixing stopped', () => {
    const root = shipped({
      prRequired: required('failing', { failing: [job('build', null)] }),
      ciStopped: 'limit',
    });
    const fixes = ['a', 'b'].map((head) =>
      batchDto({ state: 'CLOSED', ciFixOf: root.id, ciFixHead: head }),
    );
    expect(ciLine(root, [root, ...fixes])?.line).toBe(
      'Pull request open · CI failed: build · stopped after 2 fixes',
    );
  });

  it('says conflicts with the base instead of CI running', () => {
    const batch = shipped({
      baseBranch: 'main',
      prMergeBlocked: 'conflicts',
      prRequired: required('pending', { pending: [job('build', null)] }),
    });
    expect(ciLine(batch, [batch])).toEqual({
      line: 'Pull request open · conflicts with main',
      color: 'red',
      link: { url: PR, label: 'Pull request' },
    });
  });

  it('says behind the base instead of CI passed', () => {
    const batch = shipped({
      baseBranch: 'next',
      prMergeBlocked: 'behind',
      prRequired: required('passing'),
    });
    expect(ciLine(batch, [batch])?.line).toBe('Pull request open · behind next');
  });

  // A pull request in the merge queue is waiting its turn: its own checks passed, and the queue's
  // group runs elsewhere, so neither "CI passed" nor "CI running" says it.
  it.each([
    ['passing', required('passing')],
    ['pending', required('pending', { pending: [job('build', null)] })],
    ['none', required('none')],
    ['unread', null],
  ])(
    'says queued to merge for a pull request in the merge queue (checks %s)',
    (_name, prRequired) => {
      const batch = shipped({ prMergeBlocked: 'queued', prRequired });
      expect(ciLine(batch, [batch])).toEqual({
        line: 'Pull request open · queued to merge',
        color: 'blue',
        link: { url: PR, label: 'Pull request' },
      });
    },
  );

  it('says queued to merge on a fix batch of the queued root, and nothing once merged or closed', () => {
    const root = shipped({ prMergeBlocked: 'queued', prRequired: required('passing') });
    const fix = shipped({ ciFixOf: root.id });
    expect(ciLine(fix, [root, fix])?.line).toBe('Pull request open · queued to merge');
    const merged = shipped({
      pr: read('merged'),
      prMergeBlocked: 'queued',
      prRequired: required('passing'),
    });
    expect(ciLine(merged, [merged])?.line).toBe('Merged · CI passed');
    const closed = shipped({ pr: read('closed'), prMergeBlocked: 'queued' });
    expect(ciLine(closed, [closed])).toBeNull();
  });

  it('says Merged · CI passed once the pull request merged', () => {
    const batch = shipped({ pr: read('merged'), prRequired: required('pending') });
    expect(ciLine(batch, [batch])).toEqual({
      line: 'Merged · CI passed',
      color: 'green',
      link: { url: `${PR}/checks`, label: 'CI checks' },
    });
  });

  it('shows a fix task the root batch’s checks, keyed by ciFixOf', () => {
    const root = shipped({ prRequired: required('pending', { pending: [job('build', null)] }) });
    const fix = shipped({ ciFixOf: root.id, ciFixHead: 'abc' });
    expect(ciLine(fix, [root, fix])?.line).toBe('Pull request open · CI running');
    const merged = { ...fix, pr: read('merged') };
    expect(ciLine(merged, [root, merged])?.line).toBe('Merged · CI passed');
  });

  it.each([
    ['no required checks read', null],
    ['none required', required('none')],
  ])('keeps today’s line with %s', (_name, prRequired) => {
    const batch = shipped({ prRequired });
    expect(ciLine(batch, [batch])).toBeNull();
    const merged = shipped({ prRequired, pr: read('merged') });
    expect(ciLine(merged, [merged])).toBeNull();
  });

  it.each(['closed', 'unknown'] as const)('keeps today’s line for a %s pull request', (state) => {
    const batch = shipped({ pr: read(state), prRequired: required('passing') });
    expect(ciLine(batch, [batch])).toBeNull();
  });

  it('says nothing for a batch that did not ship or has no pull request', () => {
    const open = batchDto({ state: 'OPEN', prRequired: required('passing') });
    expect(ciLine(open, [open])).toBeNull();
    expect(ciLine(undefined, [])).toBeNull();
  });
});
