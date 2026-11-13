import {
  agentKind,
  ACCOUNT_CARD_DETAIL,
  AccountCardDetail,
  AccountCardChoice,
  AccountProblem,
  ConflictError,
  InboxState,
  signsInWithLogin,
  type AccountId,
  type InboxItemId,
  type ProjectId,
} from '@10db/contracts';
import {
  defaultAccountId,
  getAccountRow,
  listInbox,
  patchAccount,
  type AccountRow,
} from '@10db/db';
import type { AccountLists } from '../catalogue';
import type { Clock } from '../clock';
import type { Launcher } from '../environment';
import type { StateStore } from '../events';
import type { InboxService } from '../inbox';
import type { Logger } from '../log';
import { checkAccount, loginIdentity, type AgentAdapter, type SeenAccount } from '../sessions';
import {
  confirmCard,
  credentialsCard,
  fixFor,
  recordedCard,
  secretCard,
  signInCard,
  type AccountCard,
} from './cards';
import { unready } from './readiness';
import { closeNoLoginCards, closeSettledCards } from './stale-cards';
import type { StartGate } from './start-gate';

/** How long an unready account waits before it is probed again. */
export const PREPARE_RETRY_MS = 60_000;

export interface AccountPreparer {
  /** Works toward making an unready account ready: at most one probe a minute, and one card per problem. */
  prepare(account: AccountRow, projectId: ProjectId): void;
  /**
   * The builder answered Check again (or Record again, with `forgetIdentity`) on a card that waits for a fix:
   * probes now, whatever the last probe's time. An account that is ready closes the cards that asked and asks for
   * a tick; a secret still missing throws, so the card stays open and says what is missing. `answering` is
   * the card being answered, which the inbox closes itself.
   */
  retry(
    account: AccountRow,
    projectId: ProjectId,
    answering: InboxItemId,
    opts?: { readonly forgetIdentity?: boolean },
  ): void;
  /** Settles once every probe started so far has finished (tests). */
  idle(): Promise<void>;
}

export function createAccountPreparer(opts: {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly inbox: InboxService;
  readonly adapter: Pick<AgentAdapter, 'probeAccount'>;
  /** Where the models an account lists are kept, once the account check has passed. */
  readonly lists: AccountLists;
  readonly launcher: Pick<Launcher, 'probe'>;
  readonly startGate: StartGate;
  readonly dataDir: string;
  readonly logger: Logger;
  /** An account became ready: the scheduler looks again. */
  onReady(): void;
}): AccountPreparer {
  const running = new Map<AccountId, Promise<void>>();
  const lastTried = new Map<AccountId, number>();

  const raise = (projectId: ProjectId, card: AccountCard): void => {
    opts.inbox.flag({
      projectId,
      workstreamId: null,
      title: card.title,
      body: card.body,
      detail: card.detail,
      foldKey: card.foldKey,
      ...(card.options ? { options: card.options } : {}),
    });
  };

  async function confirmIdentity(account: AccountRow, projectId: ProjectId): Promise<void> {
    const kind = agentKind(account.kind);
    let seen: SeenAccount;
    try {
      const release = await opts.startGate.acquire(account.id);
      try {
        seen = await opts.adapter.probeAccount({
          kind,
          cwd: opts.dataDir,
          env: opts.launcher.probe(account).env,
        });
      } finally {
        release();
      }
    } catch (error) {
      // Probe errors name a timeout or a missing claude, never a credential. A signed-out directory
      // may answer nothing at all, so the card carries the sign-in command either way.
      raise(projectId, signInCard(account, error instanceof Error ? error.message : String(error)));
      return;
    }
    // No identity is confirmed yet, so the check compares none: it tells a signed-out directory from
    // credentials a login can't fix (Bedrock settings, an apiKeyHelper, a Console login).
    const refusal = checkAccount(opts.launcher.probe(account).expect, seen);
    if (refusal?.problem === AccountProblem.SignedOut) {
      raise(projectId, signInCard(account));
      return;
    }
    if (refusal) {
      raise(projectId, credentialsCard(account, refusal));
      return;
    }
    if (!seen.email) {
      raise(projectId, signInCard(account));
      return;
    }
    opts.lists.record({ id: account.id, kind }, seen);
    if (defaultAccountId(opts.state.db) === account.id) {
      // The default account's directory holds the builder's current login (accounts spec §3); the card names it.
      const email = seen.email;
      opts.state.write((ctx) => patchAccount(ctx, account.id, { expectedIdentity: email }));
      opts.logger.info({ accountId: account.id }, 'recorded the default account identity');
      closeSettledCards(opts.state, account.id);
      raise(projectId, recordedCard(account, email));
      opts.onReady();
      return;
    }
    closeNoLoginCards(opts.state, account.id);
    raise(projectId, confirmCard(account, loginIdentity(kind, seen) ?? seen.email));
  }

  /** The account's Confirm cards in the given states, from every project. */
  const confirmCards = (account: AccountRow, states: readonly InboxState[]) =>
    listInbox(opts.state.db, { states }).filter((item) => {
      const card = AccountCardDetail.safeParse(item.detail?.[ACCOUNT_CARD_DETAIL]);
      return (
        card.success &&
        card.data.accountId === account.id &&
        card.data.reason === null &&
        card.data.problem === AccountProblem.Unconfirmed
      );
    });

  function confirmPending(account: AccountRow): boolean {
    if (confirmCards(account, [InboxState.Open]).length > 0) return true;
    return confirmCards(account, [InboxState.Resolved, InboxState.Answered]).some(
      (item) =>
        item.answer?.choice === AccountCardChoice.Later && item.updatedAt >= account.updatedAt,
    );
  }

  /** Starts the identity probe unless one is already running for the account. */
  function probe(account: AccountRow, projectId: ProjectId): void {
    if (running.has(account.id)) return;
    const job = confirmIdentity(account, projectId)
      .catch((error: unknown) => {
        opts.logger.error(
          { accountId: account.id, err: String(error) },
          'preparing the account failed',
        );
      })
      .finally(() => running.delete(account.id));
    running.set(account.id, job);
  }

  return {
    prepare(account, projectId) {
      const problem = unready(account);
      if (!problem || running.has(account.id)) return;
      // A Confirm card already waits on the builder, in this project or another: probing again would
      // only raise it again. One the builder put off with Later stays quiet until the account is saved.
      if (confirmPending(account)) return;
      const now = opts.clock.now().getTime();
      const last = lastTried.get(account.id);
      if (last !== undefined && now - last < PREPARE_RETRY_MS) return;
      lastTried.set(account.id, now);
      if (problem.problem !== AccountProblem.Unconfirmed || !signsInWithLogin(account.kind)) {
        raise(projectId, secretCard(account));
        return;
      }
      probe(account, projectId);
    },
    retry(account, projectId, answering, { forgetIdentity = false } = {}) {
      let current = account;
      if (forgetIdentity) {
        opts.state.write((ctx) => patchAccount(ctx, account.id, { expectedIdentity: null }));
        current = getAccountRow(opts.state.db, account.id);
      }
      const problem = unready(current);
      if (!problem) {
        // Fixed since the card was raised: the cards that asked for it are stale, and work can run.
        closeSettledCards(opts.state, current.id, answering);
        opts.onReady();
        return;
      }
      if (problem.problem !== AccountProblem.Unconfirmed || !signsInWithLogin(current.kind))
        throw new ConflictError(`${problem.message}. ${fixFor(current, problem.problem)}`);
      // The builder asked, so the minute between probes does not apply.
      lastTried.set(current.id, opts.clock.now().getTime());
      probe(current, projectId);
    },
    idle: async () => {
      await Promise.all([...running.values()]);
    },
  };
}
