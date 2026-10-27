import type { BenchmarkSyncWarning } from '@10db/contracts';

/**
 * Whether a failed Artificial Analysis sync needs the builder. A refused key stays refused until they replace
 * it; a used-up limit or an unreachable server clears on a later sync, so the UI only notes those.
 */
export function syncNeedsBuilder(warning: BenchmarkSyncWarning): boolean {
  switch (warning.outcome) {
    case 'unauthorized':
      return true;
    case 'rate_limited':
    case 'failed':
      return false;
  }
}
