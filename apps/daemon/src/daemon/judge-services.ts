import {
  JudgeDecision,
  AccountKind,
  BedrockSettings,
  ConflictError,
  InvalidError,
  JudgeConfigPatch,
  needsSecret,
  parseAccountSettings,
  powersDecisions,
  UpstreamError,
  type AccountId,
  type DecisionModelListDto,
  type JudgeConfig,
  type JudgeStatusDto,
} from '@10db/contracts';
import {
  checkDecisionAccount,
  findAccountRow,
  getAccountRow,
  getJudgeConfig,
  judgeCallModelStats,
  judgeDecisionStats,
  listJudgeCalls,
  listOpenRouterMeasures,
  pageJudgeCalls,
  patchJudgeConfig,
  type AccountRow,
  type DbReader,
} from '@10db/db';
import {
  defaultDecisionModel,
  defaultModelFor,
  offeredDecisionModels,
  accountDecisionModelList,
} from './decision-offer';
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
  typicalDecisionTokens,
  type DecisionModelList,
  NO_DECISION_CREDENTIAL,
  type JudgeCredential,
  type JudgeService,
  JudgeTestKind,
} from '../judge';

/** The judge's side of the HTTP API: its config, the account it runs on, the account test and the call log. */
export type JudgeApiServices = Pick<
  ApiServices,
  | 'judgeStatus'
  | 'patchJudge'
  | 'testAccount'
  | 'listJudgeCalls'
  | 'pageJudgeCalls'
  | 'judgeDecisionStats'
  | 'listDecisionModels'
>;

/** The AWS profile a Bedrock account signs with, or null when it has none or is another kind. */
function awsProfileOf(account: AccountRow): string | null {
  if (account.kind !== AccountKind.Bedrock) return null;
  const settings = BedrockSettings.safeParse(account.settings);
  return settings.success ? settings.data.awsProfile : null;
}

/** A model a patch leaves a decision on, and how that decision asks it. */
interface ModelTest {
  readonly model: string;
  readonly kind: JudgeTestKind;
}

/** The limits, acceptance and watchpoint question decisions ask yes/no questions; every other decision asks a choice. */
function testKind(decision: string): JudgeTestKind {
  switch (decision) {
    case JudgeDecision.CrossesLimit:
    case JudgeDecision.CrossesLimitSecond:
    case JudgeDecision.Acceptance:
    case JudgeDecision.AcceptanceSecond:
    case JudgeDecision.WatchpointQuestion:
    case JudgeDecision.OwnershipTest:
      return JudgeTestKind.Nouls;
    default:
      return JudgeTestKind.Choice;
  }
}

function distinctTests(tests: readonly ModelTest[]): ModelTest[] {
  const seen = new Map(tests.map((t) => [`${t.kind}\u0000${t.model}`, t]));
  return [...seen.values()];
}

/** The models a patch sets that differ from the ones saved, each once per way it is asked. */
function newModels(config: JudgeConfig, patch: JudgeConfigPatch): ModelTest[] {
  const changes: Record<string, { readonly model?: string | undefined } | undefined> =
    patch.decisions ?? {};
  return distinctTests(
    Object.entries(config.decisions).flatMap(([decision, now]) => {
      const model = changes[decision]?.model;
      return model !== undefined && model !== now.model
        ? [{ model, kind: testKind(decision) }]
        : [];
    }),
  );
}

/** Every distinct model a patch leaves the decisions on, once per way it is asked. */
function decisionModels(config: JudgeConfig, patch: JudgeConfigPatch): ModelTest[] {
  const changes: Record<string, { readonly model?: string | undefined } | undefined> =
    patch.decisions ?? {};
  return distinctTests(
    Object.entries(config.decisions).map(([decision, now]) => ({
      model: changes[decision]?.model ?? now.model,
      kind: testKind(decision),
    })),
  );
}

/** A decision may name only a model the account offers; an OpenRouter account's test decision is its check. */
function refuseUnoffered(db: DbReader, account: AccountRow, models: readonly string[]): void {
  const offered = offeredDecisionModels(db, account);
  if (offered === null) return;
  const unknown = models.find((m) => !offered.has(m));
  if (unknown !== undefined) throw new InvalidError(`"${account.label}" does not offer ${unknown}`);
}

/**
 * The patch that moves every decision to the account: each decision's model is the account's default unless the
 * patch names one the account offers.
 */
function switchedTo(
  db: DbReader,
  account: AccountRow,
  config: JudgeConfig,
  patch: JudgeConfigPatch,
): JudgeConfigPatch {
  const named: Record<string, { readonly model?: string | undefined } | undefined> =
    patch.decisions ?? {};
  refuseUnoffered(
    db,
    account,
    Object.values(named).flatMap((c) => (c?.model === undefined ? [] : [c.model])),
  );
  if (defaultDecisionModel(db, account) === null)
    throw new InvalidError(
      `"${account.label}" has no model list yet; check the account in Settings › Accounts first`,
    );
  const decisions = Object.fromEntries(
    Object.keys(config.decisions).map((decision) => [
      decision,
      {
        ...named[decision],
        model: named[decision]?.model ?? defaultModelFor(db, account, decision) ?? undefined,
      },
    ]),
  );
  return JudgeConfigPatch.parse({ ...patch, decisions });
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
 * What a decision call is signed with: the secret of an OpenRouter or Anthropic API key account, through the same
 * check every account secret passes, or a Bedrock account's region with its profile or bearer token (a profile reads
 * no Keychain item). No account, an archived or other kind of account, a missing or changed secret, and a daemon
 * started with the judge off, all mean no credential.
 */
export function createJudgeCredentialReader(deps: {
  readonly state: StateStore;
  readonly keychain: Keychain;
  readonly off: boolean;
}): (accountId: AccountId | null) => Promise<JudgeCredential | null> {
  return async (accountId) => {
    if (deps.off || accountId === null) return null;
    const account = findAccountRow(deps.state.db, accountId);
    if (!account || account.archived) return null;
    if (account.kind === AccountKind.OpenRouter || account.kind === AccountKind.AnthropicApiKey) {
      const secret = await readAccountSecretAsync(account, deps.keychain);
      return secret.state === 'set' ? { kind: account.kind, key: secret.secret } : null;
    }
    if (account.kind !== AccountKind.Bedrock) return null;
    const settings = BedrockSettings.safeParse(account.settings);
    if (!settings.success) return null;
    const { region, awsProfile } = settings.data;
    if (awsProfile !== null) return { kind: account.kind, region, awsProfile, bearerToken: null };
    const secret = await readAccountSecretAsync(account, deps.keychain);
    return secret.state === 'set'
      ? { kind: account.kind, region, awsProfile: null, bearerToken: secret.secret }
      : null;
  };
}

export function createJudgeServices(deps: {
  readonly state: StateStore;
  readonly keychain: Keychain;
  readonly judge: Pick<JudgeService, 'test' | 'lastFallback'>;
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
    // An account that signs with an AWS profile keeps no secret, so none can be missing.
    const secret: Pick<AccountSecret, 'state'> = !needsSecret(
      row.kind,
      parseAccountSettings(row.kind, row.settings),
    )
      ? { state: 'set' }
      : deps.off
        ? { state: row.secretFingerprint === null ? 'missing' : 'set' }
        : await keychainConflict(() => readAccountSecretAsync(row, deps.keychain));
    return {
      config,
      account: {
        id: row.id,
        label: row.label,
        secretSet: secret.state === 'set',
        secretState: secret.state,
        fallback: deps.judge.lastFallback(row.id),
        awsProfile: awsProfileOf(row),
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
    const typical = typicalDecisionTokens(stats, priceOf);
    const byModel = new Map(stats.map((s) => [s.model, s]));
    const measures = listOpenRouterMeasures(deps.state.db);
    return {
      ...list,
      models: list.models.map((model) => ({
        ...model,
        ...decisionModelNumbers(
          model,
          byModel.get(model.id),
          typical.tokens,
          openRouterLatencyMs(
            measures.filter((m) => m.id === model.id),
            now,
          ),
          typical.assumed,
        ),
      })),
    };
  };
  return {
    judgeStatus: status,
    async patchJudge(patch) {
      // A model is saved only once it has answered a test decision with the credential decisions will run on, so a
      // setting is never left naming a model 10db can't use.
      const config = getJudgeConfig(deps.state.db);
      const accountId = patch.accountId === undefined ? config.accountId : patch.accountId;
      const account =
        patch.accountId === undefined || patch.accountId === null
          ? null
          : checkDecisionAccount(deps.state.db, patch.accountId);
      const switching = account !== null && account.id !== config.accountId;
      const current =
        accountId === null ? null : (account ?? findAccountRow(deps.state.db, accountId) ?? null);
      let next: JudgeConfigPatch = patch;
      if (switching) next = switchedTo(deps.state.db, account, config, patch);
      const tests = switching ? decisionModels(config, next) : newModels(config, patch);
      if (current !== null && !switching)
        refuseUnoffered(
          deps.state.db,
          current,
          tests.map((t) => t.model),
        );
      if (deps.off && tests.length > 0)
        throw new ConflictError(
          'This daemon was started with TENDB_JUDGE=off, so it cannot test a model',
        );
      // On a switch, a second opinion the builder didn't name that fails its test falls back to the first judge's
      // default rather than refusing the switch: the builder never picked it.
      const second = next.decisions?.[JudgeDecision.CrossesLimitSecond]?.model;
      const secondNamed = patch.decisions?.[JudgeDecision.CrossesLimitSecond]?.model !== undefined;
      for (const { model, kind } of tests) {
        const result =
          accountId === null
            ? { ok: false as const, error: NO_DECISION_CREDENTIAL }
            : await keychainConflict(() => deps.judge.test(accountId, model, kind));
        if (result.ok) continue;
        const firstDefault = next.decisions?.[JudgeDecision.CrossesLimit]?.model;
        // Another decision the switch saves on the same model keeps the refusal: it would be saved on a model that failed.
        const otherUses = Object.entries(next.decisions ?? {}).some(
          ([decision, c]) => decision !== JudgeDecision.CrossesLimitSecond && c?.model === model,
        );
        if (
          switching &&
          !secondNamed &&
          !otherUses &&
          model === second &&
          firstDefault !== undefined &&
          firstDefault !== model
        ) {
          next = {
            ...next,
            decisions: {
              ...next.decisions,
              [JudgeDecision.CrossesLimitSecond]: {
                ...next.decisions?.[JudgeDecision.CrossesLimitSecond],
                model: firstDefault,
              },
            },
          };
          continue;
        }
        throw new InvalidError(
          kind === JudgeTestKind.Nouls
            ? `${model} didn't answer a test yes/no question, which the limits decisions ask, so it wasn't saved: ${result.error}`
            : `${model} didn't answer a test decision, so it wasn't saved: ${result.error}`,
        );
      }
      deps.state.write((ctx) => patchJudgeConfig(ctx, next));
      if (accountId !== config.accountId) deps.onAccountChanged?.();
      return status();
    },
    testAccount(id) {
      const account = getAccountRow(deps.state.db, id);
      if (!powersDecisions(account.kind))
        throw new InvalidError(`Account "${account.label}" can't answer decisions`);
      if (deps.off) throw new ConflictError('This daemon was started with TENDB_JUDGE=off');
      // Each account is tried on its own default model: another account's model id means nothing to it.
      const model = defaultDecisionModel(deps.state.db, account);
      if (model === null)
        throw new InvalidError(
          `"${account.label}" has no model list yet; check the account in Settings › Accounts first`,
        );
      return keychainConflict(() => deps.judge.test(id, model));
    },
    listJudgeCalls: (limit) => listJudgeCalls(deps.state.db, limit),
    pageJudgeCalls: (query) => pageJudgeCalls(deps.state.db, query),
    judgeDecisionStats() {
      const since = new Date(deps.clock.now().getTime() - JUDGE_LOG_RETENTION_MS).toISOString();
      return { since, decisions: judgeDecisionStats(deps.state.db, since) };
    },
    async listDecisionModels() {
      if (deps.off) throw new ConflictError('This daemon was started with TENDB_JUDGE=off');
      const { accountId } = getJudgeConfig(deps.state.db);
      const account = accountId === null ? undefined : findAccountRow(deps.state.db, accountId);
      if (account && !account.archived && account.kind !== AccountKind.OpenRouter)
        return withNumbers({
          models: accountDecisionModelList(deps.state.db, account),
          fetchedAt: deps.clock.now().toISOString(),
        });
      let list: DecisionModelListDto;
      try {
        list = await deps.models.list();
      } catch (error) {
        throw new UpstreamError(
          error instanceof Error ? error.message : "OpenRouter's model list could not be read",
        );
      }
      // Outside the try: a fault of our own database is not OpenRouter's.
      return withNumbers(list);
    },
  };
}
