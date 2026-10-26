import { mintId } from '@10db/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { createUsageReports, type UsageReport } from './index';

const STALE_MS = 30 * 60_000;
const account = mintId('Account');

let clock: ManualClock;
let reports: ReturnType<typeof createUsageReports>;
beforeEach(() => {
  clock = new ManualClock(new Date(2026, 9, 20, 12));
  reports = createUsageReports({ clock, staleMs: STALE_MS });
});

const inMinutes = (n: number) => new Date(clock.now().getTime() + n * 60_000);
const report = (limitType: string, utilization: number, resetsInMinutes: number): UsageReport => ({
  status: 'allowed_warning',
  limitType,
  utilization,
  resetsAt: inMinutes(resetsInMinutes),
});

describe('usage still high', () => {
  it('keeps each limit type apart, so a low report of another limit does not release a high one', () => {
    reports.record(account, report('five_hour', 0.97, 120));
    reports.record(account, report('seven_day', 0.3, 5000));
    expect(reports.stillHigh(account, 0.95)).toEqual(inMinutes(120));
  });

  it('waits for the last high limit to reset', () => {
    reports.record(account, report('five_hour', 0.97, 120));
    reports.record(account, report('seven_day', 0.99, 5000));
    expect(reports.stillHigh(account, 0.95)).toEqual(inMinutes(5000));
  });

  it('forgets a report nothing has repeated for the stale time, and one whose window reset', () => {
    reports.record(account, report('five_hour', 0.97, 120));
    reports.record(account, report('seven_day', 0.97, 10));
    clock.advance(11 * 60_000);
    expect(reports.stillHigh(account, 0.95)).toEqual(inMinutes(109));
    clock.advance(STALE_MS);
    expect(reports.stillHigh(account, 0.95)).toBeNull();
  });
});
