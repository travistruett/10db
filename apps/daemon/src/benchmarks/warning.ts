import type { BenchmarkStatusDto, BenchmarkSyncWarning } from '@10db/contracts';

/** The warning `GET /system` shows while the last Artificial Analysis sync failed; null otherwise. */
export function syncWarning(status: BenchmarkStatusDto): BenchmarkSyncWarning | null {
  switch (status.outcome) {
    case 'unauthorized':
    case 'rate_limited':
    case 'failed':
      return {
        outcome: status.outcome,
        message: status.message ?? 'The last Artificial Analysis sync failed',
      };
    case 'ok':
    case 'no_key':
    case null:
      return null;
  }
}
