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
async function keychainConflict<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
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
  const status = async (): Promise<JudgeStatusDto> => ({
    config: getJudgeConfig(deps.state.db),
    // Read off the event loop: the status is asked for on every visit to Settings.
    keySet: deps.off
      ? false
      : await keychainConflict(
          async () => (await deps.keychain.readAsync(OPENROUTER_KEY_ACCOUNT)) !== null,
        ),
    off: deps.off,
  });
  return {
    judgeStatus: status,
    async patchJudge(patch) {
      deps.state.write((ctx) => patchJudgeConfig(ctx, patch));
      return status();
    },
    async setJudgeKey(input) {
      await keychainConflict(() => {
        deps.keychain.write(OPENROUTER_KEY_ACCOUNT, input.key);
      });
      return status();
    },
    async removeJudgeKey() {
      await keychainConflict(() => {
        deps.keychain.remove(OPENROUTER_KEY_ACCOUNT);
      });
      return status();
    },
    testJudge: () => deps.judge.test(),
    listJudgeCalls: (limit) => listJudgeCalls(deps.state.db, limit),
  };
}
