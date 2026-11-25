import type { RequiredCheckJobDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { CHECKS_START_MS, ciRerunStep, type CiRerunStep } from './ci-rerun';
import type { FailedRerunRecord } from './notices';

const job = (name: string, jobId: string, runId: string | null = '1'): RequiredCheckJobDto => ({
  name,
  link: null,
  jobId,
  runId,
  description: null,
});

const AT = 1_000_000;
const ran: FailedRerunRecord = {
  runs: ['1'],
  jobs: ['77'],
  names: ['build'],
  at: AT,
  outcome: 'rerun',
};

describe('ciRerunStep', () => {
  const rows: {
    name: string;
    record: FailedRerunRecord | null;
    change: RequiredCheckJobDto[];
    failing: RequiredCheckJobDto[];
    pending: RequiredCheckJobDto[];
    cancelled?: RequiredCheckJobDto[];
    listed?: boolean;
    now: number;
    step: CiRerunStep;
  }[] = [
    {
      name: 'no record, nothing of the change fails: nothing',
      record: null,
      change: [],
      failing: [job('build', '77')],
      pending: [],
      now: AT,
      step: { kind: 'none' },
    },
    {
      name: 'no record, the run still going: hold',
      record: null,
      change: [job('build', '77')],
      failing: [job('build', '77')],
      pending: [job('lint', '80')],
      now: AT,
      step: { kind: 'hold', names: ['build'] },
    },
    {
      name: 'no record: rerun each run once',
      record: null,
      change: [job('build', '77'), job('unit', '78'), job('e2e', '90', '2')],
      failing: [job('build', '77'), job('unit', '78'), job('e2e', '90', '2')],
      pending: [job('other', '95', '3')],
      now: AT,
      step: { kind: 'rerun', runs: ['1', '2'] },
    },
    {
      name: 'rerun: a new job of a rerun check fails: failed again',
      record: ran,
      change: [],
      failing: [job('build', '78')],
      pending: [],
      now: AT + 1,
      step: { kind: 'failedAgain' },
    },
    {
      name: 'rerun: a rerun check pending: hold',
      record: ran,
      change: [],
      failing: [],
      pending: [job('build', '78')],
      now: AT + 1,
      step: { kind: 'hold', names: ['build'] },
    },
    {
      name: 'rerun: only the old job listed, within the minutes: hold',
      record: ran,
      change: [],
      failing: [job('build', '77')],
      pending: [],
      now: AT + CHECKS_START_MS - 1,
      step: { kind: 'hold', names: ['build'] },
    },
    {
      name: 'rerun: only the old job listed, past the minutes: failed again',
      record: ran,
      change: [],
      failing: [job('build', '77')],
      pending: [],
      now: AT + CHECKS_START_MS,
      step: { kind: 'failedAgain' },
    },
    {
      name: 'rerun: no rerun check fails or runs: flaked',
      record: ran,
      change: [],
      failing: [job('lint', '81')],
      pending: [],
      now: AT + 1,
      step: { kind: 'flaked', names: ['build'] },
    },
    {
      name: 'rerun: a rerun check cancelled: hold, it never passed',
      record: ran,
      change: [],
      failing: [],
      pending: [],
      cancelled: [job('build', '78')],
      now: AT + CHECKS_START_MS,
      step: { kind: 'hold', names: ['build'] },
    },
    {
      name: 'rerun: no checks listed, within the minutes: hold',
      record: ran,
      change: [],
      failing: [],
      pending: [],
      listed: false,
      now: AT + CHECKS_START_MS - 1,
      step: { kind: 'hold', names: ['build'] },
    },
    {
      name: 'rerun: no checks listed, past the minutes: nothing, and never flaked',
      record: ran,
      change: [],
      failing: [],
      pending: [],
      listed: false,
      now: AT + CHECKS_START_MS,
      step: { kind: 'none' },
    },
    ...(['failed', 'flaked', 'refused'] as const).map((outcome) => ({
      name: `${outcome}: a head is never rerun twice`,
      record: { ...ran, outcome },
      change: [job('build', '79')],
      failing: [job('build', '79')],
      pending: [],
      now: AT + 1,
      step: { kind: 'none' } as const,
    })),
  ];
  it.each(rows)('$name', ({ record, change, failing, pending, cancelled, listed, now, step }) => {
    expect(
      ciRerunStep({
        record,
        change,
        failing,
        pending,
        cancelled: cancelled ?? [],
        listed: listed ?? true,
        now,
      }),
    ).toEqual(step);
  });
});
