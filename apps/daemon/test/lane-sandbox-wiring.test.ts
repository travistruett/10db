import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('TENDB_LANE_SANDBOX wiring', () => {
  it('reaches the daemon from its entry point, with the loopback switch, and only when on', () => {
    const main = readFileSync(join(import.meta.dirname, '../src/main.ts'), 'utf8');
    const startCall = /startDaemon\(\{.*?\n {2}\}\)/s.exec(main)?.[0] ?? '';
    expect(startCall.replace(/\s+/g, ' ')).toContain(
      "laneSandbox: env.TENDB_LANE_SANDBOX === 'on' ? { loopback: env.TENDB_LANE_SANDBOX_LOOPBACK === 'on' } : null",
    );
  });
});
