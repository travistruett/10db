import type { AccountModelDto, ModelProfileDto } from '@10db/contracts';

/**
 * What a task costs on the account. AA's cost per task is at the maker's list price; an account that pays per
 * token and prices its own copy of the model differently scales it by its output price over the maker's. An
 * account with no price of its own (a subscription, where a figure measures how heavy a model is), a model the
 * account does not list, or one with no maker price keeps the maker's figure. Null when AA has no figure.
 */
export function costOnAccount(
  p: ModelProfileDto,
  accountModels: readonly AccountModelDto[] | undefined,
): number | null {
  if (p.costPerTaskUsd === null) return null;
  const own = accountModels?.find((m) => m.model === p.model)?.outputPrice ?? null;
  if (own === null || p.outputPrice === null || p.outputPrice === 0) return p.costPerTaskUsd;
  return p.costPerTaskUsd * (own / p.outputPrice);
}
