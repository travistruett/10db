import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitSecrets } from './secret-stat';

describe('splitSecrets', () => {
  it('opens a stat only where the data-only deny is enforced', () => {
    const checkout = realpathSync(mkdtempSync(join(tmpdir(), 'secret-stat-')));
    try {
      const env = join(checkout, '.env');
      writeFileSync(env, 'X=1');
      expect(splitSecrets(checkout, [env], true)).toEqual({ statVisible: [env], closed: [] });
      expect(splitSecrets(checkout, [env], false)).toEqual({ statVisible: [], closed: [env] });
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});
