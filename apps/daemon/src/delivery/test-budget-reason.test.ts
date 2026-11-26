import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { checkTestBudget } from '../../../../tests/repo/src/test-budget';
import { createTempRepo, isolatedGitEnv, type TempDir } from '../../test/fixtures';
import { createGit } from '../git';
import { autoTestBudgetLine } from './test-budget-reason';

const git = createGit();
let repo: TempDir;
beforeEach(() => {
  repo = createTempRepo();
});
afterEach(() => {
  repo.cleanup();
});

const cases = (count: number, name: string): string =>
  Array.from({ length: count }, (_, n) => `  it('${name} ${String(n)}', () => {});\n`).join('');

async function commitTests(
  name: string,
  count: number,
  card: string,
  opId: string,
): Promise<string> {
  const path = `apps/daemon/src/delivery/${name}.test.ts`;
  mkdirSync(dirname(join(repo.path, path)), { recursive: true });
  writeFileSync(join(repo.path, path), cases(count, name));
  const { sha } = await git.commit({
    repo: repo.path,
    paths: [path],
    message: `test: ${name}\n\nValue: protects=${name}; fails_when=it breaks; ${card}; no_claim=more`,
    opId,
    branch: 'main',
  });
  return sha;
}

/** What CI's budget check says of the pull request `base..tip` with `body`. */
function ciSays(base: string, tip: string, body: string): boolean {
  const diff = execFileSync(
    'git',
    ['-C', repo.path, 'diff', '-U0', '--no-renames', base, tip, '--', '*.test.ts', '*.test.tsx'],
    { env: isolatedGitEnv(), encoding: 'utf8' },
  );
  return checkTestBudget({ diff, codeLines: 0, body }).ok;
}

// Value: protects=a pull request over the unit-test budget gets the Test-budget line only when every
// commit that added tests names a core area or an escaped bug, and the line clears CI's check;
// fails_when=the line is written for a commit with no such card, or CI still fails with it;
// why_new=the budget check's escape is a rule of 10db's own pull requests; no_claim=the daemon's
// count equals CI's for every diff.
it('writes the Test-budget line when every commit adding tests has a core or escaped-bug card, and not when one has none', async () => {
  const base = await git.head(repo.path);
  const bug = await commitTests(
    'alpha',
    2,
    'why_new=escaped bug: a card was lost twice',
    'op-alpha',
  );
  expect(await autoTestBudgetLine(git, repo.path, base, bug)).toBeNull();

  const core = await commitTests('beta', 2, 'why_new=core: recovery of a batch', 'op-beta');
  const line = await autoTestBudgetLine(git, repo.path, base, core);
  expect(line).toMatch(/^Test-budget: 4 new unit tests against a budget of 3/);
  expect(line).toContain('escaped bug: a card was lost twice');
  expect(line).toContain('core: recovery of a batch');
  expect(ciSays(base, core, '')).toBe(false);
  expect(ciSays(base, core, line ?? '')).toBe(true);

  const plain = await commitTests('gamma', 1, 'why_new=none', 'op-gamma');
  expect(await autoTestBudgetLine(git, repo.path, base, plain)).toBeNull();
  expect(ciSays(base, plain, '')).toBe(false);
});
