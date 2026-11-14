import {
  AccountKind,
  DEFAULT_JUDGE_CONFIG,
  InvalidError,
  JudgeConfig,
  type JudgeConfigPatch,
  type AskedDecision,
} from '@10db/contracts';
import { findAccountRow } from './accounts';
import { getAppSetting, setAppSetting } from './settings';
import type { DbReader, WriteContext } from './store';

const JUDGE_SETTING_KEY = 'judge';

/** The stored config, or the defaults when it is missing or does not parse. */
export function getJudgeConfig(db: DbReader): JudgeConfig {
  const parsed = JudgeConfig.safeParse(getAppSetting(db, JUDGE_SETTING_KEY));
  return parsed.success ? parsed.data : DEFAULT_JUDGE_CONFIG;
}

/** Merges the patch into the current config, field by field, stores it and answers it. */
export function patchJudgeConfig(ctx: WriteContext, patch: JudgeConfigPatch): JudgeConfig {
  const current = getJudgeConfig(ctx.tx);
  const changes: Record<string, NonNullable<JudgeConfigPatch['decisions']>[AskedDecision]> =
    patch.decisions ?? {};
  const decisions = Object.fromEntries(
    Object.entries(current.decisions).map(([name, now]) => [name, { ...now, ...changes[name] }]),
  );
  // Both inputs were parsed by the contract's schemas, so the merge is a JudgeConfig; parsing again
  // is what guarantees it.
  const accountId = patch.accountId === undefined ? current.accountId : patch.accountId;
  // A patch that names an account is checked whether or not it changes it; one that names none keeps what is stored.
  if (patch.accountId !== undefined && patch.accountId !== null) {
    const account = findAccountRow(ctx.tx, patch.accountId);
    if (!account) throw new InvalidError('Decisions run on an account that exists');
    if (account.archived) throw new InvalidError(`Account "${account.label}" is archived`);
    if (account.kind !== AccountKind.OpenRouter)
      throw new InvalidError(`Decisions run on an OpenRouter account, not "${account.label}"`);
  }
  const next = JudgeConfig.parse({
    enabled: patch.enabled ?? current.enabled,
    accountId,
    decisions,
  });
  setAppSetting(ctx, JUDGE_SETTING_KEY, next);
  return next;
}
