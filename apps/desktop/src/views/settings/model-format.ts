import {
  CatalogueAttempt,
  CatalogueSource,
  type AccountId,
  type AccountModelDto,
  type CatalogueStatusDto,
} from '@10db/contracts';
import { fromNow } from '../../shell/relative';

/** What a cell with no data shows: never a zero, which would read as a measurement. */
export const NO_DATA = '—';

/** An Artificial Analysis index or speed, to one decimal where it has one. */
export function formatScore(value: number | null): string {
  return value === null ? NO_DATA : String(Math.round(value * 10) / 10);
}

/** Dollars per million tokens. */
export function formatPrice(value: number | null): string {
  return value === null ? NO_DATA : `$${value.toFixed(2)}`;
}

/** Dollars for a task: cents, and under a cent a floor, since $0.00 would read as free. */
export function formatCost(value: number | null): string {
  if (value === null) return NO_DATA;
  return value > 0 && value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`;
}

/**
 * What a cost per task is at. Without an account it is the maker's API list price; an account that lists its own
 * per-token price scales it, and one with none (a plan, a gateway without prices) keeps the maker's.
 */
export function costNote(accountId: AccountId | null, offers: readonly AccountModelDto[]): string {
  const base = "At the maker's API list price";
  if (accountId === null) return base;
  const priced = offers.some((o) => o.accountId === accountId && o.outputPrice !== null);
  return priced
    ? `${base}, scaled to this account's own output price`
    : `${base}; this account has no per-token price`;
}

/** The share of steps that passed first time; no steps, no rate. */
export function formatFirstPass(firstPassSteps: number, stepsRun: number): string {
  return stepsRun === 0 ? NO_DATA : `${String(Math.round((firstPassSteps / stepsRun) * 100))}%`;
}

/** Where the catalogue came from and how old it is, in one line; a failed or disabled fetch says so. */
export function catalogueLine(status: CatalogueStatusDto, now: number): string {
  if (status.lastAttempt === CatalogueAttempt.Off)
    return 'The catalogue fetch is off on this daemon (TENDB_CATALOGUE=off), so prices and release dates are not refreshed.';
  const failed = status.lastAttempt === CatalogueAttempt.Failed;
  switch (status.source) {
    case CatalogueSource.None:
      return failed
        ? 'Could not reach models.dev, and there is no catalogue yet. Refresh Models tries again.'
        : 'No catalogue yet. Refresh Models fetches prices and release dates from models.dev.';
    case CatalogueSource.Snapshot:
      return `${failed ? 'Could not reach models.dev; showing' : 'Showing'} the models.dev copy built into this release, ${String(status.models)} models. Refresh Models fetches the latest.`;
    case CatalogueSource.Fetched:
    case CatalogueSource.Stored: {
      const age = status.fetchedAt === null ? 'at an unknown time' : fromNow(status.fetchedAt, now);
      return failed
        ? `Could not reach models.dev; showing the copy from ${age}, ${String(status.models)} models.`
        : `Prices and release dates from models.dev, fetched ${age}, ${String(status.models)} models.`;
    }
  }
}
