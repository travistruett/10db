import {
  isModelTier,
  Rigor,
  StepRole,
  type ModelProfileDto,
  type RolePickDto,
} from '@10db/contracts';
import { ROLE_NEED } from './catalogue';
import { chooseModel, type ChooseInput } from './choose-model';
import { costOnAccount } from './cost-on-account';
import { resolveSteps, type PlaybookScopes } from './playbook';

/** What the picks read: what choosing a model reads for a project of the account, and the live personas. */
export interface RolePicksInput extends Pick<
  ChooseInput,
  'profiles' | 'tierOverrides' | 'accountModels'
> {
  /** The kinds' and playbook overrides; with none, 10db's defaults. */
  readonly playbook?: PlaybookScopes;
}

const profileFields = (
  profile: ModelProfileDto,
  accountModels: ChooseInput['accountModels'],
): Pick<RolePickDto, 'profileId' | 'model' | 'effort' | 'intelligence' | 'costPerTaskUsd'> => ({
  profileId: profile.id,
  model: profile.model,
  effort: profile.effort,
  intelligence: profile.scores.intelligence,
  costPerTaskUsd: costOnAccount(profile, accountModels),
});

const nothing = {
  profileId: null,
  model: null,
  effort: null,
  intelligence: null,
  costPerTaskUsd: null,
} as const;

/**
 * What routing chooses for each role at a rigor, in role order, for a task with no kinds, no setting of its
 * own and no budget ceiling. A role the rigor's row does not run is shown as an Automatic cell at the
 * role's own need, so the page can say what it would get.
 */
export function rolePicks(input: RolePicksInput, rigor: Rigor = Rigor.Standard): RolePickDto[] {
  const resolved = resolveSteps({
    rigor,
    taskKinds: [],
    kinds: [],
    playbook: input.playbook ?? { project: null, global: { rows: [], cells: [] } },
  });
  return Object.values(StepRole).map((role): RolePickDto => {
    const step = resolved.find((s) => s.role === role);
    const need = step?.need ?? ROLE_NEED[role];
    const choice = chooseModel({
      def: { role, need },
      requirements: step?.requirements ?? [{ kind: 'automatic' }],
      effort: step?.effort ?? null,
      fallback: step?.fallback ?? null,
      pinned: false,
      task: { modelSetting: null, effortPin: null },
      project: { budgetCeiling: null },
      profiles: input.profiles,
      tierOverrides: input.tierOverrides,
      ...(input.accountModels === undefined ? {} : { accountModels: input.accountModels }),
      byScore: true,
    });
    if (choice.profile !== null)
      return {
        role,
        need,
        ...profileFields(choice.profile, input.accountModels),
        reason: choice.reason,
      };
    // A tier name means the account offers nothing for it; an override the account serves without a profile
    // is launched as named, with nothing measured.
    return {
      role,
      need,
      ...nothing,
      ...(isModelTier(choice.model) ? {} : { model: choice.model, effort: choice.effort }),
      reason: choice.reason,
    };
  });
}
