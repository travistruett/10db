import { resolve } from 'node:path';

export const DESKTOP_DIR = resolve(import.meta.dirname, '..');
/** Recreated by prepare.ts on every run; gitignored. */
export const E2E_DIR = resolve(DESKTOP_DIR, '.e2e');
export const E2E_REPO = resolve(E2E_DIR, 'repo');
export const E2E_DATA = resolve(E2E_DIR, 'data');
export const E2E_DAEMON_PORT = 4318;
export const E2E_UI_PORT = 1420;
/** A fixed UI token so the Vite app and the daemon agree; dev and E2E only. */
export const E2E_TOKEN = 'e2e-ui-token-0123456789abcdefghijklmnopqrst';
export const DEFAULT_BOOK = resolve(import.meta.dirname, 'script-book.json');
