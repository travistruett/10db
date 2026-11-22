import { harnessOf, type KindDto, type ProjectDto, type ProjectId } from '@10db/contracts';
import {
  getAccount,
  getPlaybook,
  listAccountModels,
  listKinds,
  listModelProfiles,
  type DbReader,
} from '@10db/db';
import { offeredProfiles, type ChooseInput, type PlaybookScopes } from '../routing';

/**
 * What choosing a model reads for a project: the profiles its account offers, and the account's own tier
 * overrides with its list, which decides whether an override is offered. A reader of the database gathers
 * them, so the rules themselves stay pure.
 */
export function routingInputs(
  db: DbReader,
  project: Pick<ProjectDto, 'accountId' | 'provider'>,
): Pick<ChooseInput, 'profiles' | 'tierOverrides' | 'accountModels'> {
  const account = getAccount(db, project.accountId);
  // The account's harness decides which models a step can run on; the project's own provider only covers
  // an account no harness runs.
  const provider = harnessOf(account) ?? project.provider;
  const accountModels = listAccountModels(db, account.id);
  return {
    profiles: offeredProfiles(listModelProfiles(db), accountModels, provider),
    tierOverrides:
      'tierOverrides' in account.settings ? (account.settings.tierOverrides ?? {}) : {},
    accountModels,
  };
}

/**
 * The kinds and the playbook overrides a project's tasks resolve against: its own, then the global ones.
 * With no project, only the global ones.
 */
export function playbookInputs(
  db: DbReader,
  projectId: ProjectId | null,
): { readonly kinds: KindDto[]; readonly playbook: PlaybookScopes } {
  return {
    kinds: listKinds(db),
    playbook: {
      project: projectId === null ? null : getPlaybook(db, projectId),
      global: getPlaybook(db, null),
    },
  };
}
