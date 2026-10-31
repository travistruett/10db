import {
  DEFAULT_JUDGE_CONFIG,
  JudgeConfig,
  type JudgeConfigPatch,
  JudgeDecision,
} from '@10db/contracts';
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
  const decisions = Object.fromEntries(
    Object.values(JudgeDecision).map((name) => [
      name,
      { ...current.decisions[name], ...patch.decisions?.[name] },
    ]),
  );
  // Both inputs were parsed by the contract's schemas, so the merge is a JudgeConfig; parsing again
  // is what guarantees it.
  const next = JudgeConfig.parse({ enabled: patch.enabled ?? current.enabled, decisions });
  setAppSetting(ctx, JUDGE_SETTING_KEY, next);
  return next;
}
