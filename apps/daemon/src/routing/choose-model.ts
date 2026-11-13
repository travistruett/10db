import {
  isPickableModel,
  type AccountModelDto,
  type Effort,
  type ModelProfileDto,
  type ModelSetting,
  ModelTier,
  type ProjectDto,
  type StepRole,
  type TaskDto,
} from '@10db/contracts';
import type { FallbackRung } from './playbook-defaults';
import {
  atEffort,
  automatic,
  effortLevel,
  priceOf,
  tierLevel,
  tierPool,
  topModel,
  topSpan,
  withTopSpan,
  type TierPool,
} from './pools';
import { pickByDefault, ROLE_DEFAULT } from './role-defaults';
import { route, UnmeasuredError, type RouteChoice } from './router';

/** What a task tells the choice: its own model setting and effort. */
export type ChooseTask = Pick<TaskDto, 'modelSetting' | 'effortPin'>;

export interface ChooseInput {
  readonly def: { readonly role: StepRole; readonly need: number };
  /**
   * What the step asks of the model: the playbook cell's setting and each kind override's. The strongest
   * result wins, and an `automatic` one routes at the step's need.
   */
  readonly requirements: readonly ModelSetting[];
  /** The effort the playbook fixes for the step; null leaves it to the router. */
  readonly effort: Effort | null;
  /** The rung to run on when no profile has a score; null runs the role's default. */
  readonly fallback: FallbackRung | null;
  /** The playbook cell names one model: the result is pinned when that model is what runs. */
  readonly pinned: boolean;
  readonly task: ChooseTask;
  readonly project: Pick<ProjectDto, 'budgetCeiling'>;
  /** What the project's account offers, already narrowed by `offeredProfiles`. */
  readonly profiles: readonly ModelProfileDto[];
  /** The model the account runs for a tier instead of the automatic choice. */
  readonly tierOverrides: Readonly<Partial<Record<ModelTier, string>>>;
  /**
   * The account's own list, when the caller has it. With a list, an override naming a model the list lacks, or
   * has marked unusable, is not offered and gives way to the tier's automatic choice; without one an override
   * is launched as named, since nothing else can say what the account serves.
   */
  readonly accountModels?: readonly AccountModelDto[];
  /**
   * For a step whose model the account refused: the tier of that model. The step starts over in it whatever it
   * asks for, and the reason says so.
   */
  readonly startOverTier?: ModelTier;
  /**
   * Whether profiles that carry scores are routed by them. Off, the rung decides, which never refuses: a Plan
   * conversation chooses its model this way. Default on.
   */
  readonly byScore?: boolean;
}

export interface ModelChoice {
  /** Null when the account offers nothing routing may pick for the tier, or its override names a model with no profile. */
  readonly profile: ModelProfileDto | null;
  /** What to launch: the profile's model, an override's, or the tier's name when nothing is on offer. */
  readonly model: string;
  readonly effort: Effort;
  /** The tier the choice was made in, which names the step's model when there is no profile. */
  readonly tier: ModelTier;
  /** The setting that decided: the winning requirement. */
  readonly setting: ModelSetting;
  readonly reason: string;
  readonly overBudget: boolean;
  readonly pinned: boolean;
}

interface Made {
  readonly profile: ModelProfileDto;
  readonly reason: string;
  readonly overBudget: boolean;
}

const describeSetting = (setting: ModelSetting): string => {
  switch (setting.kind) {
    case 'automatic':
      return 'Automatic';
    case 'tier':
      return `the ${setting.tier} tier`;
    case 'top_of_tier':
      return setting.tier === undefined ? 'top of tier' : `top of the ${setting.tier} tier`;
    case 'model':
      return setting.model;
  }
};

/** Whether `a` is stronger than `b`: higher Intelligence when both are scored, else the higher rung, the dearer, then the higher effort. */
function stronger(a: ModelChoice, b: ModelChoice): boolean {
  if (a.profile === null || b.profile === null) return a.profile !== null && b.profile === null;
  const [x, y] = [a.profile, b.profile];
  const [sx, sy] = [x.scores.intelligence, y.scores.intelligence];
  if (sx !== null && sy !== null && sx !== sy) return sx > sy;
  const rung = (p: ModelProfileDto) => (p.tier === null ? -1 : tierLevel(p.tier));
  return (
    (rung(x) - rung(y) ||
      priceOf(x) - priceOf(y) ||
      effortLevel(x.effort) - effortLevel(y.effort)) > 0
  );
}

/**
 * Chooses the model and effort for one step, in one place. The task's own setting, when it has one, is the
 * step's only requirement; otherwise every requirement the playbook gives is chosen for on its own and the
 * strongest result wins. A requirement that names a model the account does not offer, or one its maker has
 * retired, takes the automatic choice of the step's rung, and the reason says so.
 */
export function chooseModel(input: ChooseInput): ModelChoice {
  const { def } = input;
  const byScore = input.byScore ?? true;
  const rung: FallbackRung = input.fallback ?? {
    tier: ROLE_DEFAULT[def.role].tier,
    top: false,
    effort: ROLE_DEFAULT[def.role].effort,
  };
  const fixed = input.task.effortPin ?? input.effort;
  const effort = fixed ?? rung.effort;

  const asked: { readonly settings: readonly ModelSetting[]; readonly source: string | null } =
    input.startOverTier !== undefined
      ? {
          settings: [{ kind: 'tier', tier: input.startOverTier }],
          source: `the refused model's tier (${input.startOverTier})`,
        }
      : input.task.modelSetting
        ? { settings: [input.task.modelSetting], source: "the task's own setting" }
        : {
            settings: input.requirements.length > 0 ? input.requirements : [{ kind: 'automatic' }],
            source: null,
          };

  /** Each model of the profiles at the fixed effort, or the nearest one it offers. */
  const atFixed = (profiles: readonly ModelProfileDto[]): readonly ModelProfileDto[] => {
    if (fixed === null) return profiles;
    const models = [...new Set(profiles.map((p) => p.model))];
    return models.flatMap((m) => atEffort(m, fixed, profiles) ?? []);
  };

  const scored = (considered: readonly ModelProfileDto[]): Made => {
    const choice: RouteChoice = route({
      role: def.role,
      need: def.need,
      budgetCeiling: input.project.budgetCeiling,
      profiles: considered,
      ...(input.accountModels === undefined ? {} : { accountModels: input.accountModels }),
    });
    return { profile: choice.profile, reason: choice.reason, overBudget: choice.overBudget };
  };

  const byRung = (
    pool: TierPool,
    considered: readonly ModelProfileDto[],
    top: boolean,
    note: string,
  ) => {
    const picked = pickByDefault({ tier: pool.tier, profiles: considered }, effort, top, '');
    return (
      picked && { profile: picked.profile, reason: `${picked.reason}${note}`, overBudget: false }
    );
  };

  /** The profile of a pool for the step: by score when asked to and the pool carries one, else by the rung. */
  const pickIn = (pool: TierPool, top: boolean): Made | undefined => {
    const considered = atFixed(top ? topModel(pool.profiles) : pool.profiles);
    if (!byScore) return byRung(pool, considered, top, '');
    try {
      return scored(considered);
    } catch (error) {
      if (!(error instanceof UnmeasuredError)) throw error;
      return byRung(
        pool,
        considered,
        top,
        '; no profile has an intelligence score to compare on yet (sync Artificial Analysis to route by score)',
      );
    }
  };

  const choose = (setting: ModelSetting): ModelChoice => {
    const source = asked.source === null ? '' : `${asked.source}: `;
    const finish = (made: Made | undefined, tier: ModelTier, note: string): ModelChoice => {
      if (!made)
        return {
          profile: null,
          model: tier,
          effort,
          tier,
          setting,
          reason: `${source}${note}no model offered for the ${tier} tier`,
          overBudget: false,
          pinned: false,
        };
      return {
        profile: made.profile,
        model: made.profile.model,
        effort: made.profile.effort,
        tier: made.profile.tier ?? tier,
        setting,
        reason: `${source}${note}${made.reason}`,
        overBudget: made.overBudget,
        pinned: false,
      };
    };

    /**
     * The account's override for the tier, as a choice, when it has one that applies. An override naming a model
     * with no profile at all (a gateway that lists none) is launched as named; one whose model is retired is not.
     */
    const overrideFor = (tier: ModelTier, note: string): ModelChoice | undefined => {
      // Capable and Frontier were one tier with one override, so an unset Frontier override is the Capable one.
      const name =
        input.tierOverrides[tier] ??
        (tier === ModelTier.Frontier ? input.tierOverrides[ModelTier.Capable] : undefined);
      if (name === undefined) return undefined;
      const listed = input.accountModels ?? [];
      if (listed.length > 0 && !listed.some((m) => m.model === name && !m.unusable))
        return undefined;
      const described = input.profiles.filter((p) => p.model === name);
      const named = described.filter((p) => isPickableModel(p.status));
      const prefix = `${note}the account's ${tier} model: `;
      if (named.length > 0) return finish(pickIn({ tier, profiles: named }, false), tier, prefix);
      if (described.length > 0) return undefined;
      return {
        profile: null,
        model: name,
        effort,
        tier,
        setting,
        reason: `${source}${note}the account's ${tier} model ${name}`,
        overBudget: false,
        pinned: false,
      };
    };

    /** The tier's automatic choice, or the account's override for the tier. */
    const inTier = (tier: ModelTier, top: boolean, note: string, spanning = true): ModelChoice => {
      // A top pick takes the dearest model of every tier its tier spans, unless the tier was named.
      const found = tierPool(tier, input.profiles);
      const pool = found && top && spanning ? withTopSpan(found, input.profiles) : found;
      // Capable and Frontier were one tier, so a step between them has not moved.
      const together = topSpan(ModelTier.Capable);
      const moved =
        pool === undefined ||
        pool.tier === tier ||
        (together.includes(tier) && together.includes(pool.tier))
          ? ''
          : `no ${tier} model is offered, so the ${pool.tier} tier: `;
      const overridden = top ? undefined : overrideFor(pool?.tier ?? tier, `${note}${moved}`);
      if (overridden) return overridden;
      if (!pool) return finish(undefined, tier, note);
      return finish(pickIn(pool, top), pool.tier, `${note}${moved}`);
    };

    /** Scores route among everything on offer; with none, the rung decides. */
    const automaticChoice = (): ModelChoice => {
      const every = input.profiles.filter(automatic);
      if (byScore && every.length > 0) {
        try {
          const made = scored(atFixed(every));
          return overrideFor(made.profile.tier ?? rung.tier, '') ?? finish(made, rung.tier, '');
        } catch (error) {
          if (!(error instanceof UnmeasuredError)) throw error;
        }
      }
      const found = inTier(rung.tier, rung.top, '');
      // A rung that takes the top still reads the account's override of the tier the pick landed in.
      return rung.top && found.profile ? (overrideFor(found.tier, '') ?? found) : found;
    };

    switch (setting.kind) {
      case 'automatic':
        return automaticChoice();
      case 'top_of_tier':
        // Named, the top of exactly that tier. Without a tier, the tier the step would have landed in, taken
        // to the dearest model of every tier it spans.
        return setting.tier === undefined
          ? inTier(automaticChoice().tier, true, '')
          : inTier(setting.tier, true, '', false);
      case 'tier':
        return inTier(setting.tier, false, '');
      case 'model': {
        const model = setting.model;
        const named = input.profiles.filter((p) => p.model === model && isPickableModel(p.status));
        if (named.length === 0)
          return inTier(
            rung.tier,
            false,
            `${describeSetting(setting)} is not offered by this account, so the ${rung.tier} tier's choice: `,
          );
        const tier = named[0]?.tier ?? rung.tier;
        return finish(pickIn({ tier, profiles: named }, false), tier, '');
      }
    }
  };

  const [first, ...rest] = asked.settings;
  let best = choose(first ?? { kind: 'automatic' });
  for (const setting of rest) {
    const next = choose(setting);
    if (stronger(next, best)) best = next;
  }
  return {
    ...best,
    pinned:
      input.pinned && best.setting.kind === 'model' && best.profile?.model === best.setting.model,
  };
}
