import {
  AccountKind,
  ConflictError,
  InvalidError,
  JudgeDecision,
  UpstreamError,
  type AccountId,
  type DecisionModelListDto,
  type JudgeConfig,
  type JudgeConfigPatch,
  type JudgeStatusDto,
} from '@10db/contracts';
import {
  findAccountRow,
  getAccountRow,
  getJudgeConfig,
  judgeCallModelStats,
  listJudgeCalls,
  listOpenRouterMeasures,
  patchJudgeConfig,
} from '@10db/db';
import type { ApiServices } from '../api';
import { openRouterLatencyMs } from '../catalogue';
import type { Clock } from '../clock';
import {
  KeychainError,
  readAccountSecretAsync,
  type AccountSecret,
  type Keychain,
} from '../environment';
import type { StateStore } from '../events';
import {
  decisionModelNumbers,
  JUDGE_LOG_RETENTION_MS,
  measuredDecisionTokens,
  TYPICAL_TOKENS_FALLBACK,
  type DecisionModelList,
  type JudgeService,
} from '../judge';

/** The judge's side of the HTTP API: its config, the account it runs on, the account test and the call log. */
export type JudgeApiServices = Pick<
  ApiServices,
  'judgeStatus' | 'patchJudge' | 'testAccount' | 'listJudgeCalls' | 'listDecisionModels'
>;

/** The models a patch sets that differ from the ones saved, each once. */
function newModels(config: JudgeConfig, patch: JudgeConfigPatch): string[] {
  const models = new Set<string>();
  for (const decision of Object.values(JudgeDecision)) {
    const model = patch.decisions?.[decision]?.model;
    if (model !== undefined && model !== config.decisions[decision].model) models.add(model);
  }
  return [...models];
}

/** A Keychain that refuses is a conflict the builder can act on, not a server fault. */
async function keychainConflict<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof KeychainError) throw new ConflictError(error.message);
    throw error;
  }
}

/**
 * The key a decision sends: the secret of the OpenRouter account decisions run on, through the same check
 * every account secret passes. No account, an archived or other kind of account, a missing or changed secret,
 * and a daemon started with the judge off, all mean no key.
 */
export function createJudgeKeyReader(deps: {
  readonly state: StateStore;
  readonly keychain: Keychain;
  readonly off: boolean;
}): (accountId: AccountId | null) => Promise<string | null> {
  return async (accountId) => {
    if (deps.off || accountId === null) return null;
    const account = findAccountRow(deps.state.db, accountId);
    if (!account || account.archived || account.kind !== AccountKind.OpenRouter) return null;
    const secret = await readAccountSecretAsync(account, deps.keychain);
    return secret.state === 'set' ? secret.secret : null;
  };
}

export function createJudgeServices(deps: {
  readonly state: StateStore;
  readonly keychain: Keychain;
  readonly judge: Pick<JudgeService, 'test'>;
  /** OpenRouter's decision models, for the picker. */
  readonly models: Pick<DecisionModelList, 'list'>;
  /** Started with `TENDB_JUDGE=off`: no Keychain item is read, even to say whether it is set. */
  readonly off: boolean;
  /** Called after a patch changed the account decisions run on, so a sync can read with the new key. */
  readonly onAccountChanged?: () => void;
  /** The time the 30-day window of the builder's own calls and the age of OpenRouter's latencies are judged by. */
  readonly clock: Clock;
}): JudgeApiServices {
  const status = async (): Promise<JudgeStatusDto> => {
    const config = getJudgeConfig(deps.state.db);
    const row =
      config.accountId === null ? undefined : findAccountRow(deps.state.db, config.accountId);
    if (!row || row.archived) return { config, account: null, off: deps.off };
    // Read off the event loop: the status is asked for on every visit to Settings. A daemon with the judge
    // off goes by the recorded fingerprint alone.
    const secret: Pick<AccountSecret, 'state'> = deps.off
      ? { state: row.secretFingerprint === null ? 'missing' : 'set' }
      : await keychainConflict(() => readAccountSecretAsync(row, deps.keychain));
    return {
      config,
      account: {
        id: row.id,
        label: row.label,
        secretSet: secret.state === 'set',
        secretState: secret.state,
      },
      off: deps.off,
    };
  };
  /** A new list with each model's cost and time added; the list held is never changed. */
  const withNumbers = (list: DecisionModelListDto): DecisionModelListDto => {
    const now = deps.clock.now();
    const stats = judgeCallModelStats(
      deps.state.db,
      new Date(now.getTime() - JUDGE_LOG_RETENTION_MS).toISOString(),
    );
    const priceOf = (model: string): number | null =>
      list.models.find((m) => m.id === model)?.inputUsdPerMillion ?? null;
    const measured = measuredDecisionTokens(stats, priceOf);
    const tokens = measured ?? TYPICAL_TOKENS_FALLBACK;
    const byModel = new Map(stats.map((s) => [s.model, s]));
    const measures = listOpenRouterMeasures(deps.state.db);
    return {
      ...list,
      models: list.models.map((model) => ({
        ...model,
        ...decisionModelNumbers(
          model,
          byModel.get(model.id),
          tokens,
          openRouterLatencyMs(
            measures.filter((m) => m.id === model.id),
            now,
          ),
          measured === null,
        ),
      })),
    };
  };
  return {
    judgeStatus: status,
    async patchJudge(patch) {
      // A model is saved only once it has answered a test decision with the key decisions will run on, so a setting
      // is never left naming a model 10db can't use.
      const config = getJudgeConfig(deps.state.db);
      const accountId = patch.accountId === undefined ? config.accountId : patch.accountId;
      const models = newModels(config, patch);
      if (deps.off && models.length > 0)
        throw new ConflictError(
          'This daemon was started with TENDB_JUDGE=off, so it cannot test a model',
        );
      for (const model of models) {
        const result =
          accountId === null
            ? { ok: false as const, error: 'No OpenRouter key is set' }
            : await keychainConflict(() => deps.judge.test(accountId, model));
        if (!result.ok)
          throw new InvalidError(
            `${model} didn't answer a test decision, so it wasn't saved: ${result.error}`,
          );
      }
      deps.state.write((ctx) => patchJudgeConfig(ctx, patch));
      if (accountId !== config.accountId) deps.onAccountChanged?.();
      return status();
    },
    testAccount(id) {
      const account = getAccountRow(deps.state.db, id);
      if (account.kind !== AccountKind.OpenRouter)
        throw new InvalidError(`Account "${account.label}" is not an OpenRouter account`);
      if (deps.off) throw new ConflictError('This daemon was started with TENDB_JUDGE=off');
      return keychainConflict(() => deps.judge.test(id));
    },
    listJudgeCalls: (limit) => listJudgeCalls(deps.state.db, limit),
    async listDecisionModels() {
      if (deps.off) throw new ConflictError('This daemon was started with TENDB_JUDGE=off');
      try {
        return withNumbers(await deps.models.list());
      } catch (error) {
        throw new UpstreamError(
          error instanceof Error ? error.message : "OpenRouter's model list could not be read",
        );
      }
    },
  };
}
