import {
  ModelStatus,
  ROLE_SCORE,
  ScoreKind,
  type FlowStepDef,
  type ModelProfileDto,
  type ModelSetting,
  type ModelTier,
  type PatternDto,
  type PatternMatch,
  type PersonaDto,
  type ProjectDto,
  type RoleSettingDto,
  type StepRole,
  type TaskDto,
} from '@10db/contracts';
import { higherFloor, stepFloor, type Floor } from './floors';
import { atEffort, automatic, effortAbove, tierPool, topModel, type TierPool } from './pools';
import { defaultTier, pickByDefault, ROLE_DEFAULT } from './role-defaults';
import { route, UnmeasuredError, type RouteChoice } from './router';
import type { TaskShape } from './skip-rules';

/** What a task tells the choice: its risk and areas for patterns, its criteria for skipping, its own setting. */
export type ChooseTask = TaskShape & Pick<TaskDto, 'areas' | 'modelSetting'>;

export interface ChooseInput {
  readonly def: Pick<FlowStepDef, 'role' | 'need'>;
  /** The persona playing the step; its pin and minimum score apply. */
  readonly persona: PersonaDto | undefined;
  readonly task: ChooseTask;
  readonly project: Pick<ProjectDto, 'id' | 'budgetCeiling'>;
  /** What the project's account offers, already narrowed by `offeredProfiles`. */
  readonly profiles: readonly ModelProfileDto[];
  readonly roleSettings: readonly RoleSettingDto[];
  readonly patterns: readonly PatternDto[];
  /** The model the account runs for a tier instead of the automatic choice. */
  readonly tierOverrides: Readonly<Partial<Record<ModelTier, string>>>;
  readonly stakes: { readonly retry: boolean };
}

export interface ModelChoice {
  /** Null when the account offers nothing routing may pick for the tier. */
  readonly profile: ModelProfileDto | null;
  /** The tier the choice was made in, which names the step's model when there is no profile. */
  readonly tier: ModelTier;
  /** The setting that decided: the first that applied, or Automatic when none did. */
  readonly setting: ModelSetting;
  readonly reason: string;
  readonly score: ScoreKind;
  readonly overBudget: boolean;
  readonly pinned: boolean;
}

const AUTOMATIC: ModelSetting = { kind: 'automatic' };

function matches(match: PatternMatch, role: StepRole, task: ChooseTask, retry: boolean): boolean {
  return (
    (match.roles.length === 0 || match.roles.includes(role)) &&
    (match.riskTags.length === 0 || match.riskTags.some((t) => task.riskTags.includes(t))) &&
    (match.areas.length === 0 || match.areas.some((a) => task.areas.includes(a))) &&
    (!match.retryOnly || retry)
  );
}

interface Decided {
  readonly setting: ModelSetting;
  /** Who decided, as a phrase for the reason; null for the default. */
  readonly source: string | null;
}

/** The first setting that applies: the task, a pattern, a role, else Automatic. */
function decide(input: ChooseInput): Decided {
  const { task, project, def } = input;
  if (task.modelSetting) return { setting: task.modelSetting, source: "the task's own setting" };
  const patterns = [...input.patterns].sort((a, b) => a.position - b.position);
  for (const scope of [project.id, null]) {
    const hit = patterns.find(
      (p) => p.projectId === scope && matches(p.match, def.role, task, input.stakes.retry),
    );
    if (hit) return { setting: hit.setting, source: `the pattern "${hit.name}"` };
  }
  for (const scope of [project.id, null]) {
    const hit = input.roleSettings.find((r) => r.role === def.role && r.projectId === scope);
    if (hit)
      return {
        setting: hit.setting,
        source: scope === null ? "the role's setting" : "the project's role setting",
      };
  }
  return { setting: AUTOMATIC, source: null };
}

interface Made {
  readonly profile: ModelProfileDto;
  readonly reason: string;
  readonly score: ScoreKind;
  readonly overBudget: boolean;
}

interface Request {
  readonly input: ChooseInput;
  readonly floor: Floor;
  /** The profiles to choose among. */
  readonly pool: TierPool;
  /** Whether a pool where no profile reaches the minimum refuses, or takes its highest scoring. */
  readonly strict: boolean;
}

/** The cheapest profile of the pool that clears the step's need and floor, by score; throws when none is scored. */
function scored(request: Request, considered: readonly ModelProfileDto[]): Made {
  const { input, floor } = request;
  const choice: RouteChoice = route({
    role: input.def.role,
    need: input.def.need,
    floor,
    budgetCeiling: input.project.budgetCeiling,
    profiles: considered,
    shortfall: request.strict ? 'refuse' : 'strongest',
  });
  return {
    profile: choice.profile,
    reason: choice.reason,
    score: choice.score,
    overBudget: choice.overBudget,
  };
}

/**
 * The profile of a pool for the step: by score when the pool's profiles carry one, otherwise by the role's
 * default effort. A floor with no score to measure it by raises the step to the pool's top model, one effort up.
 */
function pickIn(request: Request, top: boolean): Made | undefined {
  const { input, floor, pool } = request;
  const considered = top ? topModel(pool.profiles) : pool.profiles;
  try {
    return scored(request, considered);
  } catch (error) {
    if (!(error instanceof UnmeasuredError)) throw error;
    const floored = floor.minimum > input.def.need && floor.why !== null;
    const own = ROLE_DEFAULT[input.def.role];
    const picked = pickByDefault(
      { tier: pool.tier, profiles: considered },
      floored ? effortAbove(own.effort) : own.effort,
      top || floored,
      floored ? `, one effort up (floor: ${floor.why})` : '',
    );
    return (
      picked && {
        profile: picked.profile,
        reason: `${picked.reason}; no profile has ${article(error.kind)} ${error.kind} score to compare on yet (sync Artificial Analysis to route by score)`,
        score: ROLE_SCORE[input.def.role],
        overBudget: false,
      }
    );
  }
}

/** The indefinite article for a score kind's name. */
const article = (kind: ScoreKind): string => (kind === ScoreKind.Coding ? 'a' : 'an');

const describeSetting = (setting: ModelSetting): string => {
  switch (setting.kind) {
    case 'automatic':
      return 'Automatic';
    case 'tier':
      return `the ${setting.tier} tier`;
    case 'top_of_tier':
      return 'top of tier';
    case 'model':
      return setting.model;
  }
};

/**
 * Chooses the model and effort for one step, in one place. The first of these decides what the step asks for:
 * the persona's pin, the task's setting, a pattern (the project's before the global ones), the role's setting
 * (the project's before the global one), then 10db's default for the role. A setting that names a model the
 * account does not offer, or one its maker has retired, takes the automatic choice of the role's tier, and the
 * reason says so. The router then chooses inside the pool the setting names.
 */
export function chooseModel(input: ChooseInput): ModelChoice {
  const { def, persona } = input;
  const roleScore = ROLE_SCORE[def.role];
  const personaFloor: Floor =
    persona && persona.minimumScore !== null
      ? { minimum: persona.minimumScore, why: `${persona.key} minimum` }
      : { minimum: 0, why: null };
  const floor = higherFloor(stepFloor(def.role, input.task.riskTags), personaFloor);
  const floored = floor.minimum > def.need && floor.why !== null;
  const roleTier = defaultTier(def.role, floored);
  const decided = decide(input);

  const pin = persona?.modelPin ?? null;
  let pinNote = '';
  if (pin && persona) {
    const model = input.profiles.filter(
      (p) => p.model === pin.model && p.status !== ModelStatus.Retired,
    );
    const profile = atEffort(pin.model, pin.effort, model);
    if (profile)
      return {
        profile,
        tier: profile.tier ?? roleTier,
        setting: { kind: 'model', model: pin.model },
        reason: `pinned by ${persona.key}`,
        score: roleScore,
        overBudget: false,
        pinned: true,
      };
    pinNote = `${persona.key} pins ${pin.model}, which this account does not offer; `;
  }

  const finish = (made: Made | undefined, tier: ModelTier, note: string): ModelChoice => {
    const source = decided.source === null ? '' : `${decided.source}: `;
    if (!made)
      return {
        profile: null,
        tier,
        setting: decided.setting,
        reason: `${pinNote}${source}${note}no model offered for the ${tier} tier`,
        score: roleScore,
        overBudget: false,
        pinned: false,
      };
    return {
      profile: made.profile,
      tier: made.profile.tier ?? tier,
      setting: decided.setting,
      reason: `${pinNote}${source}${note}${made.reason}`,
      score: made.score,
      overBudget: made.overBudget,
      pinned: false,
    };
  };

  /** The tier's automatic choice, or the account's override for the tier when it names a model on offer. */
  const inTier = (tier: ModelTier, top: boolean, note: string): ModelChoice => {
    const pool = tierPool(tier, input.profiles);
    if (!pool) return finish(undefined, tier, note);
    const override = input.tierOverrides[pool.tier];
    const named =
      top || override === undefined
        ? []
        : input.profiles.filter((p) => p.model === override && p.status !== ModelStatus.Retired);
    const request: Request = {
      input,
      floor,
      pool: named.length > 0 ? { tier: pool.tier, profiles: named } : pool,
      strict: false,
    };
    const moved =
      pool.tier === tier ? '' : `no ${tier} model is offered, so the ${pool.tier} tier: `;
    const overridden = named.length > 0 ? `the account's ${pool.tier} model: ` : '';
    return finish(pickIn(request, top), pool.tier, `${note}${moved}${overridden}`);
  };

  /** Scores route among everything on offer; with none, the role's tier decides. */
  const automaticChoice = (): ModelChoice => {
    const every = input.profiles.filter(automatic);
    if (every.length > 0) {
      try {
        const request: Request = {
          input,
          floor,
          pool: { tier: roleTier, profiles: every },
          strict: true,
        };
        return finish(scored(request, every), roleTier, '');
      } catch (error) {
        if (!(error instanceof UnmeasuredError)) throw error;
      }
    }
    return inTier(roleTier, false, '');
  };

  switch (decided.setting.kind) {
    case 'automatic':
      return automaticChoice();
    // The tier the step would have landed in, taken to its dearest model.
    case 'top_of_tier':
      return inTier(automaticChoice().tier, true, '');
    case 'tier':
      return inTier(decided.setting.tier, false, '');
    case 'model': {
      const model = decided.setting.model;
      const named = input.profiles.filter(
        (p) => p.model === model && p.status !== ModelStatus.Retired,
      );
      if (named.length === 0)
        return inTier(
          roleTier,
          false,
          `${describeSetting(decided.setting)} is not offered by this account, so the ${roleTier} tier's choice: `,
        );
      const tier = named[0]?.tier ?? roleTier;
      return finish(
        pickIn({ input, floor, pool: { tier, profiles: named }, strict: false }, false),
        tier,
        '',
      );
    }
  }
}
