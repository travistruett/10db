import { ConflictError, type JudgeStatusDto } from '@10db/contracts';
import { getJudgeConfig, listJudgeCalls, patchJudgeConfig } from '@10db/db';
import type { ApiServices } from '../api';
import { KeychainError, OPENROUTER_KEY_ACCOUNT, type Keychain } from '../environment';
import type { StateStore } from '../events';
import type { JudgeService } from '../judge';

/** The judge's side of the HTTP API: its config, the OpenRouter key's status and calls, and the connection test. */
export type JudgeApiServices = Pick<
  ApiServices,
  'judgeStatus' | 'patchJudge' | 'setJudgeKey' | 'removeJudgeKey' | 'testJudge' | 'listJudgeCalls'
>;

/** A Keychain that refuses is a conflict the builder can act on, not a server fault. */
function keychainConflict<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof KeychainError) throw new ConflictError(error.message);
    throw error;
  }
}

export function createJudgeServices(deps: {
  readonly state: StateStore;
  readonly keychain: Keychain;
  readonly judge: Pick<JudgeService, 'test'>;
  /** Started with `TENDB_JUDGE=off`: the key is not read, even to say whether it is set. */
  readonly off: boolean;
}): JudgeApiServices {
  const status = (): JudgeStatusDto => ({
    config: getJudgeConfig(deps.state.db),
    keySet: deps.off
      ? false
      : keychainConflict(() => deps.keychain.read(OPENROUTER_KEY_ACCOUNT) !== null),
    off: deps.off,
  });
  return {
    judgeStatus: status,
    patchJudge(patch) {
      deps.state.write((ctx) => patchJudgeConfig(ctx, patch));
      return status();
    },
    setJudgeKey(input) {
      keychainConflict(() => {
        deps.keychain.write(OPENROUTER_KEY_ACCOUNT, input.key);
      });
      return status();
    },
    removeJudgeKey() {
      keychainConflict(() => {
        deps.keychain.remove(OPENROUTER_KEY_ACCOUNT);
      });
      return status();
    },
    testJudge: () => deps.judge.test(),
    listJudgeCalls: (limit) => listJudgeCalls(deps.state.db, limit),
  };
}
