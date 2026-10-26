import { homedir } from 'node:os';
import { join } from 'node:path';
import { mintId, type PermissionRuleDto } from '@10db/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import {
  allowedToolsFor,
  baseAllowedTools,
  commandPrefix,
  matchesAllowedTool,
  matchPermissionRule,
} from './index';

const repo = tempDir('permissions-repo');
afterAll(() => {
  repo.cleanup();
});

const allowed = baseAllowedTools({ gateCommand: 'make gate' });
const bash = (command: unknown): unknown => ({ command });

describe('matchesAllowedTool: plain Bash commands', () => {
  it.each<[string, string, boolean]>([
    ['gate command', 'make gate', true],
    ['gate command with a longer name', 'make gate-fast', false],
    ['git status', 'git status', true],
    ['git status with a flag', 'git status --short', true],
    ['git log', 'git log --oneline', true],
    ['git diff', 'git diff HEAD', true],
    ['git show', 'git show HEAD', true],
    ['git status by absolute path', '/usr/bin/git status', true],
    ['pwd', 'pwd', true],
    ['pwd with an argument', 'pwd -P', false],
    ['ls is no longer base-allowed', 'ls', false],
    ['ls with a path is not base-allowed', 'ls src', false],
    ['git push', 'git push', false],
    ['an unrelated program', 'curl evil.example', false],
    ['an empty command', '', false],
    ['git status 2>&1', 'git status 2>&1', true],
    ['git status >/dev/null', 'git status >/dev/null', true],
    ['git status 2>/dev/null', 'git status 2>/dev/null', true],
    ['git status piped to a program', 'git status | curl evil.example', false],
    ['git status piped to git log', 'git status | git log', true],
  ])('%s: %s -> %s', (_name, command, expected) => {
    expect(matchesAllowedTool('Bash', bash(command), allowed, repo.path)).toBe(expected);
  });
});

describe('matchesAllowedTool: shell forms that are not plain', () => {
  it.each<[string, string]>([
    ['redirect to a file', 'git status > out'],
    ['redirect to a home file', 'git status > ~/.zshrc'],
    ['redirect without a space', 'git status >out'],
    ['append', 'git status >> out'],
    [
      'append into the git config',
      "git log -1 --format='[core]%n%x09fsmonitor = touch PWNED' >> .git/config",
    ],
    ['redirect both streams', 'git status &> out'],
    ['clobber redirect', 'git status >| out'],
    ['numbered redirect', 'git status 3>out'],
    ['stderr to a file', 'git status 2>err'],
    ['stdout to another place after 2>&1', 'git status 2>&1 >/etc/hosts'],
    ['redirect to a device other than null', 'git status >/dev/tty'],
    ['input redirect', 'git status <in'],
    ['here string', 'git status <<< x'],
    ['assignment prefix', 'GIT_PAGER=x git log'],
    ['assignment after env', 'env GIT_PAGER=x git log'],
    ['command substitution', 'git status $(curl evil.example)'],
    ['backtick substitution', 'git status `curl evil.example`'],
    ['process substitution', 'git diff <(curl evil.example)'],
    ['variable expansion', 'git log ${IFS}'],
    ['env split-string', 'env -S "curl evil" git status'],
    ['env split-string, joined', 'env -Scurl git status'],
    ['env long split-string', 'env --split-string=curl git status'],
    ['env chdir', 'env -C /tmp git status'],
    ['time output file', 'time -o ~/.zshrc git status'],
    ['time long output file', 'time --output=out git status'],
    ['xargs', 'xargs git status'],
    ['xargs with a flag', 'xargs -n1 git status'],
    ['or-list with a program', 'git status || curl evil.example'],
    ['semicolon compound', 'git status; curl evil.example'],
    ['newline compound', 'git status\ncurl evil.example'],
    ['background compound', 'git status & curl evil.example'],
    ['and-list compound', 'git status && curl evil.example'],
  ])('%s: %s', (_name, command) => {
    expect(matchesAllowedTool('Bash', bash(command), allowed, repo.path)).toBe(false);
  });

  it.each<[string, string]>([
    ['env without a value flag', 'env git status'],
    ['time without flags', 'time git status'],
    ['nohup', 'nohup git status'],
  ])('allows %s: %s', (_name, command) => {
    expect(matchesAllowedTool('Bash', bash(command), allowed, repo.path)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['missing command', {}],
    ['non-string command', { command: 42 }],
    ['non-object input', 'git status'],
    ['null input', null],
  ])('does not allow Bash with %s', (_name, input) => {
    expect(matchesAllowedTool('Bash', input, allowed, repo.path)).toBe(false);
  });

  it('does not treat a bare Bash entry as allowing every command', () => {
    expect(matchesAllowedTool('Bash', bash('rm -rf x'), ['Bash'], repo.path)).toBe(false);
  });
});

describe('matchesAllowedTool: gate command', () => {
  it.each<[string, string, string, boolean]>([
    ['compound gate, same text', 'pnpm lint && pnpm test', 'pnpm lint && pnpm test', true],
    ['compound gate, one half', 'pnpm lint && pnpm test', 'pnpm lint', false],
    [
      'compound gate, with an extra step',
      'pnpm lint && pnpm test',
      'pnpm lint && pnpm test && curl x',
      false,
    ],
    ['compound gate, other separator', 'pnpm lint && pnpm test', 'pnpm lint; pnpm test', false],
    ['quoted gate', 'make "gate"', 'make gate', true],
    ['gate run quoted', 'make gate', "make 'gate'", true],
    ['gate with trailing arguments', 'make gate', 'make gate extra', false],
    ['gate with a redirection', 'make gate', 'make gate > out', false],
  ])('%s', (_name, gateCommand, command, expected) => {
    const rules = baseAllowedTools({ gateCommand });
    expect(matchesAllowedTool('Bash', bash(command), rules, repo.path)).toBe(expected);
  });
});

describe('matchesAllowedTool: tool names', () => {
  it.each<[string, boolean]>([
    ['mcp__10db__commit', true],
    ['mcp__10db__request_claim', true],
    ['mcp__10db___evil', false],
    ['mcp__10db__', false],
    ['mcp__10db', false],
    ['mcp__10db_x__commit', false],
    ['mcp__other__x', false],
    ['xmcp__10db__commit', false],
    ['WebFetch', false],
    ['AskUserQuestion', false],
    ['Edit', true],
    ['Write', true],
  ])('%s -> %s', (tool, expected) => {
    expect(matchesAllowedTool(tool, { file_path: 'a' }, allowed, repo.path)).toBe(expected);
  });
});

describe('matchesAllowedTool: read tools stay inside the repo', () => {
  const outside = join(homedir(), '.ssh/id_rsa');
  it.each<[string, string, unknown, boolean]>([
    ['Read inside, relative', 'Read', { file_path: 'src/a.ts' }, true],
    ['Read inside, absolute', 'Read', { file_path: join(repo.path, 'a.ts') }, true],
    ['Read outside, absolute', 'Read', { file_path: outside }, false],
    ['Read outside, home shorthand', 'Read', { file_path: '~/.ssh/id_rsa' }, false],
    ['Read outside, parent', 'Read', { file_path: '../../etc/passwd' }, false],
    ['Read with a non-string path', 'Read', { file_path: 3 }, false],
    ['Glob without a path', 'Glob', { pattern: '**/*.ts' }, true],
    ['Glob inside', 'Glob', { pattern: '*.ts', path: 'src' }, true],
    ['Glob outside', 'Glob', { pattern: '*', path: outside }, false],
    [
      'Glob with an absolute pattern outside',
      'Glob',
      { pattern: join(homedir(), '.ssh/*') },
      false,
    ],
    ['Glob with a parent pattern', 'Glob', { pattern: '../*' }, false],
    ['Grep without a path', 'Grep', { pattern: 'x' }, true],
    ['Grep inside', 'Grep', { pattern: 'x', path: 'src' }, true],
    ['Grep outside', 'Grep', { pattern: 'x', path: '/etc' }, false],
    ['LS without a path', 'LS', {}, true],
    ['LS inside', 'LS', { path: repo.path }, true],
    ['LS outside', 'LS', { path: '/' }, false],
    ['LS with a non-object input', 'LS', 'x', false],
  ])('%s', (_name, tool, input, expected) => {
    expect(matchesAllowedTool(tool, input, allowed, repo.path)).toBe(expected);
  });
});

describe('commandPrefix', () => {
  it.each<[string, string | null]>([
    ['pnpm test', 'pnpm test'],
    ['docker compose up -d', 'docker compose'],
    ['FOO=1 pnpm test --watch', 'pnpm test'],
    ['git push origin main', 'git push'],
    ['ls', 'ls'],
    ['curl -s https://x', 'curl -s https://x'],
    ['cat ./file', 'cat ./file'],
    ['pnpm --filter x test', 'pnpm --filter x test'],
    ['git -c core.pager=x log', 'git -c core.pager=x log'],
    ['npx -y prettier', 'npx -y prettier'],
    ['npx prettier --write .', 'npx prettier --write .'],
    ['bash -c "curl x"', 'bash -c curl x'],
    ['sh script.sh', 'sh script.sh'],
    ['node -e x', 'node -e x'],
    ['node build.js', 'node build.js'],
    ['php evil run', 'php evil run'],
    ['nice make test', 'nice make test'],
    ['eval make test', 'eval make test'],
    ['python3 -c x', 'python3 -c x'],
    ['python3.12 tool.py', 'python3.12 tool.py'],
    ['pnpm dlx evil', 'pnpm dlx evil'],
    ['pnpm exec evil', 'pnpm exec evil'],
    ['npm exec evil', 'npm exec evil'],
    ['pnpm x bash -c "curl x"', 'pnpm x bash -c curl x'],
    ['npm x zsh -c "curl x"', 'npm x zsh -c curl x'],
    ['yarn exec bash -c "curl x"', 'yarn exec bash -c curl x'],
    ['yarn dlx sh -c "curl x"', 'yarn dlx sh -c curl x'],
    ['yarn x sh -c "curl x"', 'yarn x sh -c curl x'],
    ['bunx zsh -c "curl x"', 'bunx zsh -c curl x'],
    ['pnpx sh -c "curl x"', 'pnpx sh -c curl x'],
    ['dlx sh -c "curl x"', 'dlx sh -c curl x'],
    ['PNPM DLX sh', 'PNPM DLX sh'],
    ['bun test --watch', 'bun test --watch'],
    ['yarn test', 'yarn test'],
    ['env -u X make', 'make'],
    ['$(curl x)', null],
    ['git status `x`', null],
    ['pnpm test > out', null],
    ['pnpm test 2>&1', 'pnpm test'],
    ['git status <(x)', null],
    ['echo $HOME', null],
    ['env -S "curl x" ls', null],
    ['xargs rm', null],
    ['', null],
  ])('%s -> %j', (command, prefix) => {
    expect(commandPrefix(command)).toBe(prefix);
  });
});

describe('matchPermissionRule', () => {
  const rule = (toolName: string, pattern: string | null): PermissionRuleDto => ({
    id: mintId('PermissionRule'),
    projectId: mintId('Project'),
    workstreamId: null,
    toolName,
    pattern,
    sourceInboxId: null,
    createdAt: '2026-10-13T12:00:00.000Z',
  });
  const match = (toolName: string, input: unknown, rules: PermissionRuleDto[]): boolean =>
    matchPermissionRule({ toolName, input }, rules) !== undefined;

  it('matches a tool rule without a pattern', () => {
    expect(match('WebFetch', {}, [rule('WebFetch', null)])).toBe(true);
    expect(match('WebSearch', {}, [rule('WebFetch', null)])).toBe(false);
  });

  it('never lets a Bash rule without a pattern cover commands', () => {
    expect(match('Bash', bash('rm -rf x'), [rule('Bash', null)])).toBe(false);
  });

  it.each<[string, string, string, boolean]>([
    ['same command with more arguments', 'docker compose', 'docker compose up', true],
    ['the exact pattern', 'docker compose', 'docker compose', true],
    [
      'a second segment outside the pattern',
      'docker compose',
      'docker compose up && rm -rf build',
      false,
    ],
    ['a different subcommand', 'docker compose', 'docker run x', false],
    ['a longer first word', 'docker compose', 'docker composer x', false],
    ['a stored pnpm test rule', 'pnpm test', 'pnpm test', true],
    ['a stored pnpm test rule with flags', 'pnpm test', 'pnpm test --watch', true],
    ['a stored pnpm test rule with 2>&1', 'pnpm test', 'pnpm test 2>&1', true],
    ['a redirection', 'pnpm test', 'pnpm test > ~/.zshrc', false],
    ['a command substitution', 'pnpm test', 'pnpm test $(curl x)', false],
    ['a process substitution', 'pnpm test', 'pnpm test <(curl x)', false],
    ['a semicolon compound', 'pnpm test', 'pnpm test; curl x', false],
    ['an assignment prefix', 'pnpm test', 'GIT_PAGER=x pnpm test', false],
    ['env -S', 'pnpm test', 'env -S "curl x" pnpm test', false],
    ['xargs', 'pnpm test', 'xargs pnpm test', false],
    ['time -o', 'pnpm test', 'time -o out pnpm test', false],
    ['a background compound', 'pnpm test', 'pnpm test & curl x', false],
    ['a newline compound', 'pnpm test', 'pnpm test\ncurl x', false],
    ['an or-list', 'pnpm test', 'pnpm test || curl x', false],
    ['an empty command', 'pnpm test', '', false],
  ])('Bash rule %s (%s | %s)', (_name, pattern, command, expected) => {
    expect(match('Bash', bash(command), [rule('Bash', pattern)])).toBe(expected);
  });

  it('does not apply a Bash pattern to missing, non-string or non-object input', () => {
    const rules = [rule('Bash', 'docker compose')];
    expect(match('Bash', {}, rules)).toBe(false);
    expect(match('Bash', bash(5), rules)).toBe(false);
    expect(match('Bash', null, rules)).toBe(false);
  });

  it('does not apply a rule to another tool', () => {
    expect(match('Read', bash('docker compose up'), [rule('Bash', 'docker compose')])).toBe(false);
  });
});

describe('allowedToolsFor with the extra allowed commands of a project', () => {
  const project = {
    gateCommand: 'make gate',
    allowedCommands: ['pnpm exec prettier', 'pnpm test'],
  };
  const edit = allowedToolsFor(project, 'edit');
  const readOnly = allowedToolsFor(project, 'read_only');

  it.each<[string, string, boolean]>([
    [
      'the dogfood lane command, compound',
      'pnpm exec prettier --write a.ts && git status --short && git diff',
      true,
    ],
    ['a listed command with arguments', 'pnpm test --run', true],
    ['a listed prefix alone', 'pnpm test', true],
    ['a program that only shares the first characters', 'pnpm exec prettier-plugin-x', false],
    ['a command that is not listed', 'pnpm lint', false],
    [
      'a listed command chained to an unlisted one',
      'pnpm exec prettier --write a.ts && pnpm lint',
      false,
    ],
  ])('matches %s (%s) in an edit step: %s', (_name, command, expected) => {
    expect(matchesAllowedTool('Bash', bash(command), edit, repo.path)).toBe(expected);
  });

  it('gives no listed command to a read-only step', () => {
    expect(readOnly).not.toContain('Bash(pnpm test:*)');
    expect(matchesAllowedTool('Bash', bash('pnpm test'), readOnly, repo.path)).toBe(false);
  });
});

describe('allowedToolsFor', () => {
  const project = { gateCommand: 'make gate', allowedCommands: [] };
  it.each([
    {
      tools: 'edit',
      has: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Bash(make gate)'],
      lacks: ['Bash(cat:*)'],
    },
    {
      tools: 'read_only',
      has: [
        'Read',
        'Grep',
        'mcp__10db__*',
        'Bash(git diff:*)',
        'Bash(cat:*)',
        'Bash(cd:*)',
        'Bash(grep:*)',
      ],
      lacks: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash(make gate)', 'Bash(file:*)'],
    },
  ] as const)('gives a $tools step the right tools', ({ tools, has, lacks }) => {
    const allowed = allowedToolsFor(project, tools);
    for (const t of has) expect(allowed, t).toContain(t);
    for (const t of lacks) expect(allowed, t).not.toContain(t);
  });

  it('gives an edit step exactly the base list', () => {
    expect(allowedToolsFor(project, 'edit')).toEqual(baseAllowedTools(project));
  });
});

describe('matchesAllowedTool: cosmetic forms of an allowed command', () => {
  const listed = allowedToolsFor(
    { gateCommand: 'make gate', allowedCommands: ['pnpm exec vitest', 'pnpm exec'] },
    'edit',
  );
  const narrow = allowedToolsFor(
    { gateCommand: 'make gate', allowedCommands: ['pnpm exec vitest'] },
    'edit',
  );

  it.each<[string, string, boolean]>([
    ['the plain command', 'pnpm exec vitest run a.test.ts', true],
    ['pnpm -s before the subcommand', 'pnpm -s exec vitest run a.test.ts', true],
    ['pnpm --silent before the subcommand', 'pnpm --silent exec vitest run a.test.ts', true],
    ['a trailing echo of the exit code', 'pnpm exec vitest run a.test.ts; echo $?', true],
    ['a quoted exit-code echo', 'pnpm exec vitest run a.test.ts; echo "exit $?"', true],
    ['both forms together', 'pnpm -s exec vitest run a.test.ts; echo "typecheck exit $?"', true],
    ['an echo of plain words', 'pnpm exec vitest run; echo done', true],
    ['an echo of a variable', 'pnpm exec vitest run; echo $HOME', false],
    ['an echo of a substitution', 'pnpm exec vitest run; echo $(id)', false],
    ['an echo of a backtick substitution', 'pnpm exec vitest run; echo `id`', false],
    ['an echo redirected to a file', 'pnpm exec vitest run; echo "$?" > f', false],
    ['an echo of an exit code and a variable', 'pnpm exec vitest run; echo "$? $HOME"', false],
    ['an echo followed by another command', 'pnpm exec vitest run; echo $?; rm -rf x', false],
    ['an echo joined by &&', 'pnpm exec vitest run && echo $?', false],
    ['an echo joined by ||', 'pnpm exec vitest run || echo $?', false],
    ['an echo joined by a pipe', 'pnpm exec vitest run | echo $?', false],
    ['an echo that is not first on its line', 'pnpm exec vitest run; ls; echo $?', false],
    ['a command that is not listed with the echo', 'pnpm exec vitest run; curl x; echo $?', false],
    ['a lone exit-code echo', 'echo $?', false],
  ])('%s: %s -> %s', (_name, command, expected) => {
    expect(matchesAllowedTool('Bash', bash(command), listed, repo.path)).toBe(expected);
  });

  it.each<[string, string, boolean]>([
    ['pnpm -s with an unlisted subcommand', 'pnpm -s add evil', false],
    ['pnpm -s with a listed program', 'pnpm -s exec vitest run', true],
    ['pnpm -s exec of another program', 'pnpm -s exec evil', false],
    ['a flag after the subcommand', 'pnpm exec -s vitest', false],
  ])('against the narrow prefix, %s: %s -> %s', (_name, command, expected) => {
    expect(matchesAllowedTool('Bash', bash(command), narrow, repo.path)).toBe(expected);
  });

  it('keeps pnpm -s add evil out of the broad pnpm exec prefix', () => {
    expect(matchesAllowedTool('Bash', bash('pnpm -s add evil'), listed, repo.path)).toBe(false);
  });

  it('matches an exact rule with a trailing echo of the exit code', () => {
    expect(matchesAllowedTool('Bash', bash('make gate; echo $?'), allowed, repo.path)).toBe(true);
  });
});

describe('cosmetic forms in stored rules', () => {
  it.each<[string, string | null]>([
    ['pnpm -s test', 'pnpm test'],
    ['pnpm test; echo "exit $?"', 'pnpm test'],
    ['pnpm -s exec vitest run; echo $?', 'pnpm exec vitest run'],
    ['pnpm test; echo $HOME', null],
  ])('commandPrefix of %s is %s', (command, expected) => {
    expect(commandPrefix(command)).toBe(expected);
  });

  it('matches a stored pnpm test rule against the silent form with an echo', () => {
    const rule: PermissionRuleDto = {
      id: mintId('PermissionRule'),
      projectId: mintId('Project'),
      workstreamId: null,
      toolName: 'Bash',
      pattern: 'pnpm test',
      sourceInboxId: null,
      createdAt: '2026-10-13T12:00:00.000Z',
    };
    const req = { toolName: 'Bash', input: { command: 'pnpm -s test --run; echo $?' } };
    expect(matchPermissionRule(req, [rule])).toBe(rule);
  });
});
