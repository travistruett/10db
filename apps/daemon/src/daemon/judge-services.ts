import {
  AccountKind,
  ConflictError,
  InvalidError,
  type AccountId,
  type JudgeStatusDto,
} from '@10db/contracts';
import {
  findAccountRow,
  getAccountRow,
  getJudgeConfig,
  listJudgeCalls,
  patchJudgeConfig,
} from '@10db/db';
import type { ApiServices } from '../api';
import {
  KeychainError,
  readAccountSecretAsync,
  type AccountSecret,
  type Keychain,
} from '../environment';
import type { StateStore } from '../events';
import type { JudgeService } from '../judge';

/** The judge's side of the HTTP API: its config, the account it runs on, the account test and the call log. */
export type JudgeApiServices = Pick<
  ApiServices,
  'judgeStatus' | 'patchJudge' | 'testAccount' | 'listJudgeCalls'
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
  /** Started with `TENDB_JUDGE=off`: no Keychain item is read, even to say whether it is set. */
  readonly off: boolean;
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
  return {
    judgeStatus: status,
    async patchJudge(patch) {
      deps.state.write((ctx) => patchJudgeConfig(ctx, patch));
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
  };
}
