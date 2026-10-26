import type { AccountId } from '@10db/contracts';
import type { Clock } from '../clock';

/** What a session reported about its account's usage limit (Claude Code's rate-limit event). */
export interface UsageReport {
  readonly status: 'allowed' | 'allowed_warning' | 'rejected';
  /** The share of the limit used, 0 to 1; null when Claude Code didn't report one. */
  readonly utilization: number | null;
  /** `five_hour`, `seven_day` and the rest; null when Claude Code didn't say. */
  readonly limitType: string | null;
  readonly resetsAt: Date | null;
}

export interface UsageReports {
  record(accountId: AccountId, report: UsageReport): void;
  /**
   * When to look again if the account's latest report has its usage at or past `threshold`; null
   * when it hasn't, when that window has reset, or when nothing was heard for `staleMs`.
   */
  stillHigh(accountId: AccountId, threshold: number): Date | null;
}

/** The latest report with a utilization per account, in memory: what running sessions said lately. */
export function createUsageReports(opts: {
  readonly clock: Clock;
  readonly staleMs: number;
}): UsageReports {
  const latest = new Map<AccountId, { readonly report: UsageReport; readonly at: Date }>();
  return {
    record(accountId, report) {
      if (report.utilization !== null) latest.set(accountId, { report, at: opts.clock.now() });
    },
    stillHigh(accountId, threshold) {
      const seen = latest.get(accountId);
      const now = opts.clock.now();
      const utilization = seen?.report.utilization ?? null;
      if (!seen || utilization === null || utilization < threshold) return null;
      if (now.getTime() - seen.at.getTime() >= opts.staleMs) return null;
      if (seen.report.resetsAt !== null)
        return seen.report.resetsAt > now ? seen.report.resetsAt : null;
      return new Date(now.getTime() + opts.staleMs);
    },
  };
}
