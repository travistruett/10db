import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { devUiToken } from './dev-ui-token';

// Decision 2026-11-11-10db-runs-the-preview-while-a-pass-is-open: the dev UI's read-only token
// outlives a daemon restart, so a tab Open Page handed it once keeps working after an update.

let dir: TempDir;
afterEach(() => {
  dir.cleanup();
});

describe('devUiToken', () => {
  it('is made once, 0600, and the same at the next start', () => {
    dir = tempDir('dev-ui-token');
    const first = devUiToken(dir.path);
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(statSync(join(dir.path, 'dev-ui-token')).mode & 0o777).toBe(0o600);
    expect(devUiToken(dir.path)).toBe(first);
  });

  it('makes a new one when the file holds nothing usable', () => {
    dir = tempDir('dev-ui-token');
    writeFileSync(join(dir.path, 'dev-ui-token'), '  \n', { mode: 0o600 });
    expect(devUiToken(dir.path).length).toBeGreaterThanOrEqual(32);
  });
});
