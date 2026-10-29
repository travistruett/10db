import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { laneMiseConfig } from './mise-config';
import { packageCacheEnv } from './package-cache';

/** Set for every sandboxed command, so a test that can't run in a sandbox can skip. */
const SANDBOX_MARKER = 'TENDB_SANDBOX';

/**
 * Prepares a sandbox's own temp dir for the commands that run in it, and returns the variables they
 * need on top of the allowlisted env: package caches inside the temp dir, a global mise config of the
 * builder's tool versions only, git with no global config and no optional locks, and the sandbox
 * marker. Lanes and gate runs get the same set.
 */
export function prepareCommandEnv(
  tmpDir: string,
  home: string,
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  // The builder's global tool versions and nothing else, so neither the global config's `[env]`
  // nor its age key reaches a sandboxed command.
  const miseConfigDir = join(tmpDir, 'mise');
  mkdirSync(miseConfigDir, { mode: 0o700 });
  const miseConfigFile = join(miseConfigDir, 'config.toml');
  writeFileSync(miseConfigFile, laneMiseConfig(home, env), { mode: 0o600 });
  return {
    // Inside the temp dir: a cache can hold code a later install runs, so no two sandboxes share
    // one, and it goes with the temp dir.
    ...packageCacheEnv(join(tmpDir, 'cache')),
    MISE_CONFIG_DIR: miseConfigDir,
    MISE_GLOBAL_CONFIG_FILE: miseConfigFile,
    // mise's system config moves to the sandbox's own dir too, where none exists.
    MISE_SYSTEM_DIR: miseConfigDir,
    MISE_SYSTEM_CONFIG_FILE: join(miseConfigDir, 'system.toml'),
    // mise records each config file it loads under its state dir, which a sandbox reads but can't
    // write, and warns on every command when the write is refused. The warning is the only effect;
    // errors still show.
    MISE_LOG_LEVEL: 'error',
    // Apple's `/usr/bin/git` and `make` are xcrun shims that cache their tool lookup in a file in
    // the per-user Darwin temp dir, which a sandbox can't write; each call then prints an error and
    // repeats the lookup. xcrun creates the cache where this names it.
    xcrun_db: join(tmpDir, 'xcrun_db'),
    // An exception to keeping git config variables: the builder's global config can name hooks,
    // credential helpers and includes the sandboxed git would run or read.
    GIT_CONFIG_GLOBAL: '/dev/null',
    // A sandboxed git reads only: a status never refreshes the index it can't write.
    GIT_OPTIONAL_LOCKS: '0',
    // An empty config home of its own: git and the rest find no config there, where the builder's
    // would be denied. git's default ignore file otherwise warns on every call, and gitleaks takes
    // any warning from git as a failed scan and reports no leaks.
    XDG_CONFIG_HOME: join(tmpDir, 'config'),
    [SANDBOX_MARKER]: '1',
  };
}
