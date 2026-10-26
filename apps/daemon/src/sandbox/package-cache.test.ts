import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packageCacheEnv, projectCacheDir } from './index';

let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-cache-')));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('packageCacheEnv', () => {
  it('points npm and pnpm at the cache directory', () => {
    expect(packageCacheEnv('/c')).toEqual({
      npm_config_cache: '/c/npm',
      pnpm_config_store_dir: '/c/pnpm-store',
      pnpm_config_state_dir: '/c/pnpm-state',
      pnpm_config_cache_dir: '/c/pnpm-cache',
    });
  });
});

describe('projectCacheDir', () => {
  it('creates a private per-project directory under the home caches', () => {
    const projectId = mintId('Project');
    const dir = projectCacheDir(home, projectId);
    expect(dir).toBe(join(home, 'Library', 'Caches', '10db', 'projects', projectId));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('is idempotent and keeps projects apart', () => {
    const a = mintId('Project');
    const b = mintId('Project');
    expect(projectCacheDir(home, a)).toBe(projectCacheDir(home, a));
    expect(projectCacheDir(home, a)).not.toBe(projectCacheDir(home, b));
  });
});
