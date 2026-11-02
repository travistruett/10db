import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AccountKind,
  AccountPauseReason,
  AccountProblem,
  AccountSecretInput,
  ConflictError,
  InvalidError,
  type AccountConfig,
  type AccountCreatedDto,
  type AccountDto,
  type AccountId,
  type AccountIdentityDto,
  type AccountPatch,
  type AccountPauseDto,
  type AccountSignInDto,
  type AccountUsageDto,
} from '@10db/contracts';
import {
  accountUsage,
  archiveAccount,
  getAccount,
  getAccountRow,
  insertAccount,
  listAccounts,
  patchAccount,
  recordAccountSecret,
} from '@10db/db';
import type { Clock } from '../clock';
import {
  AccountLaunchError,
  KeychainError,
  secretFingerprint,
  signInCommand,
  type Keychain,
  type Launcher,
} from '../environment';
import type { StateStore } from '../events';
import {
  AccountProbeError,
  checkAccount,
  type SeenAccount,
  type SessionAdapter,
} from '../sessions';
import { monthOf, monthWindow, usageWindow } from './month';
import type { AccountPauses } from './pauses';
import type { AccountRuntime } from './runtime';
import type { StartGate } from './start-gate';

export interface AccountService {
  list(): AccountDto[];
  create(input: AccountConfig): AccountCreatedDto;
  patch(id: AccountId, patch: AccountPatch): AccountDto;
  archive(id: AccountId): AccountDto;
  setSecret(id: AccountId, input: AccountSecretInput): AccountDto;
  signIn(id: AccountId): AccountSignInDto;
  identity(id: AccountId): Promise<AccountIdentityDto>;
  usage(id: AccountId, month: string | null): AccountUsageDto;
  /** Every account paused now, with why, since when and until when. */
  pauses(): AccountPauseDto[];
  /**
   * Lifts a refused or monthly-cap pause, as saving the account unchanged does, and answers the pauses
   * still in force. A usage-limit pause ends by itself, so resuming it is a conflict.
   */
  resume(id: AccountId): AccountPauseDto[];
}

/** The directory and every level 10db made above it: readable by the builder only (accounts spec §4). */
function makePrivate(root: string, dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode passes through the umask, so each level is set explicitly.
  for (const path of [root, dirname(dir), dir]) chmodSync(path, 0o700);
}

const nothingSeen = (id: AccountId): Omit<AccountIdentityDto, 'refusal'> => ({
  accountId: id,
  email: null,
  organization: null,
  apiProvider: null,
  apiKeySource: null,
  tokenSource: null,
  subscription: false,
});

export function createAccountService(deps: {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly dataDir: string;
  readonly keychain: Keychain;
  readonly launcher: Pick<Launcher, 'probe'>;
  readonly adapter: Pick<SessionAdapter, 'probeAccount'>;
  readonly startGate: StartGate;
  readonly runtime: Pick<AccountRuntime, 'saved'>;
  readonly pauses: Pick<AccountPauses, 'pausedFor' | 'resume'>;
  /** An account changed: the scheduler looks again. */
  onSaved(): void;
}): AccountService {
  const db = deps.state.db;
  const root = join(deps.dataDir, 'accounts');
  const saved = (id: AccountId): void => {
    deps.runtime.saved(id);
    deps.onSaved();
  };
  const signInOf = (account: AccountDto): AccountSignInDto | null =>
    account.kind === AccountKind.ClaudeSubscription
      ? {
          accountId: account.id,
          configDir: account.configDir,
          command: signInCommand(account.configDir),
        }
      : null;

  const pauses = (): AccountPauseDto[] =>
    listAccounts(db, { includeArchived: true }).flatMap((account) => {
      const held = deps.pauses.pausedFor(account.id);
      return held
        ? [
            {
              accountId: account.id,
              reason: held.reason,
              since: held.since.toISOString(),
              until: held.until?.toISOString() ?? null,
            },
          ]
        : [];
    });

  return {
    list: () => listAccounts(db, { includeArchived: true }),
    pauses,
    resume(id) {
      const row = getAccountRow(db, id);
      const held = deps.pauses.pausedFor(id);
      if (held) {
        switch (held.reason) {
          case AccountPauseReason.UsageLimit:
            throw new ConflictError(
              `Account "${row.label}" is paused by its usage limit, which ends by itself`,
            );
          case AccountPauseReason.MonthlyCap:
          case AccountPauseReason.Refused:
            deps.pauses.resume(id, { only: held.reason });
            deps.onSaved();
            break;
        }
      }
      return pauses();
    },
    create(input) {
      const account = deps.state.write((ctx) => {
        const created = insertAccount(ctx, input, {
          configDirFor: (id) => join(root, id, 'claude'),
        });
        // Every created account, keyed kinds too, gets one. Inside the transaction: a directory that
        // can't be made leaves no row behind.
        if (created.configDir !== null) makePrivate(root, created.configDir);
        return created;
      });
      return { account, signIn: signInOf(account) };
    },
    patch(id, patch) {
      const account = deps.state.write((ctx) => patchAccount(ctx, id, patch));
      saved(id);
      return account;
    },
    archive: (id) => deps.state.write((ctx) => archiveAccount(ctx, id)),
    setSecret(id, input) {
      const { secret } = AccountSecretInput.parse(input);
      const row = getAccountRow(db, id);
      if (row.archived) throw new ConflictError(`Account "${row.label}" is archived`);
      if (row.secretRef === null) throw new InvalidError(`Account "${row.label}" takes no secret`);
      try {
        deps.keychain.write(row.secretRef, secret);
      } catch (error) {
        // Keychain messages name the item and the status, never the value.
        if (error instanceof KeychainError) throw new ConflictError(error.message);
        throw error;
      }
      const account = deps.state.write((ctx) =>
        recordAccountSecret(ctx, id, secretFingerprint(secret)),
      );
      saved(id);
      return account;
    },
    signIn(id) {
      const signIn = signInOf(getAccount(db, id));
      if (!signIn)
        throw new InvalidError('Only a Claude subscription account signs in with claude /login');
      return signIn;
    },
    async identity(id) {
      const row = getAccountRow(db, id);
      let launch;
      try {
        launch = deps.launcher.probe(row);
      } catch (error) {
        // A locked Keychain is a conflict the builder can fix, as it is when saving a secret.
        if (error instanceof KeychainError) throw new ConflictError(error.message);
        if (!(error instanceof AccountLaunchError)) throw error;
        return {
          ...nothingSeen(id),
          refusal: { problem: error.problem, message: error.message, seenIdentity: null },
        };
      }
      let seen: SeenAccount;
      try {
        const release =
          row.kind === AccountKind.ClaudeSubscription
            ? await deps.startGate.acquire(id)
            : () => undefined;
        try {
          seen = await deps.adapter.probeAccount({ cwd: deps.dataDir, env: launch.env });
        } finally {
          release();
        }
      } catch (error) {
        // Only a probe that reported nothing is a conflict; anything else is a bug and reaches the log.
        if (!(error instanceof AccountProbeError)) throw error;
        throw new ConflictError(
          `Couldn't read the account ${row.label}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const unconfirmed =
        row.kind === AccountKind.ClaudeSubscription && row.expectedIdentity === null
          ? {
              problem: AccountProblem.Unconfirmed,
              message: `Account "${row.label}" has no confirmed identity yet`,
              seenIdentity: seen.email ?? null,
            }
          : null;
      return {
        accountId: id,
        email: seen.email ?? null,
        organization: seen.organization ?? null,
        apiProvider: seen.apiProvider ?? null,
        apiKeySource: seen.apiKeySource ?? null,
        tokenSource: seen.tokenSource ?? null,
        subscription: Boolean(seen.subscriptionType),
        refusal: checkAccount(launch.expect, seen) ?? unconfirmed,
      };
    },
    usage(id, month) {
      getAccountRow(db, id);
      const window = month === null ? monthOf(deps.clock.now()) : monthWindow(month);
      return accountUsage(db, id, usageWindow(window));
    },
  };
}
