import type { AccountId } from '@10db/contracts';

/**
 * What an OpenRouter account's models charge for a cached input token, by account and launch ID, from the last
 * read of its list. Held in memory only: with none known, a cached token is charged as input, which overestimates.
 */
const cacheReadPrices = new Map<AccountId, ReadonlyMap<string, number>>();

/** Replaces what is known of the account's models. */
export function rememberCacheReadPrices(
  accountId: AccountId,
  models: readonly { readonly id: string; readonly cacheReadPrice: number | null }[],
): void {
  cacheReadPrices.set(
    accountId,
    new Map(models.flatMap((m) => (m.cacheReadPrice === null ? [] : [[m.id, m.cacheReadPrice]]))),
  );
}

/** Dollars per million cached input tokens of a model, or undefined when its list gave none. */
export function cacheReadPriceOf(accountId: AccountId, launchId: string): number | undefined {
  return cacheReadPrices.get(accountId)?.get(launchId);
}
