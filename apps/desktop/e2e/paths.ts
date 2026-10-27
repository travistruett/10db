import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const DESKTOP_DIR = resolve(import.meta.dirname, '..');
/**
 * Recreated by prepare.ts on every run, in the temp dir and named for this checkout, so checkouts
 * running their gates at once each have their own. Never inside the checkout: a sandboxed gate can't
 * write a repository's `.git/config` or `.git/hooks` there.
 */
export const E2E_DIR = join(
  tmpdir(),
  `10db-e2e-${createHash('sha256').update(DESKTOP_DIR).digest('hex').slice(0, 12)}`,
);
export const E2E_REPO = resolve(E2E_DIR, 'repo');
export const E2E_DATA = resolve(E2E_DIR, 'data');
/** A fixed UI token so the Vite app and the daemon agree; dev and E2E only. */
export const E2E_TOKEN = 'e2e-ui-token-0123456789abcdefghijklmnopqrst';
export const DEFAULT_BOOK = resolve(import.meta.dirname, 'script-book.json');
