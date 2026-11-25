import {
  AccountKind,
  DEFAULT_JUDGE_CONFIG,
  isModelTier,
  JudgeDecision,
  ModelTier,
  OPENROUTER_SECOND_OPINION_MODEL,
  Provider,
  StepRole,
  type AccountModelDto,
  type DecisionModelDto,
} from '@10db/contracts';
import {
  getJudgeConfig,
  listAccountModels,
  patchJudgeConfig,
  type AccountRow,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import { chooseModel } from '../routing';
import { routingInputs } from '../team';

/** The model every decision starts on for an OpenRouter account. */
const OPENROUTER_DEFAULT_MODEL = DEFAULT_JUDGE_CONFIG.decisions.shape_record.model;

/** The models an Anthropic API key or Bedrock account lists, by the id a call is made with. */
function listed(db: DbReader, account: Pick<AccountRow, 'id'>): AccountModelDto[] {
  return listAccountModels(db, account.id);
}

/**
 * The model every decision is set to when Decisions move to the account: OpenRouter's System One model, else the
 * account's Efficient tier model as routing resolves tiers, by the id a call is made with. Null when the account
 * lists no such model, or has not read its list yet.
 */
export function defaultDecisionModel(
  db: DbReader,
  account: Pick<AccountRow, 'id' | 'kind'>,
): string | null {
  if (account.kind === AccountKind.OpenRouter) return OPENROUTER_DEFAULT_MODEL;
  return tierModel(db, account, ModelTier.Efficient);
}

/**
 * The model the second opinion on limits starts on: on OpenRouter, the model the replay validated; on an Anthropic
 * API key or Bedrock account, whose first judge is already its Efficient model, the Balanced tier's from its own list.
 * Null when the account lists no such model.
 */
export function defaultSecondOpinionModel(
  db: DbReader,
  account: Pick<AccountRow, 'id' | 'kind'>,
): string | null {
  if (account.kind === AccountKind.OpenRouter) return OPENROUTER_SECOND_OPINION_MODEL;
  return tierModel(db, account, ModelTier.Balanced);
}

/** The model each decision starts on when Decisions move to the account. */
export function defaultModelFor(
  db: DbReader,
  account: Pick<AccountRow, 'id' | 'kind'>,
  decision: string,
): string | null {
  return decision === JudgeDecision.CrossesLimitSecond
    ? (defaultSecondOpinionModel(db, account) ?? defaultDecisionModel(db, account))
    : defaultDecisionModel(db, account);
}

/**
 * Moves the second opinion on limits to the account's default for it when the stored model is one an Anthropic API
 * key or Bedrock account doesn't list: a config saved before the decision existed reads with OpenRouter's model.
 * Writes nothing for an OpenRouter account, or when the account lists no such model.
 */
export function settleSecondOpinionModel(ctx: WriteContext, account: AccountRow | undefined): void {
  if (account === undefined || account.archived) return;
  const stored = getJudgeConfig(ctx.tx).decisions[JudgeDecision.CrossesLimitSecond].model;
  const offered = offeredDecisionModels(ctx.tx, account);
  if (offered === null || offered.size === 0 || offered.has(stored)) return;
  const model = defaultSecondOpinionModel(ctx.tx, account);
  if (model === null || model === stored) return;
  patchJudgeConfig(ctx, { decisions: { [JudgeDecision.CrossesLimitSecond]: { model } } });
}

/** The launch id of the account's model for `tier`, as routing resolves tiers; null when it lists none. */
function tierModel(
  db: DbReader,
  account: Pick<AccountRow, 'id' | 'kind'>,
  tier: ModelTier,
): string | null {
  const models = listed(db, account);
  if (models.length === 0) return null;
  const choice = chooseModel({
    ...routingInputs(db, { accountId: account.id, provider: Provider.Claude }),
    def: { role: StepRole.Plan, need: 0 },
    requirements: [{ kind: 'automatic' }],
    effort: null,
    fallback: null,
    pinned: false,
    task: { modelSetting: { kind: 'tier', tier }, effortPin: null },
    project: { budgetCeiling: null },
    byScore: false,
  });
  if (isModelTier(choice.model)) return null;
  return models.find((m) => m.model === choice.model)?.launchId ?? null;
}

/**
 * The ids a decision may name on the account, or null when any id may be tried (OpenRouter: the test decision is
 * its check, and its model lists change daily).
 */
export function offeredDecisionModels(
  db: DbReader,
  account: Pick<AccountRow, 'id' | 'kind'>,
): ReadonlySet<string> | null {
  if (account.kind === AccountKind.OpenRouter) return null;
  return new Set(listed(db, account).map((m) => m.launchId));
}

/** The account's own list as the Decisions picker shows it: no numbers yet, which the caller adds. */
export function accountDecisionModelList(
  db: DbReader,
  account: Pick<AccountRow, 'id' | 'kind'>,
): DecisionModelDto[] {
  const maker = account.kind === AccountKind.Bedrock ? 'Bedrock' : 'Anthropic';
  return listed(db, account).map((m) => ({
    id: m.launchId,
    name: m.model,
    maker,
    latest: false,
    inputUsdPerMillion: m.inputPrice,
    outputUsdPerMillion: m.outputPrice,
    cantCall: null,
    costPerMillionUsd: null,
    secondsPerDecision: null,
    costSource: null,
    timeSource: null,
  }));
}
