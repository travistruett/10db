import {
  AccountKind,
  DEFAULT_JUDGE_CONFIG,
  isModelTier,
  ModelTier,
  Provider,
  StepRole,
  type AccountModelDto,
  type DecisionModelDto,
} from '@10db/contracts';
import { listAccountModels, type AccountRow, type DbReader } from '@10db/db';
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
  const models = listed(db, account);
  if (models.length === 0) return null;
  const choice = chooseModel({
    ...routingInputs(db, { accountId: account.id, provider: Provider.Claude }),
    def: { role: StepRole.Plan, need: 0 },
    requirements: [{ kind: 'automatic' }],
    effort: null,
    fallback: null,
    pinned: false,
    task: { modelSetting: { kind: 'tier', tier: ModelTier.Efficient }, effortPin: null },
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
