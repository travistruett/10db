import { describe, expect, it } from 'vitest';
import { packageCacheEnv } from './index';

describe('packageCacheEnv', () => {
  it('points npm, node-gyp, corepack, pnpm and cargo at the cache directory', () => {
    expect(packageCacheEnv('/c')).toEqual({
      npm_config_cache: '/c/npm',
      npm_config_devdir: '/c/node-gyp',
      COREPACK_HOME: '/c/corepack',
      pnpm_config_store_dir: '/c/pnpm-store',
      pnpm_config_state_dir: '/c/pnpm-state',
      pnpm_config_cache_dir: '/c/pnpm-cache',
      CARGO_HOME: '/c/cargo',
    });
  });
});
