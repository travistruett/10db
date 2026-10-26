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
   * When to look again if any limit of the account has its latest report at or past `threshold`: the
   * last of their resets. Null when none has, when those windows have reset, or when nothing was
   * heard for `staleMs`.
   */
  stillHigh(accountId: AccountId, threshold: number): Date | null;
}

interface Heard {
  readonly report: UsageReport;
  readonly at: Date;
}

/**
 * The latest report with a utilization per account and limit type, in memory: what running sessions
 * said lately. Each limit keeps its own, so a report of one never hides another.
 */
export function createUsageReports(opts: {
  readonly clock: Clock;
  readonly staleMs: number;
}): UsageReports {
  const latest = new Map<AccountId, Map<string, Heard>>();
  return {
    record(accountId, report) {
      if (report.utilization === null) return;
      const byLimit = latest.get(accountId) ?? new Map<string, Heard>();
      byLimit.set(report.limitType ?? '', { report, at: opts.clock.now() });
      latest.set(accountId, byLimit);
    },
    stillHigh(accountId, threshold) {
      const now = opts.clock.now();
      let last: Date | null = null;
      for (const { report, at } of latest.get(accountId)?.values() ?? []) {
        if (report.utilization === null || report.utilization < threshold) continue;
        if (now.getTime() - at.getTime() >= opts.staleMs) continue;
        const until =
          report.resetsAt === null
            ? new Date(now.getTime() + opts.staleMs)
            : report.resetsAt > now
              ? report.resetsAt
              : null;
        if (until !== null && (last === null || until > last)) last = until;
      }
      return last;
    },
  };
}
