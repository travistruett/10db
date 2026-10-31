import { DEFAULT_HAZARDS } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { judgeToolUse } from './judge';
import { sandboxedAsk } from './sandboxed-asks';

function guard(command: string, claimed = false) {
  return judgeToolUse({
    toolName: 'Bash',
    toolInput: { command },
    repoPath: '/tmp/repo',
    areas: [],
    hazards: DEFAULT_HAZARDS,
    claims: claimed
      ? [
          { kind: 'hazard', name: 'deps' },
          { kind: 'hazard', name: 'migrations' },
        ]
      : [],
    readOnly: false,
    delivery: 'pull_request',
    protectedPaths: [],
  });
}
const hook = (command: string) =>
  sandboxedAsk({ toolName: 'Bash', input: { command } }, DEFAULT_HAZARDS);

describe('a hazard run through another shell, wrapper or version is still that hazard', () => {
  it.each([
    "dash -c 'pnpm add x'",
    "ksh -c 'pnpm add x'",
    "csh -c 'pnpm add x'",
    "tcsh -c 'pnpm add x'",
    "fish -c 'pnpm add x'",
    "echo 'pnpm add x' | dash",
    'coproc pnpm add x',
    'taskpolicy -b pnpm add x',
    'xcrun pnpm add x',
    'npx --yes pnpm@9 add x',
    'pnpm dlx pnpm@9 add x',
    'npx npm@10 install',
    'npm x -- pnpm add x',
    'watch pnpm add x',
    'unbuffer pnpm add x',
    'chronic pnpm add x',
    'dotenv -- pnpm add x',
  ])('%s', (command) => {
    expect(guard(command).decision).toBe('deny');
    expect(hook(command)?.decision).toBe('ask');
  });
});

describe('git, gh and publish are refused through wrappers and feeders', () => {
  it.each([
    'xcrun git push --force',
    'echo push --force | xargs git',
    'echo pr merge 1 --admin | xargs gh',
    'yarn npm publish',
  ])('%s', (command) => {
    expect(guard(command).decision).toBe('deny');
  });
  it.each(['echo git push --force', 'grep -rn "git push" .'])(
    'does not refuse the harmless %s',
    (command) => {
      expect(guard(command).decision).toBe('allow');
    },
  );
});

describe('the hazard matcher reads script runners and aliases', () => {
  it.each([
    'pnpm run db:migrate',
    'pnpm --silent run db:migrate',
    'pnpm run-script db:migrate',
    'npm run db:migrate',
    'pnpm drizzle-kit generate',
    'npm r x',
    'npm rm x',
    'npm remove x',
    'npm update',
    'npm up',
    'npm in x',
    'npm it',
    'yarn',
    'yarn remove x',
    'yarn workspace a add x',
  ])('%s', (command) => {
    expect(guard(command).decision).toBe('deny');
    expect(guard(command, true).decision).toBe('allow');
    expect(hook(command)?.decision).toBe('ask');
  });
});

describe('quoted literals and arguments are not asked about', () => {
  it.each([
    "pnpm --filter '@10db/*' test",
    "pnpm vitest run 'src/**/*.test.ts'",
    "pnpm exec eslint 'apps/**/*.ts'",
    "pnpm vitest -t 'parses [x]'",
    "pnpm exec tsx -e 'console.log({a:1})'",
    'grep -rn pnpm docs/*.md',
    'rg npm src/*',
    '~/bin/foo x',
    'echo pnpm add x',
    'pnpm typecheck && pnpm lint',
    'yarn --version',
  ])('%s', (command) => {
    expect(hook(command)).toBeNull();
  });
  it.each(['pnpm $sub x', 'pnpm "$sub" x', 'pnpm --filter "$p" test'])(
    'still asks about %s',
    (command) => {
      expect(hook(command)?.decision).toBe('ask');
    },
  );
});

describe('git and gh behind a feeder are always refused', () => {
  it.each([
    'echo x | xargs git push',
    'echo x | xargs git add',
    'echo x | xargs git fetch',
    'echo x | xargs git config',
    'echo x | xargs -I{} git log {}',
    'echo x | xargs -I X git log X',
    'echo x | xargs -xI{} git {}',
    'echo x | xargs --replace git {}',
    'echo x | parallel git log {}',
    'echo x | xargs gh repo view',
    'echo x | xargs -i git',
    'echo x | xargs -J % git % --force',
    'echo x | parallel git {}',
    'echo x | xargs gh pr merge',
    'echo x | xargs gh api -X POST',
    'echo --open-files-in-pager=sh | xargs git grep x',
    'echo -XPOST | xargs gh api repos/x/y',
    'git ls-files | xargs git log',
    'echo x | xargs git show',
    'echo x | xargs gh pr view',
    'echo x | xargs gh api repos/x/y',
  ])('refuses %s', (command) => {
    expect(guard(command).decision).toBe('deny');
  });
});

describe('what the parser cannot classify next to a hazard program asks', () => {
  it.each([
    'pnpm {fd}>out add x',
    'pnpm 2 >f add x',
    'pnpm {a,b} x',
    'pnpm {1..3}',
    'pnpm exec foo {x',
    `xcrun ${'-q '.repeat(20)}pnpm add x`,
    'pnpm it',
    'pnpm ci',
    'pnpm install-test',
    'bun add x',
    'bun remove x',
    'bun install',
    'bun i',
    'bun update',
  ])('%s', (command) => {
    expect(hook(command)?.decision ?? guard(command).decision).not.toBe('allow');
  });
  it('lets an uncertain command with no hazard program pass the hook', () => {
    expect(hook('echo "unclosed')).toBeNull();
  });
});
