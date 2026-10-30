import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the installed app keeps all its state (spec §12). */
export function defaultDataDir(): string {
  return join(homedir(), 'Library', 'Application Support', '10db');
}
