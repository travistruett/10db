import {
  isModelTier,
  StepRole,
  type ModelProfileDto,
  type PersonaDto,
  type RolePickDto,
} from '@10db/contracts';
import { DEFAULT_PERSONA_FOR, ROLE_NEED } from './catalogue';
import { chooseModel, type ChooseInput } from './choose-model';
import { costOnAccount } from './cost-on-account';
import { NoProfileError } from './router';

/** What the picks read: what choosing a model reads for a project of the account, and the live personas. */
export interface RolePicksInput extends Pick<
  ChooseInput,
  'profiles' | 'roleSettings' | 'patterns' | 'tierOverrides' | 'accountModels'
> {
  readonly personas: readonly PersonaDto[];
}

/** The persona a step of the role gets when the team binds none: the seeded default, else any of the role. */
function defaultPersona(role: StepRole, personas: readonly PersonaDto[]): PersonaDto | undefined {
  return (
    personas.find((p) => p.key === DEFAULT_PERSONA_FOR[role]) ??
    personas.find((p) => p.role === role)
  );
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
 * What routing chooses for each role, in flow order, for a task with no risk tags, no areas and no setting of its
 * own, in a project with no budget ceiling and no settings of its own. The global role settings and patterns, the
 * role's default persona and the account's tier overrides apply, as they do for any step.
 */
export function rolePicks(input: RolePicksInput): RolePickDto[] {
  return Object.values(StepRole).map((role): RolePickDto => {
    const need = ROLE_NEED[role];
    try {
      const choice = chooseModel({
        def: { role, need },
        persona: defaultPersona(role, input.personas),
        task: { riskTags: [], acceptanceCriteria: [], areas: [], modelSetting: null },
        project: { id: null, budgetCeiling: null },
        profiles: input.profiles,
        roleSettings: input.roleSettings,
        patterns: input.patterns,
        tierOverrides: input.tierOverrides,
        ...(input.accountModels === undefined ? {} : { accountModels: input.accountModels }),
        stakes: { retry: false },
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
    } catch (error) {
      if (!(error instanceof NoProfileError)) throw error;
      return {
        role,
        need,
        ...nothing,
        reason: `${error.message}; a task planned on this account is refused here`,
      };
    }
  });
}
