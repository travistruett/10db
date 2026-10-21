import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

// Every vitest project lists this in its setupFiles, so it runs before every test file.
//
// Git exports GIT_DIR, GIT_INDEX_FILE, GIT_PREFIX and more to its hooks, and the pre-push hook runs
// these tests. A test that spawned git with them inherited would act on the contributor's
// checkout instead of its temporary repository. Every GIT_* variable goes, with no allowlist: no
// test needs one from outside, and any of them (GIT_EDITOR, GIT_SSH_COMMAND, GIT_TRACE) would make
// a test's git behave differently on one machine than on another.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('GIT_')) Reflect.deleteProperty(process.env, name);
}

// Nor may a test read or write the contributor's own config: their signing, hooksPath or identity
// would reach every commit a test makes. An empty global file, rather than /dev/null, lets a test
// that runs `git config --global` succeed without touching anything real.
const configDir = mkdtempSync(join(tmpdir(), '10db-git-config-'));
const globalConfig = join(configDir, 'gitconfig');
writeFileSync(globalConfig, '');
process.env['GIT_CONFIG_NOSYSTEM'] = '1';
process.env['GIT_CONFIG_GLOBAL'] = globalConfig;

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true });
});
