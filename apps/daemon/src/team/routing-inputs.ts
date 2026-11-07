import {
  providerOf,
  SUPPORTED_ACCOUNT_KINDS,
  type ProjectDto,
  type SupportedAccountKind,
} from '@10db/contracts';
import {
  getAccount,
  listAccountModels,
  listModelProfiles,
  listPatterns,
  listRoleSettings,
  type DbReader,
} from '@10db/db';
import { offeredProfiles, type ChooseInput } from '../routing';

const isSupported = (kind: string): kind is SupportedAccountKind =>
  SUPPORTED_ACCOUNT_KINDS.some((supported) => supported === kind);

/**
 * What choosing a model reads for a project: the profiles its account offers, with the builder's role
 * settings and patterns, and the account's own tier overrides with its list, which decides whether an override
 * is offered. A reader of the database gathers them, so the rules themselves stay pure.
 */
export function routingInputs(
  db: DbReader,
  project: Pick<ProjectDto, 'accountId' | 'provider'>,
): Pick<ChooseInput, 'profiles' | 'roleSettings' | 'patterns' | 'tierOverrides' | 'accountModels'> {
  const account = getAccount(db, project.accountId);
  // The account decides which models a step can run on; the project's own provider only covers a kind
  // 10db can no longer run.
  const provider = isSupported(account.kind) ? providerOf(account.kind) : project.provider;
  const accountModels = listAccountModels(db, account.id);
  return {
    profiles: offeredProfiles(listModelProfiles(db), accountModels, provider),
    roleSettings: listRoleSettings(db),
    patterns: listPatterns(db),
    tierOverrides: account.settings.tierOverrides ?? {},
    accountModels,
  };
}
