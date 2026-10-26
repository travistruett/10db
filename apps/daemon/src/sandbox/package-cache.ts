import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectId } from '@10db/contracts';

/** Env that moves npm's and pnpm's caches and stores into `cacheDir`, off the shared ones. */
export function packageCacheEnv(cacheDir: string): Record<string, string> {
  return {
    npm_config_cache: join(cacheDir, 'npm'),
    pnpm_config_store_dir: join(cacheDir, 'pnpm-store'),
    pnpm_config_state_dir: join(cacheDir, 'pnpm-state'),
    pnpm_config_cache_dir: join(cacheDir, 'pnpm-cache'),
  };
}

/** The project's own package cache directory, created private (mode 0700). */
export function projectCacheDir(home: string, projectId: ProjectId): string {
  const dir = join(home, 'Library', 'Caches', '10db', 'projects', projectId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}
