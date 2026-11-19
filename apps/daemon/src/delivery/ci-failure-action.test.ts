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
  cancelled: [],
});

const root = batch({});
const fixOf = (head: string, state: BatchDto['state']): BatchDto =>
  batch({ ciFixOf: root.id, ciFixHead: head, state });

interface Row {
  readonly name: string;
  readonly batch?: BatchDto;
  readonly checks?: RequiredChecksDto;
  readonly fixes?: readonly BatchDto[];
  readonly head?: string | null;
}

const decide = (row: Row) =>
  ciFailureAction(
    row.batch ?? root,
    row.checks ?? failing(job('build')),
    row.fixes ?? [],
    row.head === undefined ? HEAD : row.head,
  );

const RUNNING_FIX_STATES = ['CUTTING', 'OPEN', 'SHIPPING', 'FAILED'] as const;
const QUIET_CHECKS = ['passing', 'pending', 'cancelled', 'none'] as const;

describe('ciFailureAction', () => {
  it('fixes a failing Actions job on a head no fix has finished', () => {
    const rows: Row[] = [
      { name: 'a head nothing has fixed' },
      {
        name: 'one failing check an Actions job, another not',
        checks: failing(job('lint', null), job('build')),
      },
      { name: 'the next head after a finished fix', fixes: [fixOf(HEAD, 'SHIPPED')], head: OTHER },
    ];
    for (const row of rows) expect.soft(decide(row), row.name).toEqual({ kind: 'fix' });
  });

  it('waits while a fix batch runs, the checks are not failing, or the head is unknown', () => {
    const rows: Row[] = [
      ...RUNNING_FIX_STATES.flatMap((state) => [
        { name: `fix batch ${state} on another head`, fixes: [fixOf(OTHER, state)] },
        { name: `fix batch ${state} on this head`, fixes: [fixOf(HEAD, state)] },
      ]),
      ...QUIET_CHECKS.map((state) => ({
        name: `required checks ${state}`,
        checks: { state, failing: [], pending: [], cancelled: [] },
      })),
      { name: 'no known head', head: null },
    ];
    for (const row of rows) expect.soft(decide(row), row.name).toEqual({ kind: 'wait' });
  });

  it('stops with its reason: no change, the limit, no log, or an earlier stop', () => {
    expect(maxCiFixes).toBe(2);
    const rows: (Row & { reason: string })[] = [
      { name: 'a closed fix for this head', fixes: [fixOf(HEAD, 'CLOSED')], reason: 'no_change' },
      { name: 'a shipped fix for this head', fixes: [fixOf(HEAD, 'SHIPPED')], reason: 'no_change' },
      {
        name: 'two fixes made',
        fixes: [fixOf('1'.repeat(40), 'SHIPPED'), fixOf('2'.repeat(40), 'CLOSED')],
        reason: 'limit',
      },
      {
        name: 'no failing Actions job',
        checks: failing(job('ci/circle', null)),
        reason: 'no_log',
      },
      { name: 'no failing job at all', checks: failing(), reason: 'no_log' },
      { name: 'stopped before', batch: batch({ ciStopped: 'no_cut' }), reason: 'no_cut' },
    ];
    for (const row of rows) {
      expect.soft(decide(row), row.name).toEqual({ kind: 'stop', reason: row.reason });
    }
  });
});
