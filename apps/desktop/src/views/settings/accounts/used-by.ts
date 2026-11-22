import {
  AccountKind,
  harnessOf,
  type AccountDto,
  type AccountId,
  type ProjectDto,
} from '@10db/contracts';

/** The account's harness as a card and a drawer say it; a kind with none says no harness runs it yet. */
export function harnessLine(account: Pick<AccountDto, 'kind' | 'label' | 'settings'>): string {
  switch (harnessOf(account)) {
    case 'claude':
      return 'Runs Claude Code';
    case 'codex':
      return 'Runs Codex';
    case null:
      return `No harness runs ${account.label} yet`;
  }
}

/** What a non-OpenRouter account says in Paid by: decisions have one provider for now. */
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

/** Billing's rule for an account select: a project's account must have a harness to run its sessions. */
export function cantRunAgents(
  account: Pick<AccountDto, 'kind' | 'label' | 'settings'>,
): string | null {
  return harnessOf(account) === null ? harnessLine(account) : null;
}

/** Decisions' rule for its select: they run on OpenRouter for now, so every other kind is refused. */
export function cantRunDecisions(account: Pick<AccountDto, 'kind'>): string | null {
  return account.kind === AccountKind.OpenRouter ? null : DECISIONS_RUN_ON_OPENROUTER;
}
