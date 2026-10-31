import { homedir } from 'node:os';
import { ClaimKind, DEFAULT_HAZARDS } from '@10db/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { judgePreToolUse, protectedPaths, type FileAccessJudge } from './index';

const repo = tempDir('hook-asks-repo');
afterAll(() => {
  repo.cleanup();
});

type Claims = readonly { readonly kind: ClaimKind; readonly name: string }[];
const AREA: Claims = [{ kind: ClaimKind.Area, name: 'all' }];
const ALL_HAZARDS: Claims = [
  ...AREA,
  { kind: ClaimKind.Hazard, name: 'deps' },
  { kind: ClaimKind.Hazard, name: 'migrations' },
];

const access: FileAccessJudge = {
  read: () => 'ok',
  write: () => 'ok',
  readAsk: (_tool, input) => (JSON.stringify(input).includes('outside') ? 'outside' : null),
  writeAsk: (path) => (path.includes('.mcp.json') ? 'a Claude Code config path' : null),
};

function pre(
  toolName: string,
  toolInput: unknown,
  claims: Claims = AREA,
  fileAccess?: FileAccessJudge,
) {
  return judgePreToolUse({
    toolName,
    toolInput,
    repoPath: repo.path,
    areas: [{ name: 'all', globs: ['**'] }],
    hazards: DEFAULT_HAZARDS,
    claims,
    readOnly: false,
    delivery: 'pull_request',
    protectedPaths: protectedPaths({
      dataDir: '/tmp/10db-data',
      home: homedir(),
      loginConfigDir: '/tmp/login',
    }),
    ...(fileAccess ? { fileAccess } : {}),
  }).decision;
}
const bash = (command: string, claims: Claims = AREA) => pre('Bash', { command }, claims);

describe('tools that act outside the sandbox proxy, and the file tools', () => {
  it.each<[string, string, unknown, 'allow' | 'ask']>([
    ['a web search', 'WebSearch', { query: 'x' }, 'ask'],
    ['a repo MCP tool', 'mcp__docs__search', {}, 'ask'],
    ['listing MCP resources', 'ListMcpResourcesTool', {}, 'ask'],
    ['reading an MCP resource', 'ReadMcpResourceTool', {}, 'ask'],
    ["10db's own MCP tool", 'mcp__10db__complete_step', {}, 'allow'],
    ['a plain file read', 'Read', { file_path: `${repo.path}/a.ts` }, 'allow'],
  ])('%s -> %s', (_name, tool, input, expected) => {
    expect(pre(tool, input, ALL_HAZARDS, access)).toBe(expected);
  });

  it.each<[string, string, unknown, 'allow' | 'ask']>([
    ['a read outside what lanes may read', 'Read', { file_path: `${repo.path}/outside/x` }, 'ask'],
    ['a search outside', 'Grep', { pattern: 'x', path: `${repo.path}/outside` }, 'ask'],
    ['a claude-protected write', 'Edit', { file_path: `${repo.path}/.mcp.json` }, 'ask'],
    [
      'a notebook edit of a config path',
      'NotebookEdit',
      { notebook_path: `${repo.path}/sub/.mcp.json` },
      'ask',
    ],
    ['an ordinary write', 'Write', { file_path: `${repo.path}/a.ts` }, 'allow'],
  ])('with a file-access judge: %s -> %s', (_name, tool, input, expected) => {
    expect(pre(tool, input, ALL_HAZARDS, access)).toBe(expected);
  });

  it('asks for nothing about files without a file-access judge', () => {
    expect(pre('Read', { file_path: `${repo.path}/outside/x` }, ALL_HAZARDS)).toBe('allow');
  });
});

describe('a tool the classifier may not decide is handed to the broker', () => {
  it.each([
    'EnterWorktree',
    'ExitWorktree',
    'CronCreate',
    'ScheduleWakeup',
    'RemoteTrigger',
    'PushNotification',
    'SendMessage',
    'LSP',
    'SomeToolAddedLater',
  ])('%s -> ask', (tool) => {
    expect(pre(tool, {}, ALL_HAZARDS)).toBe('ask');
  });
  it.each([
    ['Task', { description: 'x', prompt: 'y' }],
    ['Agent', { description: 'x', prompt: 'y' }],
    ['TodoWrite', { todos: [] }],
    ['Skill', { skill: 'x' }],
    ['AskUserQuestion', { questions: [] }],
    ['BashOutput', { bash_id: '1' }],
    ['KillShell', { shell_id: '1' }],
    ['NotebookRead', { notebook_path: '/tmp/x' }],
    ['mcp__10db__complete_step', {}],
  ])('%s -> allow, the classifier may decide it', (tool, input) => {
    expect(pre(tool, input, ALL_HAZARDS)).toBe('allow');
  });
});

describe('background loops ask whatever the task has claimed', () => {
  it.each<[string, Record<string, unknown>, 'allow' | 'ask']>([
    ['a backgrounded busy loop', { command: '(while :; do :; done) &' }, 'ask'],
    [
      'yes behind run_in_background',
      { command: 'yes > /dev/null', run_in_background: true },
      'ask',
    ],
    ['the same loop in the foreground', { command: 'yes > /dev/null' }, 'allow'],
  ])('%s -> %s', (_name, input, expected) => {
    expect(pre('Bash', input, ALL_HAZARDS)).toBe(expected);
  });
  it.each(['yes > /dev/null', 'while :; do :; done', '(while true; do :; done)'])(
    'a Monitor of %s asks',
    (command) => {
      expect(pre('Monitor', { command }, ALL_HAZARDS)).toBe('ask');
    },
  );
});

describe('a Monitor command is judged as a Bash command', () => {
  it.each([
    'git push --force origin main',
    'gh pr merge 1 --admin',
    'npm publish',
    'git reset --hard HEAD~3',
    'git commit --no-verify -m x',
    'pnpm add x',
  ])('refuses %s through Monitor as through Bash', (command) => {
    expect(bash(command)).toBe('deny');
    expect(pre('Monitor', { command })).toBe('deny');
  });
  it('lets a plain Monitor command through: it runs inside the sandbox like Bash', () => {
    expect(pre('Monitor', { command: 'tail -f out.log' })).toBe('allow');
  });
  it.each([
    ['a socket key', { command: 'tail -f out', ws: 'wss://example.org' }],
    ['no command', { description: 'x' }],
    ['a backgrounded loop', { command: '(while :; do :; done) &' }],
  ])('asks about a Monitor with %s', (_name, input) => {
    expect(pre('Monitor', input)).toBe('ask');
  });
});

describe('a hazard spelled around a redirection or a quote is still that hazard', () => {
  it.each([
    'pnpm 2>/dev/null add x',
    'pnpm >/dev/null add x',
    'pnpm > /dev/null add x',
    'pnpm 2>/dev/null db:migrate',
    "pnpm add '2>/dev/null' x",
    'pnpm ">" add x',
    "pnpm '2>/dev/null' add x",
    'pnpm {fd}>out add x',
    'pnpm 2 >f add x',
  ])('%s', (command) => {
    expect(bash(command)).not.toBe('allow');
    expect(bash(command, ALL_HAZARDS)).toBe('allow');
  });
});

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
    `xcrun ${'-q '.repeat(20)}pnpm add x`,
  ])('%s', (command) => {
    expect(bash(command)).not.toBe('allow');
  });
});

describe('git, gh and publish are refused through wrappers and feeders', () => {
  it.each([
    'xcrun git push --force',
    'echo push --force | xargs git',
    'echo pr merge 1 --admin | xargs gh',
    'yarn npm publish',
    'git ls-files | xargs git log',
    'echo x | xargs -I{} git log {}',
    'echo x | parallel git log {}',
    'echo x | xargs gh api repos/x/y',
  ])('%s', (command) => {
    expect(bash(command, ALL_HAZARDS)).toBe('deny');
  });
  it.each(['echo git push --force', 'grep -rn "git push" .'])('does not refuse %s', (command) => {
    expect(bash(command)).toBe('allow');
  });
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
    'pnpm it',
    'pnpm ci',
    'pnpm install-test',
    'bun add x',
    'bun remove x',
    'bun install',
    'bun i',
    'bun update',
    'npm clean-install',
    'npm ic',
    'npm install-clean',
    'npm isntall-clean',
    'npm uni x',
    'npm unlink x',
    'npm udpate',
    'bun rm x',
    'bun a x',
    'pnpm rum db:migrate',
    'pnpm urn db:migrate',
    'npm rum db:migrate',
    'yarn workspace a run db:migrate',
  ])('%s', (command) => {
    expect(bash(command)).toBe('deny');
    expect(bash(command, ALL_HAZARDS)).toBe('allow');
  });
});

describe('a deliberately deep chain of script-runner prefixes is still read', () => {
  const deep = `yarn ${'workspace a '.repeat(25)}${'run '.repeat(25)}db:migrate`;
  it('reads through every prefix', () => {
    expect(bash(deep)).toBe('deny');
    expect(bash(deep, ALL_HAZARDS)).toBe('allow');
  });
  it('never gives up quietly: past the limit the search throws, which the hook turns into a refusal', () => {
    const absurd = `yarn ${'workspace a '.repeat(3000)}db:migrate`;
    expect(() => bash(absurd)).toThrow(RangeError);
  });
});

describe('a hazard program with a word 10db cannot read asks while a hazard is unclaimed', () => {
  it.each([
    'x=add; pnpm $x lodash',
    'p=pnpm; $p add x',
    'pnpm ${X:-add} x',
    'pnpm $((0)) add x',
    'pnpm `echo add` x',
    'echo add x | xargs pnpm',
    'env pnpm $sub x',
    '$CMD --help',
    'for d in a b; do (cd $d && pnpm $verb x); done',
    "sh -c 'pnpm $verb x'",
    'pnpm {a,b} x',
    'pnpm {1..3}',
    'nice xargs pnpm',
    'timeout 5 xargs pnpm',
    'env xargs pnpm',
    'command xargs pnpm',
    'echo x | parallel pnpm',
    'parallel pnpm ::: add',
  ])('%s', (command) => {
    expect(bash(command)).toBe('ask');
    expect(pre('Monitor', { command })).toBe('ask');
    expect(bash(command, ALL_HAZARDS)).toBe('allow');
  });
});

describe('a command 10db cannot read asks while a hazard is unclaimed', () => {
  it.each(['~/bin/foo x', 'echo "unclosed'])('%s', (command) => {
    expect(bash(command)).not.toBe('allow');
    expect(bash(command, ALL_HAZARDS)).toBe('allow');
  });
});

describe('eval runs what it is given', () => {
  it.each([
    ["eval 'pnpm $X'", 'ask'],
    ['eval "$CMD"', 'ask'],
    ['nice eval "$CMD"', 'ask'],
    ["eval 'pnpm add x'", 'deny'],
    ['eval echo hi', 'allow'],
  ] as const)('%s -> %s', (command, expected) => {
    expect(bash(command)).toBe(expected);
  });
});

describe('quoted literals and ordinary commands pass', () => {
  it.each([
    "pnpm --filter '@10db/*' test",
    "pnpm vitest run 'src/**/*.test.ts'",
    "pnpm exec eslint 'apps/**/*.ts'",
    "pnpm vitest -t 'parses [x]'",
    "pnpm exec tsx -e 'console.log({a:1})'",
    'grep -rn pnpm docs/*.md',
    'rg npm src/*',
    'echo pnpm add x',
    'pnpm typecheck && pnpm lint',
    'yarn --version',
    'pnpm --filter @10db/daemon exec vitest run src/x.test.ts',
    'grep -rn "$(pwd)" .',
    'cd "$DIR" && ls',
    'pnpm test 2>&1 | grep foo',
    'git status',
    'xargs wc -l < files.txt',
  ])('%s', (command) => {
    expect(bash(command)).toBe('allow');
  });
});
