import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SandboxRuntime } from './srt-launch';
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
export function splitSecrets(
  checkout: string,
  secrets: readonly string[],
  enforced: boolean,
): SecretSplit {
  if (!enforced) return { statVisible: [], closed: secrets };
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
    return isEqualOrUnder(real, checkout) && statSync(real).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether the data-only deny is enforced for this run: only the patched srt's Seatbelt rules do it
 * (on Linux or in an srt without the patch the field is ignored or stripped and the file would
 * read as open), so anywhere else every secret stays closed whole. The patched srt names the field
 * in its schema, in the bundle or beside the dependency's command line.
 */
export function dataDenyEnforced(
  runtime: SandboxRuntime,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'darwin') return false;
  return [runtime.cli, join(dirname(runtime.cli), 'sandbox', 'sandbox-config.js')].some((file) => {
    try {
      return readFileSync(file, 'utf8').includes('denyReadData');
    } catch {
      return false;
    }
  });
}
