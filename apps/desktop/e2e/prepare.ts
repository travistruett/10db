import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DESKTOP_DIR, E2E_DATA, E2E_DIR, E2E_REPO } from './paths';

// The phone app the share listener serves (`/app/`), which the phone flow in inbox.spec.ts opens.
execFileSync('pnpm', ['--filter', '@10db/desktop', 'build:app'], {
  cwd: DESKTOP_DIR,
  stdio: 'inherit',
});

rmSync(E2E_DIR, { recursive: true, force: true });
mkdirSync(join(E2E_REPO, 'src', 'greeting'), { recursive: true });
mkdirSync(join(E2E_REPO, 'evals'), { recursive: true });
mkdirSync(E2E_DATA, { recursive: true });

// The same isolation as tests/git-isolation.setup.ts. An inherited GIT_DIR or GIT_WORK_TREE (git
// exports them to hooks) would aim these commands at another repository, so no GIT_* variable is
// passed on; and the builder's system and global config (signing, hooksPath) stay out of the repo.
const globalConfig = join(E2E_DIR, 'gitconfig');
writeFileSync(globalConfig, '');
const gitEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: globalConfig,
};

/** A fresh disposable repo and an empty data directory, so every run starts from nothing. */
function git(...args: string[]): void {
  execFileSync('git', args, { cwd: E2E_REPO, env: gitEnv, stdio: 'ignore' });
}

writeFileSync(join(E2E_REPO, 'src', 'greeting', '.gitkeep'), '');
// A file a covered glob can hold: `**` does not match a dot file.
writeFileSync(join(E2E_REPO, 'src', 'greeting', 'README.md'), 'Greetings.\n');
git('init', '-b', 'main');
// Every test repository sets these two keys (.claude/rules/testing.md); daemon test code is not
// importable from here. Without them git leaves a detached `git maintenance run --auto` writing
// under `.git` after a commit returns, which races the next run's removal of this directory.
git('config', 'maintenance.auto', 'false');
git('config', 'gc.auto', '0');
git('config', 'user.email', 'e2e@10db.invalid');
git('config', 'user.name', '10db e2e');
git('config', 'commit.gpgsign', 'false');
// An eval definition the loop's run lowers the bar of (loop.spec.ts).
writeFileSync(join(E2E_REPO, 'evals', 'gate.py'), 'GATE = dict(minimum_rate=0.9)\n');
git('add', 'src/greeting/.gitkeep', 'src/greeting/README.md', 'evals/gate.py');
git('commit', '-m', 'Initial commit');
console.log(`e2e repo: ${E2E_REPO}`);
console.log(`e2e data: ${E2E_DATA}`);
