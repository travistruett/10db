import {
  AccountKind,
  ConflictError,
  EventType,
  McpSignInState,
  NotFoundError,
  type AccountId,
  type McpSignInChangedData,
  type McpSignInRowDto,
  type McpSignInsDto,
  type StartMcpSignIn,
  type YourMcpServerKey,
} from '@10db/contracts';
import { findAccountRow, listAccounts } from '@10db/db';
import type { Clock } from '../clock';
import { AccountLaunchError, claudeMcpSignInCommand, type Launcher } from '../environment';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import type { YourMcpPlan } from '../session-setup';
import {
  McpAuthState,
  McpSignInError,
  type AgentAdapter,
  type McpSignIn,
  type YourSessionServer,
} from '../sessions';

/** How long one account's status read has to answer before its rows read as unknown. */
export const SIGN_IN_STATUS_MS = 15_000;
/** How long a status read is reused; a sign-in that ends drops it at once. */
export const SIGN_IN_STATUS_TTL_MS = 60_000;

const UNREADABLE = "Couldn't read whether it's signed in.";

/** A server of the builder's that may sign in with OAuth: remote, approved, and sending no headers. */
export interface SignInCandidate {
  readonly key: YourMcpServerKey;
  readonly name: string;
  readonly server: YourSessionServer;
}

/** The planned servers a sign-in can matter for: remote ones that send no headers, in plan order. */
export function signInCandidates(plan: Pick<YourMcpPlan, 'remote'>): SignInCandidate[] {
  return Object.entries(plan.remote).flatMap(([name, remote]) =>
    remote.headers === null
      ? [
          {
            key: remote.key,
            name,
            server: {
              connect: { type: remote.type, url: remote.url, headers: null },
              claudeOAuth: remote.oauth,
              codex: remote.codex,
            },
          },
        ]
      : [],
  );
}

export interface McpSignIns {
  /** Every Codex account's state for every candidate, and the terminal command of each own-folder plan account. */
  list(): Promise<McpSignInsDto>;
  /** Starts the sign-in, or opens its page again when one is under way; throws NotFoundError or ConflictError. */
  start(input: StartMcpSignIn): Promise<McpSignInsDto>;
  /** Cancels every sign-in under way, as the daemon shuts down. */
  stopAll(): Promise<void>;
}

type Read =
  | { readonly kind: 'read'; readonly states: Readonly<Record<string, McpAuthState>> }
  | { readonly kind: 'unreadable'; readonly message: string };

interface Slot {
  readonly accountId: AccountId;
  readonly key: YourMcpServerKey;
  state: typeof McpSignInState.SigningIn | typeof McpSignInState.Failed;
  message: string | null;
  handle: McpSignIn | null;
}

export function createMcpSignIns(deps: {
  readonly state: StateStore;
  readonly adapter: Pick<AgentAdapter, 'startMcpSignIn' | 'mcpAuthStatus'>;
  readonly launcher: Pick<Launcher, 'probe'>;
  readonly clock: Clock;
  /** The builder's servers as a session on the app's switches would get them. */
  readonly plan: () => YourMcpPlan;
  readonly logger: Pick<Logger, 'warn'>;
}): McpSignIns {
  const db = deps.state.db;
  /** Sign-ins under way or failed since this daemon started; never stored. */
  const slots = new Map<string, Slot>();
  const slotKey = (accountId: AccountId, key: YourMcpServerKey): string => `${accountId}:${key}`;
  const cache = new Map<AccountId, { readonly at: number; readonly read: Read }>();
  const inFlight = new Map<AccountId, Promise<Read>>();

  const emit = (accountId: AccountId, key: YourMcpServerKey, state: McpSignInState): void => {
    const data: McpSignInChangedData = { accountId, key, state };
    deps.state.write((ctx) => {
      ctx.emit({
        type: EventType.McpSignInChanged,
        entityType: 'mcp_sign_in',
        entityId: accountId,
        data,
      });
    });
  };

  const readStatus = async (
    accountId: AccountId,
    candidates: readonly SignInCandidate[],
  ): Promise<Read> => {
    const row = findAccountRow(db, accountId);
    if (row === undefined) return { kind: 'unreadable', message: UNREADABLE };
    let env: Readonly<Record<string, string>>;
    try {
      env = deps.launcher.probe(row).env;
    } catch (error) {
      if (error instanceof AccountLaunchError)
        return { kind: 'unreadable', message: error.message };
      throw error;
    }
    let timer: { cancel(): void } = { cancel: () => undefined };
    const deadline = new Promise<Read>((resolve) => {
      timer = deps.clock.setTimeout(() => {
        resolve({ kind: 'unreadable', message: UNREADABLE });
      }, SIGN_IN_STATUS_MS);
    });
    const read = deps.adapter
      .mcpAuthStatus({
        kind: AccountKind.CodexSignin,
        env,
        servers: Object.fromEntries(candidates.map((c) => [c.name, c.server])),
      })
      .then(
        (states): Read => ({ kind: 'read', states }),
        (error: unknown): Read => {
          deps.logger.warn(
            { errName: error instanceof Error ? error.name : 'unknown', accountId },
            'an account’s mcp sign-in status could not be read',
          );
          return {
            kind: 'unreadable',
            message: error instanceof McpSignInError ? error.message : UNREADABLE,
          };
        },
      );
    try {
      return await Promise.race([read, deadline]);
    } finally {
      timer.cancel();
    }
  };

  const statusOf = (
    accountId: AccountId,
    candidates: readonly SignInCandidate[],
  ): Promise<Read> => {
    const now = deps.clock.now().getTime();
    const cached = cache.get(accountId);
    if (cached !== undefined && now - cached.at < SIGN_IN_STATUS_TTL_MS)
      return Promise.resolve(cached.read);
    const running = inFlight.get(accountId);
    if (running !== undefined) return running;
    const started = readStatus(accountId, candidates)
      .then((read) => {
        // A failure is not kept: the next look asks again.
        if (read.kind === 'read') cache.set(accountId, { at: now, read });
        return read;
      })
      .finally(() => {
        inFlight.delete(accountId);
      });
    inFlight.set(accountId, started);
    return started;
  };

  const rowsFor = (
    account: { readonly id: AccountId; readonly label: string },
    candidates: readonly SignInCandidate[],
    read: Read,
  ): McpSignInRowDto[] =>
    candidates.flatMap((candidate): McpSignInRowDto[] => {
      const base = {
        accountId: account.id,
        accountLabel: account.label,
        key: candidate.key,
        name: candidate.name,
      };
      const slot = slots.get(slotKey(account.id, candidate.key));
      if (slot !== undefined) return [{ ...base, state: slot.state, message: slot.message }];
      if (read.kind === 'unreadable')
        return [{ ...base, state: McpSignInState.Unknown, message: read.message }];
      const state = read.states[candidate.name];
      if (state === McpAuthState.SignedIn)
        return [{ ...base, state: McpSignInState.SignedIn, message: null }];
      if (state === McpAuthState.NotSignedIn)
        return [{ ...base, state: McpSignInState.NotSignedIn, message: null }];
      // A server that doesn't sign in with OAuth has nothing to show.
      if (state === McpAuthState.NotOAuth) return [];
      return [{ ...base, state: McpSignInState.Unknown, message: UNREADABLE }];
    });

  const list = async (): Promise<McpSignInsDto> => {
    const candidates = signInCandidates(deps.plan());
    if (candidates.length === 0) return { rows: [], terminal: [] };
    const accounts = listAccounts(db);
    const codex = accounts.filter((account) => account.kind === AccountKind.CodexSignin);
    const reads = await Promise.all(codex.map((account) => statusOf(account.id, candidates)));
    return {
      rows: codex.flatMap((account, index) => {
        const read = reads[index];
        return read === undefined ? [] : rowsFor(account, candidates, read);
      }),
      terminal: accounts.flatMap((account) =>
        account.kind === AccountKind.ClaudeSubscription && account.configDir !== null
          ? [
              {
                accountId: account.id,
                accountLabel: account.label,
                command: claudeMcpSignInCommand(account.configDir),
              },
            ]
          : [],
      ),
    };
  };

  /** A sign-in ended: it is signed in, or the slot keeps why not until the builder tries again. */
  const ended = (
    accountId: AccountId,
    key: YourMcpServerKey,
    slot: Slot,
    outcome: { readonly ok: true } | { readonly ok: false; readonly message: string },
  ): void => {
    const id = slotKey(accountId, key);
    // A slot stopped or replaced meanwhile has said its piece.
    if (slots.get(id) !== slot) return;
    cache.delete(accountId);
    if (outcome.ok) {
      slots.delete(id);
      emit(accountId, key, McpSignInState.SignedIn);
      return;
    }
    slot.state = McpSignInState.Failed;
    slot.message = outcome.message;
    slot.handle = null;
    emit(accountId, key, McpSignInState.Failed);
  };

  const start = async (input: StartMcpSignIn): Promise<McpSignInsDto> => {
    const account = findAccountRow(db, input.accountId);
    if (account === undefined || account.archived)
      throw new NotFoundError('account', input.accountId);
    const candidate = signInCandidates(deps.plan()).find((c) => c.key === input.key);
    if (candidate === undefined) throw new NotFoundError('mcp server', input.key);
    if (account.kind !== AccountKind.CodexSignin)
      throw new ConflictError(
        'Only a Codex account signs in to a server here. Sign a Claude account in with its own Claude Code.',
      );
    const env = deps.launcher.probe(account).env;
    if (env['CODEX_HOME'] === undefined || env['CODEX_HOME'] === '')
      throw new ConflictError('This account has no Codex folder to keep a sign-in in.');
    const id = slotKey(account.id, candidate.key);
    const under = slots.get(id);
    if (under?.state === McpSignInState.SigningIn) {
      // The page was opened already: open it again. A start still in progress has no page yet.
      await under.handle?.reopen().catch(() => undefined);
      return list();
    }
    const slot: Slot = {
      accountId: account.id,
      key: candidate.key,
      state: McpSignInState.SigningIn,
      message: null,
      handle: null,
    };
    slots.set(id, slot);
    emit(account.id, candidate.key, McpSignInState.SigningIn);
    try {
      const handle = await deps.adapter.startMcpSignIn({
        kind: AccountKind.CodexSignin,
        env,
        name: candidate.name,
        server: candidate.server,
      });
      if (slots.get(id) !== slot) {
        // The daemon is stopping: nothing is left waiting on the browser.
        await handle.cancel();
        return await list();
      }
      slot.handle = handle;
      void handle.outcome.then((outcome) => {
        ended(account.id, candidate.key, slot, outcome);
      });
    } catch (error) {
      ended(account.id, candidate.key, slot, {
        ok: false,
        message:
          error instanceof McpSignInError
            ? error.message
            : 'The sign-in did not start. Try Sign in again.',
      });
    }
    return list();
  };

  return {
    list,
    start,
    async stopAll() {
      const stopping = [...slots.values()];
      slots.clear();
      cache.clear();
      for (const slot of stopping) {
        await slot.handle?.cancel();
        emit(slot.accountId, slot.key, McpSignInState.NotSignedIn);
      }
    },
  };
}
