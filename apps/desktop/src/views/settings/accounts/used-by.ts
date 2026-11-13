import {
  AccountKind,
  runsAgents,
  type AccountDto,
  type AccountId,
  type ProjectDto,
} from '@10db/contracts';

/** What an account says it can't do yet; the text Billing and Accounts show beside it. */
export const CANT_RUN_AGENTS = "Can't run agents yet";

/** What a non-OpenRouter account says in Runs on: decisions have one provider for now. */
export const DECISIONS_RUN_ON_OPENROUTER = 'Decisions run on OpenRouter for now';

/** "Renewals'" for a name ending in s, "Billing's" for any other. */
const possessive = (name: string): string => (name.endsWith('s') ? `${name}'` : `${name}'s`);

/**
 * What an account is used by: the projects whose account or backup it is, and decisions when the judge runs on
 * it. Empty when nothing uses it.
 */
export function accountUsedBy(
  account: Pick<AccountDto, 'id'>,
  projects: readonly Pick<ProjectDto, 'name' | 'accountId' | 'fallbackAccountId'>[],
  judge: { readonly config: { readonly accountId: AccountId | null } } | undefined,
): readonly string[] {
  const used: string[] = [];
  for (const project of projects) {
    if (project.accountId === account.id) used.push(`${possessive(project.name)} agents`);
    if (project.fallbackAccountId === account.id) used.push(`${possessive(project.name)} backup`);
  }
  if (judge?.config.accountId === account.id) used.push('decisions');
  return used;
}

/** The line a row or drawer shows for `accountUsedBy`. */
export function usedByText(used: readonly string[]): string {
  return used.length === 0 ? 'Used by nothing' : `Used by: ${used.join(', ')}`;
}

/** Billing's rule for an account select: a project runs agents, and an OpenRouter account can't yet. */
export function cantRunAgents(account: Pick<AccountDto, 'kind'>): string | null {
  return runsAgents(account.kind) ? null : CANT_RUN_AGENTS;
}

/** Decisions' rule for its select: they run on OpenRouter for now, so every other kind is refused. */
export function cantRunDecisions(account: Pick<AccountDto, 'kind'>): string | null {
  return account.kind === AccountKind.OpenRouter ? null : DECISIONS_RUN_ON_OPENROUTER;
}
