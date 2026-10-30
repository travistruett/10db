import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultAccountId, getAccountRow, type DbReader } from '@10db/db';
import type { Launcher } from '../environment';
import type { AreaNamer } from '../folders';
import { CompletionError, type SessionAdapter } from '../sessions';

/** A cheap, quick model: naming and merging a few dozen candidates needs no more. */
const NAMING_MODEL = 'haiku';

export interface AreaNamerDeps {
  readonly adapter: Pick<SessionAdapter, 'complete'>;
  readonly launcher: Pick<Launcher, 'session'>;
  readonly db: DbReader;
  /** Where each question gets its own empty folder to start in. */
  readonly scratchRoot: string;
}

/**
 * Asks the default account's model to name and merge area candidates. The question starts in a new
 * empty folder of 10db's own and carries paths as text: the model gets no tool and no project file,
 * so nothing of the repository is read or run on its behalf.
 */
export function createAreaNamer(deps: AreaNamerDeps): AreaNamer {
  return async (prompt) => {
    const id = defaultAccountId(deps.db);
    if (id === null) throw new CompletionError('There is no default account to ask.');
    const launch = deps.launcher.session(getAccountRow(deps.db, id), NAMING_MODEL);
    const cwd = await mkdtemp(join(deps.scratchRoot, 'areas-'));
    try {
      return await deps.adapter.complete({
        cwd,
        prompt,
        model: launch.model,
        env: launch.env,
        account: launch.expect,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  };
}
