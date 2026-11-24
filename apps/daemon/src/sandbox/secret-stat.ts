import { realpathSync, statSync } from 'node:fs';
import { isEqualOrUnder } from './protected-reads';

/** The checkout's `.env*` paths a sandbox answers a stat for, and the ones it closes whole. */
export interface SecretSplit {
  /** Regular files inside the checkout, and links to them: contents closed, existence and size open. */
  readonly statVisible: readonly string[];
  /** Everything else: folders and paths leading outside the checkout, closed down to a stat. */
  readonly closed: readonly string[];
}

/**
 * A secret's contents are the hard limit, its existence is not: `make` stats a `.env` it lists as a
 * prerequisite, and Claude Code lets a command do the same. A regular file inside the checkout, or a
 * link that leads to one, keeps its contents closed but answers a stat; a folder, or a path that
 * leads outside the checkout, stays shut down to its metadata, since a listing or a name outside
 * is more than the existence of a file the builder put there.
 */
export function splitSecrets(checkout: string, secrets: readonly string[]): SecretSplit {
  const statVisible: string[] = [];
  const closed: string[] = [];
  for (const secret of secrets) {
    (isRegularFileIn(checkout, secret) ? statVisible : closed).push(secret);
  }
  return { statVisible, closed };
}

/** Whether `path`, followed through any link, is a regular file under the checkout's real path. */
function isRegularFileIn(checkout: string, path: string): boolean {
  try {
    const real = realpathSync(path);
    return real !== checkout && isEqualOrUnder(real, checkout) && statSync(real).isFile();
  } catch {
    return false;
  }
}
