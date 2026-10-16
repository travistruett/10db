import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepoFile, repoRoot } from './workspace';

const RULES = '.codex/rules/default.rules';
const hasCodex = spawnSync('codex', ['--version'], { encoding: 'utf8' }).status === 0;

type Decision = 'forbidden' | 'prompt' | 'allow';

// The same commands as the Claude guard's table, judged by Codex's own policy engine.
const CASES: [string, Decision][] = [
  ['git commit --no-verify -m x', 'forbidden'],
  ['git commit -n -m x', 'forbidden'],
  ['git commit -nm x', 'forbidden'],
  ['git commit --no-verif -m x', 'forbidden'],
  ['git commit --no-v -m x', 'forbidden'],
  ['git push --no-verify', 'forbidden'],
  ['git push --no-verif origin feat/x', 'forbidden'],
  ['git config core.hooksPath /dev/null', 'forbidden'],
  ['git config --local core.hooksPath .nohooks', 'forbidden'],
  ['git config --unset core.hooksPath', 'forbidden'],
  ['git -c core.hooksPath=/dev/null commit -m x', 'prompt'],
  ['LEFTHOOK=0 git commit -m x', 'forbidden'],
  ['env LEFTHOOK=0 git commit -m x', 'forbidden'],
  ['git add -A', 'forbidden'],
  ['git add .', 'forbidden'],
  ['git commit -am x', 'forbidden'],
  ['git commit --amend', 'prompt'],
  ['git stash pop', 'prompt'],
  ['git reset --hard HEAD', 'prompt'],
  ['git rebase main', 'prompt'],
  ['git clean -fd', 'prompt'],
  ['git push --force', 'prompt'],
  ['git push origin main', 'prompt'],
  ['git push -u origin main', 'prompt'],
  ['git filter-repo --force', 'prompt'],
  ['gh pr merge 12 --squash --admin', 'prompt'],
  ['gh api -X PUT repos/o/r/rulesets/7', 'prompt'],
  ['gh secret set X', 'prompt'],
  ['make github-settings', 'prompt'],
  ['node scripts/github-settings.mjs', 'prompt'],
  ['node ./scripts/github-settings.mjs', 'prompt'],
  ['./scripts/github-settings.mjs', 'prompt'],
  ['scripts/github-settings.mjs', 'prompt'],
  ['gh api --method PATCH repos/o/r', 'prompt'],
  ['gh api -X PUT repos/o/r/vulnerability-alerts', 'prompt'],
  ['gh api -X PUT repos/o/r/automated-security-fixes', 'prompt'],
  ['git push --all origin', 'prompt'],
  ['git push --mirror', 'prompt'],
  ['git push -d origin feat/x', 'prompt'],
  ['git push -uf origin feat/x', 'prompt'],
  ['git push origin +main', 'prompt'],
  ['git push -u origin +main', 'prompt'],
  ['command git add -A', 'forbidden'],
  ['command git commit --no-verify -m x', 'forbidden'],
  ['exec git add .', 'forbidden'],
  ['command git push --force', 'prompt'],
  ['time git push origin main', 'prompt'],
  ['nohup git reset --hard HEAD', 'prompt'],
  ['sudo git add -A', 'forbidden'],
  ['xargs git add -A', 'forbidden'],
  ['setsid git push --force', 'prompt'],
  ['git add src/a.ts', 'allow'],
  ['git push origin feat/x', 'allow'],
  // Prefix-only limits, pinned so a change in Codex's matching shows up: CI is the backstop.
  ['git commit -m x --no-verify', 'allow'],
  ['LEFTHOOK_EXCLUDE=gitleaks git commit -m x', 'allow'],
  ['git --config-env=core.hooksPath=HOME commit -m x', 'allow'],
];

describe('Codex rules', () => {
  it('cover every rule class the Claude guard enforces', () => {
    const rules = readRepoFile(RULES);
    for (const word of ['--no-verify', 'LEFTHOOK=0', '"-A"', '--amend', '"stash"', '"--hard"']) {
      expect(rules, word).toContain(word);
    }
    for (const word of ['"rebase"', '"clean"', '"--force"', '"main"', 'core.hooksPath', '"-c"']) {
      expect(rules, word).toContain(word);
    }
  });
});

// Codex isn't installed in CI; there the structural test above still runs.
describe.skipIf(!hasCodex)('Codex rules under codex execpolicy', () => {
  it.each(CASES)('judges `%s` as %s', (command, expected) => {
    const result = spawnSync(
      'codex',
      ['execpolicy', 'check', '--rules', resolve(repoRoot, RULES), '--', ...command.split(' ')],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    const verdict = JSON.parse(result.stdout) as { decision?: Decision };
    expect(verdict.decision ?? 'allow').toBe(expected);
  });
});
