import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('TENDB_LANE_PERMISSION_MODE wiring', () => {
  it('reaches the runner from the daemon entry point as the override for every project', () => {
    const main = readFileSync(join(import.meta.dirname, '../src/main.ts'), 'utf8');
    const startCall = /startDaemon\(\{.*?\n {2}\}\)/s.exec(main)?.[0] ?? '';
    expect(startCall).toContain('permissionModeOverride: env.TENDB_LANE_PERMISSION_MODE');
  });

  it('no longer reaches the Claude adapter, which takes the mode from each session', () => {
    const main = readFileSync(join(import.meta.dirname, '../src/main.ts'), 'utf8');
    const adapterCall = /createClaudeAdapter\(\{[^}]*\}\)/s.exec(main)?.[0] ?? '';
    expect(adapterCall).not.toContain('permissionMode');
  });
});
