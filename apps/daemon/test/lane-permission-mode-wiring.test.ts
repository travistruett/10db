import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('TENDB_LANE_PERMISSION_MODE wiring', () => {
  it('reaches createClaudeAdapter from the daemon entry point', () => {
    const main = readFileSync(join(import.meta.dirname, '../src/main.ts'), 'utf8');
    const adapterCall = /createClaudeAdapter\(\{[^}]*\}\)/s.exec(main)?.[0] ?? '';
    expect(adapterCall).toContain('permissionMode: env.TENDB_LANE_PERMISSION_MODE');
  });
});
