import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mintId, type PermissionRuleDto } from '@10db/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import {
  allowedToolsFor,
  baseAllowedTools,
  commandPrefix,
  matchesAllowedTool,
  matchPermissionRule,
  storableRule,
} from './index';

const repo = tempDir('permissions-repo');
const away = tempDir('permissions-away');
beforeAll(() => {
  mkdirSync(join(away.path, 'sub'));
  symlinkSync(join(away.path, 'sub'), join(repo.path, 'L'));
});
afterAll(() => {
  repo.cleanup();
  away.cleanup();
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
    ['git by an absolute path is another program', '/usr/bin/git status', false],
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
    ['an escaped space does not join words', 'git\\ status', false],
    ['the same through a path prefix', './git\\ status', false],
    ['a stray closing parenthesis', 'git status )', false],
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
    ['assignment after a valued flag cluster', 'env -iu FOO GIT_PAGER=x git log'],
    ['command substitution', 'git status $(curl evil.example)'],
    ['backtick substitution', 'git status `curl evil.example`'],
    ['process substitution', 'git diff <(curl evil.example)'],
    ['variable expansion', 'git log ${IFS}'],
    ['env split-string', 'env -S "curl evil" git status'],
    ['env split-string, joined', 'env -Scurl git status'],
    ['env long split-string', 'env --split-string=curl git status'],
    ['env chdir', 'env -C /tmp git status'],
    ['env search path', 'env -P /tmp/x git status'],
    ['env search path, joined', 'env -P/tmp/x git status'],
    ['env search path in a flag cluster', 'env -iP/tmp/x git status'],
    ['a program named by an absolute path', '/tmp/x/git status'],
    ['a program named by a relative path', './evil/git status'],
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
    ['LS of a link that leads out, then its parent', 'LS', { path: 'L/..' }, false],
  ])('%s', (_name, tool, input, expected) => {
    expect(matchesAllowedTool(tool, input, allowed, repo.path)).toBe(expected);
  });
});

describe('matchesAllowedTool: scoped read entries', () => {
  const dir = realpathSync(repo.path);
  const scoped = [`Read(/${dir}/**)`, `Glob(/${dir}/**)`, `Grep(/${dir}/**)`, `LS(/${dir}/**)`];
  it.each<[string, string, unknown, boolean]>([
    ['Read inside', 'Read', { file_path: join(dir, 'a.ts') }, true],
    ['Read outside', 'Read', { file_path: join(homedir(), '.ssh/id_rsa') }, false],
    ['Glob inside', 'Glob', { pattern: '*.ts', path: dir }, true],
    ['Glob outside', 'Glob', { pattern: '*', path: '/etc' }, false],
    ['Grep inside', 'Grep', { pattern: 'x' }, true],
    ['Grep outside', 'Grep', { pattern: 'x', path: '/etc' }, false],
    ['LS inside', 'LS', { path: dir }, true],
    ['LS outside', 'LS', { path: '/' }, false],
    ['Edit is not a read entry', 'Edit', { file_path: join(dir, 'a.ts') }, false],
  ])('%s', (_name, tool, input, expected) => {
    // The repo path argument is somewhere else: the scope comes from the entry.
    expect(matchesAllowedTool(tool, input, scoped, '/nowhere')).toBe(expected);
  });

  it('does not let the Read entry cover a Grep call', () => {
    expect(matchesAllowedTool('Grep', { pattern: 'x' }, [`Read(/${dir}/**)`], '/nowhere')).toBe(
      false,
    );
  });
});

describe('commandPrefix', () => {
  it.each<[string, string | null]>([
    ['pnpm test', 'pnpm test'],
    ['docker compose up -d', 'docker compose'],
    ['FOO=1 pnpm test --watch', 'pnpm test'],
    ['git push origin main', 'git push'],
    ['ls', 'ls'],
    ['ls -la', 'ls -la'],
    ['bash', null],
    ['sh', null],
    ['node', null],
    ['python3', null],
    ['npx', null],
    ['bunx', null],
    ['dlx', null],
    ['env', null],
    ['pnpm', null],
    ['/bin/bash', null],
    ['FOO=1 bash', null],
    ['/usr/bin/env bash', null],
    ['bash -l', null],
    ['bash -x', null],
    ['bash -c', null],
    ['python3 -u', null],
    ['node --inspect', null],
    ['npx -y', null],
    ['bunx --bun', null],
    ['bun -y', null],
    ['pnpm -r', null],
    ['pnpm dlx', null],
    ['pnpm exec', null],
    ['pnpm exec -r', null],
    ['pnpm -r exec', null],
    ['pnpm --filter x exec', null],
    ['npm x', null],
    ['npm exec', null],
    ['yarn dlx', null],
    ['yarn exec', null],
    ['bun x', null],
    ['pnpm exec bash', null],
    ['pnpm exec /bin/bash', null],
    ['pnpm dlx sh', null],
    ['npm x zsh', null],
    ['npx zsh', null],
    ['bunx sh', null],
    ['yarn exec env', null],
    ['curl -s https://x', 'curl -s https://x'],
    ['cat ./file', 'cat ./file'],
    ['pnpm --filter x test', 'pnpm --filter x test'],
    ['git -c core.pager=x log', 'git -c core.pager=x log'],
    ['npx -y prettier', 'npx -y prettier'],
    ['npx -y create-vite@latest', 'npx -y create-vite@latest'],
    ['npx prettier', 'npx prettier'],
    ['npx prettier --write .', 'npx prettier --write .'],
    ['pnpm exec prettier', 'pnpm exec prettier'],
    ['pnpm --filter x exec prettier', 'pnpm --filter x exec prettier'],
    ['pnpm exec node build.js', 'pnpm exec node build.js'],
    ['pnpm -r test', 'pnpm -r test'],
    ['yarn workspace web test', 'yarn workspace web test'],
    ['npm init vite', 'npm init vite'],
    ['bun index.ts', 'bun index.ts'],
    ['bun test', 'bun test'],
    ['node --test x.js', 'node --test x.js'],
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
    ['pnpm x bash -c "curl x"', null],
    ['npm x zsh -c "curl x"', null],
    ['yarn exec bash -c "curl x"', null],
    ['yarn dlx sh -c "curl x"', null],
    ['yarn x sh -c "curl x"', null],
    ['bunx zsh -c "curl x"', null],
    ['pnpx sh -c "curl x"', null],
    ['dlx sh -c "curl x"', null],
    ['PNPM DLX sh', null],
    ['yarn workspace web exec bash -c "curl x"', null],
    ['yarn workspace web exec prettier --write .', 'yarn workspace web exec prettier --write .'],
    ['yarn workspace web test --watch', 'yarn workspace web test --watch'],
    ['yarn workspaces foreach run test', 'yarn workspaces foreach run test'],
    ['yarn workspaces run build', 'yarn workspaces run build'],
    ['pnpm recursive exec bash -c "curl x"', null],
    ['pnpm recursive exec prettier --check .', 'pnpm recursive exec prettier --check .'],
    ['pnpm recursive test', 'pnpm recursive test'],
    ['yarn node -e "curl x"', null],
    ['yarn node build.js', 'yarn node build.js'],
    ['pnpm multi exec bash -c "curl x"', null],
    ['pnpm multi exec prettier --check .', 'pnpm multi exec prettier --check .'],
    ['pnpm m exec bash -c "curl x"', null],
    ['pnpm m exec prettier --check .', 'pnpm m exec prettier --check .'],
    ['pnpm multi test', 'pnpm multi test'],
    ['npm innit foo --yes', 'npm innit foo --yes'],
    ['npm init foo --yes', 'npm init foo --yes'],
    ['npm init', null],
    ['npm init --yes', null],
    ['npm create', null],
    ['npm innit', null],
    ['pnpm create', null],
    ['yarn create', null],
    ['bun create', null],
    ['bun c', null],
    ['yarn workspace', null],
    ['yarn workspace web', null],
    ['YARN WORKSPACE web', null],
    ['yarn workspaces', null],
    ['yarn workspaces foreach', null],
    ['yarn node', null],
    ['pnpm recursive', null],
    ['pnpm multi', null],
    ['pnpm m', null],
    ['pnpm recursive -r', null],
    ['pnpm recursive exec', null],
    ['yarn workspace web exec', null],
    ['yarn workspace web exec bash', null],
    ['npm create vite@latest my-app', 'npm create vite@latest my-app'],
    ['pnpm create vite my-app', 'pnpm create vite my-app'],
    ['yarn create vite my-app', 'yarn create vite my-app'],
    ['YARN WORKSPACE web test', 'YARN WORKSPACE web test'],
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
    ['env -P /tmp/x git status', null],
    ['env -P/tmp/x git status', null],
    ['env -iP/tmp/x git status', null],
    ["env --split='git status'", null],
    ['env --uns X git status', null],
    ['env --frob git status', null],
    ['env -u FOO git status', 'git status'],
    ['env --unset FOO git status', 'git status'],
    ['/tmp/x/git status', '/tmp/x/git status'],
    ['./evil/git status', './evil/git status'],
    ['./gradlew build', './gradlew build'],
    ['/usr/local/bin/pnpm exec evil', '/usr/local/bin/pnpm exec evil'],
    ['xargs rm', null],
    ['', null],
    ['git\\ status', null],
    ["'git status'", null],
    ['git status )', null],
    ["echo 'a", null],
    ['echo ${x:-a <<EOF}', null],
    ['git status --short', 'git status'],
    ['git status && git log', 'git status'],
    ['bash -c "curl x"', null],
    ["rm -f '#'", null],
    ["rm -f '}'", null],
    ["make 'gate;curl'", null],
    ["rm -rf 'a&&b'", null],
    ["chmod -R '777 /'", null],
    ["rm -f 'a b'", null],
    ["pnpm exec vitest run -t 'a b'", null],
    ["grep -rn 'foo bar' src", null],
    ["git -C 'my dir' status", null],
    ["git 'a b'", null],
    ["rm -rf '~'", null],
    ["cp evil.sh '=node'", null],
    ["rm -f '=node'", null],
    ["'=git' status", null],
    ["ls 'a:=b'", null],
    ['pnpm exec vitest --config=x.ts', 'pnpm exec vitest --config=x.ts'],
    ["rm -f 'a*'", null],
    ["rm -f '{a,b}'", null],
    ["ls '[ab]'", null],
    ['git log --oneline -5', 'git log'],
    [
      'pnpm --filter @10db/daemon exec vitest run src/x.test.ts',
      'pnpm --filter @10db/daemon exec vitest run src/x.test.ts',
    ],
    ["rm -f $'a\\nb'", null],
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

  describe('with real paths', () => {
    const rulesFor = (...rules: PermissionRuleDto[]) => rules;
    const matchPaths = (
      toolName: string,
      input: unknown,
      rules: PermissionRuleDto[],
      realPaths: string[],
    ): boolean => matchPermissionRule({ toolName, input }, rules, { realPaths }) !== undefined;

    it.each<[string, string, unknown, string | null, boolean]>([
      [
        'a host rule matches the host in any case',
        'SandboxNetworkAccess',
        { host: 'Registry.NPMJS.org' },
        'registry.npmjs.org',
        true,
      ],
      [
        'a host rule does not match another host',
        'SandboxNetworkAccess',
        { host: 'evil.com' },
        'registry.npmjs.org',
        false,
      ],
      [
        'a host rule does not match a suffix of the host',
        'SandboxNetworkAccess',
        { host: 'x.registry.npmjs.org' },
        'registry.npmjs.org',
        false,
      ],
      [
        'a host rule does not match without a host',
        'SandboxNetworkAccess',
        {},
        'registry.npmjs.org',
        false,
      ],
      [
        'a host rule without a pattern matches nothing',
        'SandboxNetworkAccess',
        { host: 'evil.com' },
        null,
        false,
      ],
    ])('%s', (_name, tool, input, pattern, expected) => {
      expect(matchPaths(tool, input, rulesFor(rule('SandboxNetworkAccess', pattern)), [])).toBe(
        expected,
      );
    });

    it.each<[string, string, string[], boolean]>([
      ['Read of the path itself', 'Read', ['/p/a'], true],
      ['Read under the path', 'Read', ['/p/a/b/c'], true],
      ['Read of a sibling that shares the prefix', 'Read', ['/p/ab'], false],
      ['Read of the parent', 'Read', ['/p'], false],
      ['Grep under the path', 'Grep', ['/p/a/x'], true],
      ['Glob under the path, every path covered', 'Glob', ['/p/a/x', '/p/a/y'], true],
      ['Glob with one path outside', 'Glob', ['/p/a/x', '/q'], false],
      ['LS under the path', 'LS', ['/p/a'], true],
      ['Read with no path', 'Read', [], false],
    ])('a Read rule on /p/a: %s', (_name, tool, realPaths, expected) => {
      expect(matchPaths(tool, {}, rulesFor(rule('Read', '/p/a')), realPaths)).toBe(expected);
    });

    it('a patterned Read rule matches nothing without real paths', () => {
      expect(match('Read', { file_path: '/p/a' }, [rule('Read', '/p/a')])).toBe(false);
    });

    it.each<[string, string, string[], boolean]>([
      ['the same tool on the same path', 'Edit', ['/r/.vscode/settings.json'], true],
      ['the same tool on another path', 'Edit', ['/r/.claude/hooks/x'], false],
      ['a path under it', 'Edit', ['/r/.vscode/settings.json/x'], false],
      ['another tool on the same path', 'Write', ['/r/.vscode/settings.json'], false],
      ['no real path', 'Edit', [], false],
      ['two real paths', 'Edit', ['/r/.vscode/settings.json', '/r/.vscode/settings.json'], false],
    ])('an Edit rule on one file: %s', (_name, tool, realPaths, expected) => {
      expect(
        matchPaths(tool, {}, rulesFor(rule('Edit', '/r/.vscode/settings.json')), realPaths),
      ).toBe(expected);
    });

    it('a Read rule without a pattern still covers only a Read', () => {
      expect(match('Read', {}, [rule('Read', null)])).toBe(true);
      expect(match('Grep', {}, [rule('Read', null)])).toBe(false);
    });
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
    ['env -P sets the search path', 'git status', 'env -P/tmp/x git status', false],
    ['env -P with its value apart', 'git status', 'env -P /tmp/x git status', false],
    ['env -P in a flag cluster', 'git status', 'env -iP/tmp/x git status', false],
    ['env -S in a flag cluster', 'git status', "env -iS 'rm -rf ~' git status", false],
    ['env -S alone', 'git status', "env -S 'git status'", false],
    ['env --split-string', 'git status', "env --split-string='git status'", false],
    ['env --split-string abbreviated', 'git status', "env --split='rm -rf ~' git status", false],
    ['env --split= alone', 'git status', "env --split='git status'", false],
    ['env with an abbreviated long option', 'git status', 'env --uns X git status', false],
    ['env with an unknown long option', 'git status', 'env --frob git status', false],
    ['control: env -u', 'git status', 'env -u FOO git status', true],
    ['control: env --unset in full', 'git status', 'env --unset FOO git status', true],
    ['a program named by an absolute path', 'git status', '/tmp/x/git status', false],
    ['a program named by a relative path', 'git status', './evil/git status', false],
    ['a path-qualified rule covers itself', './gradlew build', './gradlew build --info', true],
    ['a path-qualified rule is not the bare name', './gradlew build', 'gradlew build', false],
    ['a path-qualified rule is not another path', './gradlew build', '/tmp/x/gradlew build', false],
    ['xargs', 'pnpm test', 'xargs pnpm test', false],
    ['time -o', 'pnpm test', 'time -o out pnpm test', false],
    ['a background compound', 'pnpm test', 'pnpm test & curl x', false],
    ['a newline compound', 'pnpm test', 'pnpm test\ncurl x', false],
    ['an or-list', 'pnpm test', 'pnpm test || curl x', false],
    ['an empty command', 'pnpm test', '', false],
    ['an escaped space does not join words', 'git status', 'git\\ status', false],
    ['the same through a path prefix', 'git status', './git\\ status', false],
    ['a quoted word is one word', 'git status', "'git status'", false],
    ['an unclosed quote', 'echo', "echo 'a", false],
    ['a stray closing parenthesis', 'git status', 'git status )', false],
    ['an unclosed double quote', 'git status', 'git status "', false],
    ['control: a here-document hidden in an expansion', 'echo', 'echo ${x:-a <<EOF}', false],
    ['control: a here-document word with a bracket', 'cat', 'cat x[<<EOF', false],
    ['control: a here-string attached to a word', 'cat', 'cat<<<$(id)', false],
    ['a legacy rule stored from a quoted hash', 'rm -f #', 'rm -f ~/.zshrc', false],
    ['a legacy rule stored from a quoted brace', 'rm -f }', 'rm -f x', false],
    ['a legacy rule stored from a quoted tilde', 'rm -rf ~', 'rm -rf ~', false],
    ['a legacy rule stored from a quoted equals word', 'cp x =node', 'cp x =node', false],
    ['a legacy rule stored from a quoted glob', 'rm -f a*', 'rm -f a*', false],
    ['an ANSI-C escape is uncertain', 'git', "$'gi\\t'", false],
    [
      'a stored pattern of several segments',
      'git status && git log',
      'git status && git status',
      false,
    ],
    ['control: a plain command with flags', 'git status', 'git status --short', true],
    [
      'control: two plain segments, both covered',
      'git status',
      'git status && git status -s',
      true,
    ],
  ])('Bash rule %s (%s | %s)', (_name, pattern, command, expected) => {
    expect(match('Bash', bash(command), [rule('Bash', pattern)])).toBe(expected);
  });

  it.each<[string, string, boolean]>([
    [
      'the forwarded command it was stored from',
      'yarn workspace web exec prettier --write .',
      true,
    ],
    [
      'another command forwarded to the same workspace',
      'yarn workspace web exec eslint --fix .',
      false,
    ],
    ['the same command in another workspace', 'yarn workspace api exec prettier --write .', false],
  ])('a rule stored for a yarn workspace command covers %s (%s)', (_name, command, expected) => {
    const stored = commandPrefix('yarn workspace web exec prettier --write .');
    expect(match('Bash', bash(command), [rule('Bash', stored)])).toBe(expected);
  });

  it.each<[string, string, string, boolean]>([
    ['an ordinary one-word command keeps its rule', 'ls', 'ls -la', true],
    ['a bare shell', 'bash', 'bash -c "curl x"', false],
    ['a bare package runner', 'npx', 'npx evil', false],
    ['a bare package tool', 'pnpm', 'pnpm exec bash -c "curl x"', false],
    ['a program subcommand with no program', 'pnpm exec', 'pnpm exec bash -c "curl x"', false],
    ['a bare runner with a flag', 'bash -l', 'bash -l -c "curl x"', false],
    ['a bare package creator', 'npm init', 'npm init evil-pkg', false],
    [
      'a bare workspace forwarding form',
      'yarn workspace web',
      'yarn workspace web exec bash -c "curl x"',
      false,
    ],
  ])('a stored rule for %s: %s covers %s -> %s', (_name, pattern, command, expected) => {
    expect(match('Bash', bash(command), [rule('Bash', pattern)])).toBe(expected);
  });

  it('allows a runner command whose code has shell punctuation once only', () => {
    expect(commandPrefix('bash -c "(curl x)"')).toBeNull();
    expect(match('Bash', bash('bash -c "(curl x)"'), [rule('Bash', 'bash -c (curl x)')])).toBe(
      false,
    );
  });

  it.each<[string, string, string | null]>([
    ['nice with an abbreviated long option', 'nice --adj 5 git status', 'nice --adj 5 git status'],
    [
      'timeout with an abbreviated long option',
      'timeout --sig KILL 5 git status',
      'timeout --sig KILL 5 git status',
    ],
    [
      'stdbuf with an abbreviated long option',
      'stdbuf --out=L git status',
      'stdbuf --out=L git status',
    ],
    ['env with an unknown short flag', 'env -a x git status', null],
    ['env with an unknown letter in a cluster', 'env -iX git status', null],
    ['env with a cluster of known letters', 'env -iv git status', null],
    ['env with an abbreviated long option', 'env --uns X git status', null],
    ['env ending its options', 'env -- git status', null],
    ['time with an unknown flag', 'time -x git status', null],
    ['nohup with a flag', 'nohup --foo git status', null],
    ['exec with an unknown flag', 'exec -z git status', null],
  ])(
    'a wrapper flag outside its exact flags matches no rule: %s (%s)',
    (_name, command, stored) => {
      expect(match('Bash', bash(command), [rule('Bash', 'git status')])).toBe(false);
      expect(
        matchesAllowedTool('Bash', bash(command), baseAllowedTools({ gateCommand: 'x' }), '/r'),
      ).toBe(false);
      // nice, timeout and stdbuf stay the command, so their whole words cover only themselves.
      expect(commandPrefix(command)).toBe(stored);
    },
  );

  it.each<[string, string | null, boolean]>([
    ['env -u FOO git status', 'git status', true],
    ['env -uFOO git status', 'git status', true],
    ['env --unset=FOO git status', 'git status', true],
    ['env -i git status', 'git status', true],
    ['time -p git status', 'git status', true],
    ['exec -a x git status', 'git status', true],
    ['nohup git status', 'git status', true],
    ['nice -n 5 git status', 'nice -n 5 git status', false],
    ['timeout 5 git status', 'timeout 5 git status', false],
  ])('control: %s stores %j and matches a git status rule: %s', (command, stored, matches) => {
    expect(commandPrefix(command)).toBe(stored);
    expect(match('Bash', bash(command), [rule('Bash', 'git status')])).toBe(matches);
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

  it('scopes the read tools to the real checkout when sandboxed', () => {
    const checkout = realpathSync(repo.path);
    const scope = `/${checkout}/**`;
    const sandboxed = { sandboxed: { checkout: repo.path } };
    expect(allowedToolsFor(project, 'edit', sandboxed)).toEqual(
      baseAllowedTools(project).map((entry) =>
        ['Read', 'Glob', 'Grep', 'LS'].includes(entry) ? `${entry}(${scope})` : entry,
      ),
    );
    const readOnly = allowedToolsFor(project, 'read_only', sandboxed);
    for (const tool of ['Read', 'Glob', 'Grep', 'LS']) {
      expect(readOnly).toContain(`${tool}(${scope})`);
      expect(readOnly).not.toContain(tool);
    }
  });

  it('names the real path when the checkout is reached through a link', () => {
    const linked = join(away.path, 'via');
    symlinkSync(repo.path, linked);
    const real = realpathSync(repo.path);
    expect(allowedToolsFor(project, 'edit', { sandboxed: { checkout: linked } })).toContain(
      `Read(/${real}/**)`,
    );
  });

  it('leaves the list alone without the option', () => {
    expect(allowedToolsFor(project, 'edit', {})).toEqual(allowedToolsFor(project, 'edit'));
  });
});

describe('storableRule', () => {
  it.each<[string, string, string, { toolName: string; pattern: string | null } | undefined]>([
    [
      'a Bash command takes its prefix',
      'Bash',
      'pnpm test --run',
      { toolName: 'Bash', pattern: 'pnpm test' },
    ],
    ['a Bash command with no safe prefix stores nothing', 'Bash', 'echo $HOME', undefined],
    [
      'a host is lower-cased',
      'SandboxNetworkAccess',
      'Registry.NPMJS.org',
      { toolName: 'SandboxNetworkAccess', pattern: 'registry.npmjs.org' },
    ],
    ['Read keeps its path', 'Read', '/a/b.ts', { toolName: 'Read', pattern: '/a/b.ts' }],
    ['Grep is stored as Read', 'Grep', '/a/b', { toolName: 'Read', pattern: '/a/b' }],
    ['Glob is stored as Read', 'Glob', '/a/b', { toolName: 'Read', pattern: '/a/b' }],
    ['LS is stored as Read', 'LS', '/a/b', { toolName: 'Read', pattern: '/a/b' }],
    ['a relative read path stores nothing', 'Read', 'a/b.ts', undefined],
    ['a read path with a glob stores nothing', 'Read', '/a/*', undefined],
    ['a read path with a brace stores nothing', 'Read', '/a/{b,c}', undefined],
    ['Edit keeps its tool and path', 'Edit', '/a/b.ts', { toolName: 'Edit', pattern: '/a/b.ts' }],
    [
      'Write keeps its tool and path',
      'Write',
      '/a/b.ts',
      { toolName: 'Write', pattern: '/a/b.ts' },
    ],
    [
      'MultiEdit keeps its tool and path',
      'MultiEdit',
      '/a/b',
      { toolName: 'MultiEdit', pattern: '/a/b' },
    ],
    [
      'NotebookEdit keeps its tool and path',
      'NotebookEdit',
      '/a/b.ipynb',
      { toolName: 'NotebookEdit', pattern: '/a/b.ipynb' },
    ],
    ['an edit of a relative path stores nothing', 'Edit', 'b.ts', undefined],
    [
      'any other tool has no pattern',
      'WebFetch',
      '{"url":"x"}',
      { toolName: 'WebFetch', pattern: null },
    ],
  ])('%s', (_name, toolName, summary, expected) => {
    expect(storableRule(toolName, summary)).toEqual(expected);
  });
});
