import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_DATA, E2E_DIR, E2E_REPO } from './paths';

// An inherited GIT_DIR or GIT_WORK_TREE (git exports them to hooks) would aim these commands at
// another repository, so the disposable repo's git gets no GIT_* variable at all.
const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
);

/** A fresh disposable repo and an empty data directory, so every run starts from nothing. */
function git(...args: string[]): void {
  execFileSync('git', args, { cwd: E2E_REPO, env: gitEnv, stdio: 'ignore' });
}

rmSync(E2E_DIR, { recursive: true, force: true });
mkdirSync(join(E2E_REPO, 'src', 'greeting'), { recursive: true });
mkdirSync(E2E_DATA, { recursive: true });
writeFileSync(join(E2E_REPO, 'src', 'greeting', '.gitkeep'), '');
git('init', '-b', 'main');
git('config', 'user.email', 'e2e@10db.invalid');
git('config', 'user.name', '10db e2e');
git('config', 'commit.gpgsign', 'false');
git('add', 'src/greeting/.gitkeep');
git('commit', '-m', 'Initial commit');
console.log(`e2e repo: ${E2E_REPO}`);
console.log(`e2e data: ${E2E_DATA}`);
