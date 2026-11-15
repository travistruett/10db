import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { NeedsAuthCacheError, removeStaleNeedsAuthCache } from './claude-auth-cache';

let dir: TempDir;
beforeEach(() => {
  dir = tempDir('claude-auth-cache');
});
afterEach(() => {
  dir.cleanup();
});

describe('removeStaleNeedsAuthCache', () => {
  it('removes the file and leaves its sibling', async () => {
    const cache = join(dir.path, 'mcp-needs-auth-cache.json');
    const sibling = join(dir.path, '.claude.json');
    writeFileSync(cache, '{}');
    writeFileSync(sibling, '{}');
    await removeStaleNeedsAuthCache(cache);
    expect(existsSync(cache)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
  });

  it('is fine with a file that is not there', async () => {
    await expect(
      removeStaleNeedsAuthCache(join(dir.path, 'mcp-needs-auth-cache.json')),
    ).resolves.toBeUndefined();
  });

  it('leaves a directory at that name alone and rejects with a typed error', async () => {
    const cache = join(dir.path, 'mcp-needs-auth-cache.json');
    mkdirSync(cache);
    writeFileSync(join(cache, 'keep'), 'x');
    await expect(removeStaleNeedsAuthCache(cache)).rejects.toBeInstanceOf(NeedsAuthCacheError);
    expect(existsSync(join(cache, 'keep'))).toBe(true);
  });
});
