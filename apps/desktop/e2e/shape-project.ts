import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type APIRequestContext } from '@playwright/test';
import { z } from 'zod';
import { daemonUrl } from './daemon-url';
import { E2E_DIR, E2E_TOKEN } from './paths';

const Created = z.looseObject({ id: z.string() });

/** The UI token's header, for the daemon's own routes. */
export const auth = { Authorization: `Bearer ${E2E_TOKEN}` };

/** A disposable repository for the project; git config comes from nowhere but this repo. */
function createRepository(repo: string): void {
  mkdirSync(repo, { recursive: true });
  const globalConfig = join(E2E_DIR, 'shape-gitconfig');
  writeFileSync(globalConfig, '');
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig,
  };
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, env, stdio: 'ignore' });
  };
  git('init', '-b', 'main');
  git('config', 'maintenance.auto', 'false');
  git('config', 'gc.auto', '0');
  git('config', 'user.email', 'e2e@10db.invalid');
  git('config', 'user.name', '10db e2e');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# shape e2e\n');
  git('add', 'README.md');
  git('commit', '-m', 'Initial commit');
}

/** A project on its own repository, so one spec's tasks never meet another's. */
export async function createProject(request: APIRequestContext, name: string): Promise<string> {
  const repo = join(E2E_DIR, `${name}-repo`);
  createRepository(repo);
  const created = await request.post(`${daemonUrl}/projects`, {
    headers: auth,
    data: {
      name,
      repoPath: repo,
      gateCommand: 'true',
      areas: [{ name: 'repo', globs: ['**'] }],
      handoffPct: 40,
      nudgePct: 50,
      delivery: 'local',
    },
  });
  expect(created.ok()).toBe(true);
  return Created.parse(await created.json()).id;
}
