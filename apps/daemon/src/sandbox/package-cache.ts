import { join } from 'node:path';

/**
 * Env that moves npm's cache, node-gyp's headers, corepack's package managers, pnpm's store and
 * dirs, cargo's home and uv's cache, tools and Python installs into `cacheDir`, off the shared ones
 * under home, which a lane can't write. uv then uses the system Pythons, never the builder's under
 * `~/.local/share/uv`, and `uvx` builds its environments in the cache.
 * Moving `CARGO_HOME` leaves rustup's `cargo` on PATH and its toolchains in `RUSTUP_HOME`; cargo no
 * longer reads `~/.cargo/config.toml` or its credentials, and `cargo install` into the
 * default root fails: `bin` there links to the read-only `~/.cargo/bin` when it exists.
 */
export function packageCacheEnv(cacheDir: string): Record<string, string> {
  return {
    npm_config_cache: join(cacheDir, 'npm'),
    npm_config_devdir: join(cacheDir, 'node-gyp'),
    COREPACK_HOME: join(cacheDir, 'corepack'),
    pnpm_config_store_dir: join(cacheDir, 'pnpm-store'),
    pnpm_config_state_dir: join(cacheDir, 'pnpm-state'),
    pnpm_config_cache_dir: join(cacheDir, 'pnpm-cache'),
    CARGO_HOME: join(cacheDir, 'cargo'),
    UV_CACHE_DIR: join(cacheDir, 'uv'),
    UV_TOOL_DIR: join(cacheDir, 'uv-tools'),
    UV_PYTHON_INSTALL_DIR: join(cacheDir, 'uv-python'),
  };
}
