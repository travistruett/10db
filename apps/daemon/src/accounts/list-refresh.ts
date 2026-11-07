import { SUPPORTED_ACCOUNT_KINDS } from '@10db/contracts';
import { getAccountRow, listAccounts } from '@10db/db';
import type { AccountLists } from '../catalogue';
import type { Launcher } from '../environment';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import { checkAccount, type SessionAdapter } from '../sessions';
import type { StartGate } from './start-gate';

export interface ListRefresh {
  /**
   * Reads every account's list again through the identity probe: no prompt and no tokens. An account whose
   * probe fails, or whose check does not pass, keeps its last list, and the others are still read. Never rejects.
   */
  readAll(): Promise<void>;
}

export function createListRefresh(deps: {
  readonly state: StateStore;
  readonly adapter: Pick<SessionAdapter, 'probeAccount'>;
  readonly launcher: Pick<Launcher, 'probe'>;
  readonly startGate: StartGate;
  readonly lists: AccountLists;
  readonly dataDir: string;
  readonly logger: Pick<Logger, 'warn'>;
}): ListRefresh {
  const db = deps.state.db;

  async function readOne(id: ReturnType<typeof listAccounts>[number]['id']): Promise<void> {
    const row = getAccountRow(db, id);
    const launch = deps.launcher.probe(row);
    const release = await deps.startGate.acquire(id);
    let seen;
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

  return {
    async readAll() {
      for (const account of listAccounts(db)) {
        if (!SUPPORTED_ACCOUNT_KINDS.some((kind) => kind === account.kind)) continue;
        try {
          await readOne(account.id);
        } catch (error) {
          // A missing secret, a locked Keychain or a probe that timed out says nothing about the list.
          deps.logger.warn(
            { accountId: account.id, err: error instanceof Error ? error.name : 'error' },
            'could not read the models an account lists; keeping its last list',
          );
        }
      }
    },
  };
}
