import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AccountKind,
  AccountPauseReason,
  AccountProblem,
  AccountSecretInput,
  EventType,
  runsAgents,
  signsInWithLogin,
  ConflictError,
  InvalidError,
  type AccountConfig,
  type AccountConnectDto,
  type AccountConnectingDto,
  type AccountLoginEndedData,
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
import type { AccountLists } from '../catalogue';
import type { Clock } from '../clock';
import {
  AccountLaunchError,
  KeychainError,
  secretFingerprint,
  signInCommandFor,
  type Keychain,
  type Launcher,
} from '../environment';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import {
  AccountLoginError,
  AccountProbeError,
  checkAccount,
  loginIdentity,
  type AccountLogin,
  type SeenAccount,
  type SessionAdapter,
} from '../sessions';
import { capStatus } from './cap';
import { monthOf, monthWindow, usageWindow } from './month';
import type { ListRefresh } from './list-refresh';
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
  /**
   * Starts the browser sign-in of an account that signs in with a login (a Claude subscription or a
   * ChatGPT plan) in the account's own directory, and answers the page to open when the agent names one.
   * One sign-in runs at a time across all accounts, because Codex listens for its callback on a fixed
   * local port; its end arrives as an `account.login_ended` event. The agent writes the login; 10db never
   * reads it.
   */
  connect(id: AccountId): Promise<AccountConnectDto>;
  /**
   * Abandons the account's sign-in if one is waiting, or starting; nothing waiting is not an error. A
   * sign-in still starting is cancelled the moment it has started.
   */
  cancelConnect(id: AccountId): Promise<void>;
  /** The account whose sign-in holds the one slot, or null. */
  connecting(): AccountConnectingDto | null;
  /**
   * Ends a sign-in under way and waits until its process is gone and the end is recorded, then refuses
   * new ones. Called before the database closes.
   */
  stop(): Promise<void>;
  usage(id: AccountId, month: string | null): AccountUsageDto;
  /** Every account paused now, with why, since when and until when. */
  pauses(): AccountPauseDto[];
  /**
   * Lifts a refused or monthly-cap pause, as saving the account unchanged does, and answers the pauses
   * still in force. A usage-limit pause ends by itself, so resuming it is a conflict; so is a monthly-cap
   * pause while spend is still at the cap (raise the cap first).
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
  models: [],
});

/** What a sign-in that the daemon's stopping cut short tells the builder. */
const STOPPED_MESSAGE = '10db stopped before the sign-in finished. Try Connect again.';

/** The one browser sign-in the daemon runs, from the moment it is reserved until its end is recorded. */
interface ConnectSlot {
  readonly accountId: AccountId;
  readonly label: string;
  /** Set once the agent has started the sign-in. */
  login: AccountLogin | null;
  /** Who asked to end it, possibly before `login` was set: the builder, or the daemon stopping. */
  endedBy: 'builder' | 'shutdown' | null;
  /** Settles when the sign-in is over, its process gone and its end recorded. */
  readonly over: Promise<void>;
  finish(): void;
}

export function createAccountService(deps: {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly dataDir: string;
  readonly keychain: Keychain;
  readonly launcher: Pick<Launcher, 'probe'>;
  readonly adapter: Pick<SessionAdapter, 'probeAccount' | 'startLogin'>;
  /** Where the models an account lists are kept, once the account check has passed. */
  readonly lists: AccountLists;
  /** Reads an account's list on its own, as a finished sign-in must: no one need be watching a drawer. */
  readonly listRefresh: Pick<ListRefresh, 'readOne'>;
  readonly logger: Pick<Logger, 'warn'>;
  /**
   * How many lanes run on the account now. A sign-in replaces the login they use, so none may. Plan
   * conversations and identity probes are not counted: the builder is present for the first, and the
   * second is read again at the next start.
   */
  liveLanes(id: AccountId): number;
  readonly startGate: StartGate;
  readonly runtime: Pick<AccountRuntime, 'saved'>;
  readonly pauses: Pick<AccountPauses, 'pausedFor' | 'resume'>;
  /** An account changed: the scheduler looks again. */
  onSaved(): void;
  /** An account was created: the model profiles are rebuilt for it from the catalogue already held. */
  onCreated?(): void;
}): AccountService {
  const db = deps.state.db;
  const root = join(deps.dataDir, 'accounts');
  const saved = (id: AccountId): void => {
    deps.runtime.saved(id);
    deps.onSaved();
  };
  const signInOf = (account: AccountDto): AccountSignInDto | null =>
    signsInWithLogin(account.kind)
      ? { accountId: account.id, configDir: account.configDir, command: signInCommandFor(account) }
      : null;

  /** The one sign-in in progress, or being started, across all accounts. */
  let connecting: ConnectSlot | null = null;
  let stopping = false;

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
          case AccountPauseReason.MonthlyCap: {
            // Lifting it now would only pause the account again at its next start, with a new card.
            const cap = capStatus(db, row, deps.clock.now());
            if (cap && cap.spentUsd >= cap.capUsd)
              throw new ConflictError(
                `Account "${row.label}" has spent $${cap.spentUsd.toFixed(2)} of its $${cap.capUsd.toFixed(2)} monthly cap: raise the cap or wait for next month`,
              );
            deps.pauses.resume(id, { only: held.reason });
            deps.onSaved();
            break;
          }
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
          configDirFor: (id) =>
            join(root, id, input.kind === AccountKind.CodexSignin ? 'codex' : 'claude'),
        });
        // Every created account, keyed kinds too, gets one. Inside the transaction: a directory that
        // can't be made leaves no row behind.
        if (created.configDir !== null) makePrivate(root, created.configDir);
        return created;
      });
      deps.onCreated?.();
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
        throw new InvalidError(
          'Only a Claude subscription or a ChatGPT plan account signs in with a login command',
        );
      return signIn;
    },
    async identity(id) {
      const row = getAccountRow(db, id);
      // Nothing to probe: the account runs no agent, so it has no login or organization to report.
      if (!runsAgents(row.kind))
        throw new InvalidError('OpenRouter accounts have no identity to check');
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
          seen = await deps.adapter.probeAccount({
            kind: row.kind,
            cwd: deps.dataDir,
            env: launch.env,
          });
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
      const refusal = checkAccount(launch.expect, seen);
      if (refusal === null) deps.lists.record({ id: row.id, kind: row.kind }, seen);
      const unconfirmed =
        signsInWithLogin(row.kind) && row.expectedIdentity === null
          ? {
              problem: AccountProblem.Unconfirmed,
              message: `Account "${row.label}" has no confirmed identity yet`,
              seenIdentity: loginIdentity(row.kind, seen) ?? null,
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
        models: (seen.models ?? []).map((m) => m.id),
        refusal: refusal ?? unconfirmed,
      };
    },
    async connect(id) {
      const row = getAccountRow(db, id);
      if (!signsInWithLogin(row.kind))
        throw new InvalidError(`Account "${row.label}" does not sign in with a login`);
      if (row.archived) throw new ConflictError(`Account "${row.label}" is archived`);
      if (stopping) throw new ConflictError('10db is stopping');
      if (connecting !== null)
        throw new ConflictError(
          `Account "${connecting.label}" is already connecting; finish or cancel that sign-in first`,
        );
      // A sign-in replaces the login that sessions on the account run on.
      if (deps.liveLanes(id) > 0)
        throw new ConflictError(
          `Account "${row.label}" has a lane running; wait for it to end before connecting`,
        );
      let launch;
      try {
        launch = deps.launcher.probe(row);
      } catch (error) {
        if (error instanceof KeychainError || error instanceof AccountLaunchError)
          throw new ConflictError(error.message);
        throw error;
      }
      let finish: () => void = () => undefined;
      const over = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const slot: ConnectSlot = {
        accountId: id,
        label: row.label,
        login: null,
        endedBy: null,
        over,
        finish,
      };
      connecting = slot;
      let login: AccountLogin;
      try {
        login = await deps.adapter.startLogin({
          kind: row.kind,
          cwd: deps.dataDir,
          env: launch.env,
        });
      } catch (error) {
        connecting = null;
        slot.finish();
        if (error instanceof AccountLoginError) throw new ConflictError(error.message);
        throw error;
      }
      slot.login = login;
      void login.outcome.then((outcome) => {
        const data: AccountLoginEndedData = {
          accountId: id,
          ok: outcome.ok,
          message: outcome.ok
            ? 'Signed in.'
            : slot.endedBy === 'shutdown'
              ? STOPPED_MESSAGE
              : outcome.message,
          cancelled: slot.endedBy === 'builder',
        };
        try {
          deps.state.write((ctx) => {
            ctx.emit({
              type: EventType.AccountLoginEnded,
              entityType: 'account',
              entityId: id,
              data,
            });
          });
        } catch (error) {
          // The error's text can hold what was being written, so only its kind is kept.
          deps.logger.warn(
            { accountId: id, error: error instanceof Error ? error.name : 'unknown' },
            'could not record the end of a sign-in',
          );
        }
        if (connecting === slot) connecting = null;
        slot.finish();
        // The new login's models are read now; the read never rejects.
        if (outcome.ok) void deps.listRefresh.readOne(id);
        // Work held back while the sign-in ran can start.
        deps.onSaved();
      });
      // A cancel that came while the agent was starting: end it now, and hand back no page to open.
      if (slot.endedBy !== null) {
        await login.cancel();
        return { accountId: id, authUrl: null };
      }
      return { accountId: id, authUrl: login.authUrl };
    },
    async cancelConnect(id) {
      const slot = connecting;
      if (slot?.accountId !== id) return;
      slot.endedBy ??= 'builder';
      await slot.login?.cancel();
    },
    connecting: () =>
      connecting === null ? null : { accountId: connecting.accountId, label: connecting.label },
    async stop() {
      stopping = true;
      const slot = connecting;
      if (slot === null) return;
      slot.endedBy ??= 'shutdown';
      // A sign-in still starting is cancelled by `connect` the moment it has started.
      await slot.login?.cancel();
      await slot.over;
    },
    usage(id, month) {
      getAccountRow(db, id);
      const window = month === null ? monthOf(deps.clock.now()) : monthWindow(month);
      return accountUsage(db, id, usageWindow(window));
    },
  };
}
