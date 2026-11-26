import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { FROZEN_KILL_FILE, takeFrozenKill } from './frozen-kill';

let dir: { path: string; cleanup(): void };
beforeEach(() => {
  dir = tempDir('frozen-kill');
});
afterEach(() => {
  dir.cleanup();
});

describe('takeFrozenKill', () => {
  it("reads the app's marker once and removes it, and takes a malformed or missing one as no freeze kill", () => {
    const marker = join(dir.path, FROZEN_KILL_FILE);
    writeFileSync(
      marker,
      JSON.stringify({ pid: 4242, at: 1_790_000_000_000, frozenAfterMs: 30_000 }),
    );
    expect(takeFrozenKill(dir.path)).toEqual({
      pid: 4242,
      at: 1_790_000_000_000,
      frozenAfterMs: 30_000,
    });
    expect(existsSync(marker)).toBe(false);
    expect(takeFrozenKill(dir.path)).toBeNull();

    writeFileSync(marker, '{"pid":');
    expect(takeFrozenKill(dir.path)).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });
});
