import { SUPPORTED_ACCOUNT_KINDS, type AccountId } from '@10db/contracts';
import { getAccountRow, listAccountModels, listAccounts } from '@10db/db';
import type { AccountLists } from '../catalogue';
import type { Clock } from '../clock';
import type { Launcher } from '../environment';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import { checkAccount, type SeenAccount, type SessionAdapter } from '../sessions';
import type { StartGate } from './start-gate';

/** A list read within this long is fresh enough that a session start does not read it again. */
export const LIST_FRESH_MS = 24 * 60 * 60 * 1000;

export interface ListRefresh {
  /**
   * Reads accounts' lists again through the identity probe: no prompt and no tokens. An account whose probe
   * fails, or whose check does not pass, keeps its last list, and the others are still read. With `staleOnly`
   * an account read within the last day is skipped. Never rejects.
   */
  readAll(opts?: { readonly staleOnly?: boolean }): Promise<void>;
  /** Reads one account's list now; a read already running for it is joined. Never rejects. */
  readOne(id: AccountId): Promise<void>;
  /** Reads one account's list unless it was read within the last day. Never rejects. */
  readIfStale(id: AccountId): Promise<void>;
  /** No further account is read; one already being read finishes. */
  stop(): void;
}

export function createListRefresh(deps: {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly adapter: Pick<SessionAdapter, 'probeAccount'>;
  readonly launcher: Pick<Launcher, 'probe'>;
  readonly startGate: StartGate;
  readonly lists: AccountLists;
  readonly dataDir: string;
  readonly logger: Pick<Logger, 'warn'>;
}): ListRefresh {
  const db = deps.state.db;
  const running = new Map<AccountId, Promise<void>>();
  /** When each account was last read, listed or not: an account that lists nothing stores no rows to date it by. */
  const tried = new Map<AccountId, number>();
  let stopped = false;

  /** Whether the account was read, or its newest stored row dated, within the last day. */
  function stale(id: AccountId): boolean {
    const stored = Math.max(...listAccountModels(db, id).map((m) => Date.parse(m.lastSeenAt)));
    const newest = Math.max(
      Number.isFinite(stored) ? stored : -Infinity,
      tried.get(id) ?? -Infinity,
    );
    return !Number.isFinite(newest) || deps.clock.now().getTime() - newest >= LIST_FRESH_MS;
  }

  async function probeAndRecord(id: AccountId): Promise<void> {
    const row = getAccountRow(db, id);
    const launch = deps.launcher.probe(row);
    const release = await deps.startGate.acquire(id);
    let seen: SeenAccount;
    try {
      seen = await deps.adapter.probeAccount({
        kind: row.kind,
        cwd: deps.dataDir,
        env: launch.env,
      });
    } finally {
      release();
    }
    if (checkAccount(launch.expect, seen) === null) deps.lists.record(row, seen);
  }

  function readOne(id: AccountId): Promise<void> {
    const held = running.get(id);
    if (held) return held;
    tried.set(id, deps.clock.now().getTime());
    const job = probeAndRecord(id)
      .catch((error: unknown) => {
        // A missing secret, a locked Keychain or a probe that timed out says nothing about the list.
        deps.logger.warn(
          { accountId: id, err: error instanceof Error ? error.name : 'error' },
          'could not read the models an account lists; keeping its last list',
        );
      })
      .finally(() => running.delete(id));
    running.set(id, job);
    return job;
  }

  return {
    async readAll({ staleOnly = false } = {}) {
      for (const account of listAccounts(db)) {
        if (stopped) return;
        if (!SUPPORTED_ACCOUNT_KINDS.some((kind) => kind === account.kind)) continue;
        if (staleOnly && !stale(account.id)) continue;
        await readOne(account.id);
      }
    },
    readOne(id) {
      return stopped ? Promise.resolve() : readOne(id);
    },
    readIfStale(id) {
      return stopped || !stale(id) ? Promise.resolve() : readOne(id);
    },
    stop() {
      stopped = true;
    },
  };
}
