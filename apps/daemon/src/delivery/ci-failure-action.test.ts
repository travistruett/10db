import { mintId, type BatchDto, type RequiredChecksDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { ciFailureAction, maxCiFixes } from './ci-failure-action';

const AT = '2026-10-21T12:00:00.000Z';
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const batch = (overrides: Partial<BatchDto>): BatchDto => ({
  id: mintId('Batch'),
  projectId: mintId('Project'),
  title: 'Greetings',
  state: 'SHIPPED',
  branch: '10db/greetings-0a1b2c3d',
  baseBranch: 'main',
  autoMerge: true,
  baseSha: 'c'.repeat(40),
  repo: 'acme/widgets',
  prUrl: 'https://github.com/acme/widgets/pull/1',
  pr: null,
  prRequired: null,
  prMergeBlocked: null,
  ciFixOf: null,
  ciFixHead: null,
  ciStopped: null,
  gateExitCode: null,
  gateLogPath: null,
  failure: null,
  worktreePath: null,
  notices: [],
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

const job = (name: string, jobId: string | null = '77') => ({
  name,
  link:
    jobId === null
      ? 'https://ci.example.com/build/1'
      : `https://github.com/a/b/actions/runs/1/job/${jobId}`,
  jobId,
  runId: jobId === null ? null : '1',
  description: null,
});

const failing = (...jobs: ReturnType<typeof job>[]): RequiredChecksDto => ({
  state: 'failing',
  failing: jobs,
  pending: [],
});

const root = batch({});
const fixOf = (head: string, state: BatchDto['state']): BatchDto =>
  batch({ ciFixOf: root.id, ciFixHead: head, state });

describe('ciFailureAction', () => {
  it('fixes a failing Actions job on a head nothing has fixed', () => {
    expect(ciFailureAction(root, failing(job('build')), [], HEAD)).toEqual({ kind: 'fix' });
  });

  it('fixes when one failing check is an Actions job and another is not', () => {
    expect(ciFailureAction(root, failing(job('lint', null), job('build')), [], HEAD)).toEqual({
      kind: 'fix',
    });
  });

  it.each(['CUTTING', 'OPEN', 'SHIPPING', 'FAILED'] as const)(
    'waits while a fix batch is %s, whatever head it fixes',
    (state) => {
      expect(ciFailureAction(root, failing(job('build')), [fixOf(OTHER, state)], HEAD)).toEqual({
        kind: 'wait',
      });
      expect(ciFailureAction(root, failing(job('build')), [fixOf(HEAD, state)], HEAD)).toEqual({
        kind: 'wait',
      });
    },
  );

  it('stops, with no_change, when a finished fix for this head exists', () => {
    expect(ciFailureAction(root, failing(job('build')), [fixOf(HEAD, 'CLOSED')], HEAD)).toEqual({
      kind: 'stop',
      reason: 'no_change',
    });
    expect(ciFailureAction(root, failing(job('build')), [fixOf(HEAD, 'SHIPPED')], HEAD)).toEqual({
      kind: 'stop',
      reason: 'no_change',
    });
  });

  it('fixes the next head after a finished fix', () => {
    expect(ciFailureAction(root, failing(job('build')), [fixOf(HEAD, 'SHIPPED')], OTHER)).toEqual({
      kind: 'fix',
    });
  });

  it('stops, with limit, once two fixes were made', () => {
    expect(maxCiFixes).toBe(2);
    expect(
      ciFailureAction(
        root,
        failing(job('build')),
        [fixOf('1'.repeat(40), 'SHIPPED'), fixOf('2'.repeat(40), 'CLOSED')],
        HEAD,
      ),
    ).toEqual({ kind: 'stop', reason: 'limit' });
  });

  it('stops, with no_log, when no failing check is an Actions job', () => {
    expect(ciFailureAction(root, failing(job('ci/circle', null)), [], HEAD)).toEqual({
      kind: 'stop',
      reason: 'no_log',
    });
    expect(ciFailureAction(root, failing(), [], HEAD)).toEqual({ kind: 'stop', reason: 'no_log' });
  });

  it('stops for the reason it already stopped, with no second look', () => {
    const stopped = batch({ ciStopped: 'no_cut' });
    expect(ciFailureAction(stopped, failing(job('build')), [], HEAD)).toEqual({
      kind: 'stop',
      reason: 'no_cut',
    });
  });

  it.each(['passing', 'pending', 'none'] as const)(
    'waits when the required checks are %s',
    (state) => {
      expect(ciFailureAction(root, { state, failing: [], pending: [] }, [], HEAD)).toEqual({
        kind: 'wait',
      });
    },
  );

  it('waits when the pull request has no known head', () => {
    expect(ciFailureAction(root, failing(job('build')), [], null)).toEqual({ kind: 'wait' });
  });
});
