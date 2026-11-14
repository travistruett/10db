import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Decision 2026-11-11-10db-runs-the-preview-while-a-pass-is-open: the token 10db's own dev UI reads
// with is kept in the data directory, which no lane or gate can read, so it outlives a restart and
// a dev UI tab Open Page handed it keeps working after one.

const FILE = 'dev-ui-token';
/** Shorter than this is no token 10db made. */
const MIN_LENGTH = 32;

/** The dev UI's read-only token: the one kept in `dataDir`, or a new one kept there (0600). */
export function devUiToken(dataDir: string): string {
  const path = join(dataDir, FILE);
  try {
    const kept = readFileSync(path, 'utf8').trim();
    if (kept.length >= MIN_LENGTH) return kept;
  } catch {
    // None kept yet.
  }
  const token = randomBytes(32).toString('base64url');
  const tmp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, token, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return token;
}
