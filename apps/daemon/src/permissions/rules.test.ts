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
  mcpGrantRules,
  mcpServerPattern,
  mcpToolGrant,
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
  it('allows only plain read-only git, pwd, the gate, and wrappers that change nothing', () => {
    const rows: [string, string, boolean][] = [
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
      ['env without a value flag', 'env git status', true],
      ['time without flags', 'time git status', true],
      ['nohup', 'nohup git status', true],
    ];
    for (const [name, command, expected] of rows) {
      expect
        .soft(matchesAllowedTool('Bash', bash(command), allowed, repo.path), `${name}: ${command}`)
        .toBe(expected);
    }
  });
});

describe('matchesAllowedTool: shell forms that are not plain', () => {
  it('allows no shell form that is not plain', () => {
    const rows: [string, string][] = [
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
    ];
    for (const [name, command] of rows) {
      expect
        .soft(matchesAllowedTool('Bash', bash(command), allowed, repo.path), `${name}: ${command}`)
        .toBe(false);
    }
  });

  it('allows no Bash call without a command string, and a bare Bash entry allows nothing', () => {
    const rows: [string, unknown][] = [
      ['missing command', {}],
      ['non-string command', { command: 42 }],
      ['non-object input', 'git status'],
      ['null input', null],
    ];
    for (const [name, input] of rows) {
      expect.soft(matchesAllowedTool('Bash', input, allowed, repo.path), name).toBe(false);
    }
    expect
      .soft(matchesAllowedTool('Bash', bash('rm -rf x'), ['Bash'], repo.path), 'a bare Bash entry')
      .toBe(false);
  });
});

describe('matchesAllowedTool: gate command', () => {
  it('allows the gate command exactly as the project names it', () => {
    const rows: [string, string, string, boolean][] = [
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
    ];
    for (const [name, gateCommand, command, expected] of rows) {
      const rules = baseAllowedTools({ gateCommand });
      expect
        .soft(
          matchesAllowedTool('Bash', bash(command), rules, repo.path),
          `${name}: ${gateCommand} | ${command}`,
        )
        .toBe(expected);
    }
  });
});

describe('matchesAllowedTool: tool names', () => {
  it("allows the file tools and 10db's own MCP tools by name, and nothing that only looks like them", () => {
    const rows: [string, boolean][] = [
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
    ];
    for (const [tool, expected] of rows) {
      expect
        .soft(matchesAllowedTool(tool, { file_path: 'a' }, allowed, repo.path), tool)
        .toBe(expected);
    }
  });
});

describe('matchesAllowedTool: read tools stay inside the repo', () => {
  const outside = join(homedir(), '.ssh/id_rsa');
  it('allows a read tool only on paths inside the repo', () => {
    const rows: [string, string, unknown, boolean][] = [
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
    ];
    for (const [name, tool, input, expected] of rows) {
      expect
        .soft(
          matchesAllowedTool(tool, input, allowed, repo.path),
          `${name}: ${JSON.stringify(input)}`,
        )
        .toBe(expected);
    }
  });
});

describe('matchesAllowedTool: scoped read entries', () => {
  const dir = realpathSync(repo.path);
  const scoped = [`Read(/${dir}/**)`, `Glob(/${dir}/**)`, `Grep(/${dir}/**)`, `LS(/${dir}/**)`];
  it('allows each read tool only inside the directory its own entry names', () => {
    const rows: [string, string, unknown, boolean][] = [
      ['Read inside', 'Read', { file_path: join(dir, 'a.ts') }, true],
      ['Read outside', 'Read', { file_path: join(homedir(), '.ssh/id_rsa') }, false],
      ['Glob inside', 'Glob', { pattern: '*.ts', path: dir }, true],
      ['Glob outside', 'Glob', { pattern: '*', path: '/etc' }, false],
      ['Grep inside', 'Grep', { pattern: 'x' }, true],
      ['Grep outside', 'Grep', { pattern: 'x', path: '/etc' }, false],
      ['LS inside', 'LS', { path: dir }, true],
      ['LS outside', 'LS', { path: '/' }, false],
      ['Edit is not a read entry', 'Edit', { file_path: join(dir, 'a.ts') }, false],
    ];
    for (const [name, tool, input, expected] of rows) {
      // The repo path argument is somewhere else: the scope comes from the entry.
      expect
        .soft(
          matchesAllowedTool(tool, input, scoped, '/nowhere'),
          `${name}: ${JSON.stringify(input)}`,
        )
        .toBe(expected);
    }
    expect
      .soft(
        matchesAllowedTool('Grep', { pattern: 'x' }, [`Read(/${dir}/**)`], '/nowhere'),
        'the Read entry does not cover a Grep call',
      )
      .toBe(false);
  });
});

describe('commandPrefix', () => {
  it('stores the words a rule may cover, and nothing for a runner, a bare creator or a form it cannot read', () => {
    const rows: [string, string | null][] = [
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
      // A flag whose value the guard cannot place: the command is allowed once only.
      ['pnpm --package foo dlx bash', null],
      ['pnpm --package foo dlx', null],
      ['pnpm --prefix d exec', null],
      ['pnpm --prefix d exec bash', null],
      ['pnpm --config c exec bash', null],
      ['pnpm -p d exec bash', null],
      ['yarn --prefix d dlx', null],
      ['yarn -C d dlx bash', null],
    ];
    for (const [command, prefix] of rows) {
      expect.soft(commandPrefix(command), command).toBe(prefix);
    }
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
    foundIn: null,
    createdAt: '2026-10-13T12:00:00.000Z',
  });
  const match = (toolName: string, input: unknown, rules: PermissionRuleDto[]): boolean =>
    matchPermissionRule({ toolName, input }, rules) !== undefined;

  const matchPaths = (
    toolName: string,
    input: unknown,
    rules: PermissionRuleDto[],
    realPaths: string[],
  ): boolean => matchPermissionRule({ toolName, input }, rules, { realPaths }) !== undefined;

  it('lets a rule without a pattern cover only its own tool, and no path outside the checkout or protected, and no command', () => {
    expect
      .soft(match('WebFetch', {}, [rule('WebFetch', null)]), 'WebFetch rule, WebFetch')
      .toBe(true);
    expect
      .soft(match('WebSearch', {}, [rule('WebFetch', null)]), 'WebFetch rule, WebSearch')
      .toBe(false);
    // A network rule without a pattern allows every host outside the sandbox, as it always did.
    expect
      .soft(
        match('SandboxNetworkAccess', { host: 'evil.com' }, [rule('SandboxNetworkAccess', null)]),
        'network rule, any host',
      )
      .toBe(true);
    expect
      .soft(
        match('SandboxNetworkAccess', { host: 'evil.com' }, [rule('WebFetch', null)]),
        'WebFetch rule, a network ask',
      )
      .toBe(false);
    const rows: [string, string, string[]][] = [
      ['a Read rule without a pattern allows nothing outside the checkout', 'Read', ['/outside/x']],
      [
        'an Edit rule without a pattern allows no edit of a protected path',
        'Edit',
        ['/r/.claude/hooks/x'],
      ],
      [
        'a Write rule without a pattern allows no edit of a protected path',
        'Write',
        ['/r/.claude/hooks/x'],
      ],
    ];
    for (const [name, tool, realPaths] of rows) {
      expect.soft(matchPaths(tool, {}, [rule(tool, null)], realPaths), name).toBe(false);
      expect.soft(match(tool, {}, [rule(tool, null)]), `${name}, without real paths`).toBe(true);
    }
    expect.soft(match('Read', {}, [rule('Read', null)]), 'Read rule, Read').toBe(true);
    expect.soft(match('Grep', {}, [rule('Read', null)]), 'Read rule, Grep').toBe(false);
    expect
      .soft(match('Bash', bash('rm -rf x'), [rule('Bash', null)]), 'Bash rule, any command')
      .toBe(false);
  });

  describe('with real paths', () => {
    const rulesFor = (...rules: PermissionRuleDto[]) => rules;

    it('matches a host rule as the sandbox reads hosts', () => {
      const rows: [string, string, unknown, string | null, boolean][] = [
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
          'a *. rule matches a subdomain, as the sandbox reads it',
          'SandboxNetworkAccess',
          { host: 'Index.Crates.io' },
          '*.crates.io',
          true,
        ],
        [
          'a *. rule matches a deeper subdomain',
          'SandboxNetworkAccess',
          { host: 'a.b.crates.io' },
          '*.crates.io',
          true,
        ],
        [
          'a *. rule does not match the domain itself',
          'SandboxNetworkAccess',
          { host: 'crates.io' },
          '*.crates.io',
          false,
        ],
        [
          'a *. rule does not match a host that only ends in the same letters',
          'SandboxNetworkAccess',
          { host: 'evilcrates.io' },
          '*.crates.io',
          false,
        ],
        [
          'a *. rule does not match an address',
          'SandboxNetworkAccess',
          { host: '10.0.0.1' },
          '*.0.1',
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
      ];
      for (const [name, tool, input, pattern, expected] of rows) {
        expect
          .soft(matchPaths(tool, input, rulesFor(rule('SandboxNetworkAccess', pattern)), []), name)
          .toBe(expected);
      }
    });

    it('lets a Read rule on /p/a cover reads of it and under it, given their real paths', () => {
      const rows: [string, string, string[], boolean][] = [
        ['Read of the path itself', 'Read', ['/p/a'], true],
        ['Read under the path', 'Read', ['/p/a/b/c'], true],
        ['Read of a sibling that shares the prefix', 'Read', ['/p/ab'], false],
        ['Read of the parent', 'Read', ['/p'], false],
        ['Grep under the path', 'Grep', ['/p/a/x'], true],
        ['Glob under the path, every path covered', 'Glob', ['/p/a/x', '/p/a/y'], true],
        ['Glob with one path outside', 'Glob', ['/p/a/x', '/q'], false],
        ['LS under the path', 'LS', ['/p/a'], true],
        ['Read with no path', 'Read', [], false],
      ];
      for (const [name, tool, realPaths, expected] of rows) {
        expect
          .soft(matchPaths(tool, {}, rulesFor(rule('Read', '/p/a')), realPaths), name)
          .toBe(expected);
      }
      expect
        .soft(
          match('Read', { file_path: '/p/a' }, [rule('Read', '/p/a')]),
          'a patterned Read rule matches nothing without real paths',
        )
        .toBe(false);
    });

    it('lets an Edit rule on one file cover only that tool on that one real path', () => {
      const rows: [string, string, string[], boolean][] = [
        ['the same tool on the same path', 'Edit', ['/r/.vscode/settings.json'], true],
        ['the same tool on another path', 'Edit', ['/r/.claude/hooks/x'], false],
        ['a path under it', 'Edit', ['/r/.vscode/settings.json/x'], false],
        ['another tool on the same path', 'Write', ['/r/.vscode/settings.json'], false],
        ['no real path', 'Edit', [], false],
        ['two real paths', 'Edit', ['/r/.vscode/settings.json', '/r/.vscode/settings.json'], false],
      ];
      for (const [name, tool, realPaths, expected] of rows) {
        expect
          .soft(
            matchPaths(tool, {}, rulesFor(rule('Edit', '/r/.vscode/settings.json')), realPaths),
            name,
          )
          .toBe(expected);
      }
    });
  });

  it('lets a Bash rule cover only plain commands that start with its words', () => {
    const rows: [string, string, string, boolean][] = [
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
      [
        'a path-qualified rule is not another path',
        './gradlew build',
        '/tmp/x/gradlew build',
        false,
      ],
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
      // A stored rule for a bare runner, creator or forwarding form covers no command it runs.
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
    ];
    for (const [name, pattern, command, expected] of rows) {
      expect
        .soft(
          match('Bash', bash(command), [rule('Bash', pattern)]),
          `${name}: ${pattern} | ${command}`,
        )
        .toBe(expected);
    }
  });

  it('lets a rule stored for a yarn workspace command cover only that forwarded command', () => {
    const rows: [string, string, boolean][] = [
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
      [
        'the same command in another workspace',
        'yarn workspace api exec prettier --write .',
        false,
      ],
    ];
    const stored = commandPrefix('yarn workspace web exec prettier --write .');
    for (const [name, command, expected] of rows) {
      expect
        .soft(match('Bash', bash(command), [rule('Bash', stored)]), `${name}: ${command}`)
        .toBe(expected);
    }
  });

  it('allows a runner command whose code has shell punctuation once only', () => {
    expect(commandPrefix('bash -c "(curl x)"')).toBeNull();
    expect(match('Bash', bash('bash -c "(curl x)"'), [rule('Bash', 'bash -c (curl x)')])).toBe(
      false,
    );
  });

  it('lets a wrapper flag outside its exact flags match no rule', () => {
    const rows: [string, string, string | null][] = [
      [
        'nice with an abbreviated long option',
        'nice --adj 5 git status',
        'nice --adj 5 git status',
      ],
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
    ];
    for (const [name, command, stored] of rows) {
      const label = `${name}: ${command}`;
      expect.soft(match('Bash', bash(command), [rule('Bash', 'git status')]), label).toBe(false);
      expect
        .soft(
          matchesAllowedTool('Bash', bash(command), baseAllowedTools({ gateCommand: 'x' }), '/r'),
          label,
        )
        .toBe(false);
      // nice, timeout and stdbuf stay the command, so their whole words cover only themselves.
      expect.soft(commandPrefix(command), label).toBe(stored);
    }
  });

  it('control: wrappers that change nothing store and match the command they run', () => {
    const rows: [string, string | null, boolean][] = [
      ['env -u FOO git status', 'git status', true],
      ['env -uFOO git status', 'git status', true],
      ['env --unset=FOO git status', 'git status', true],
      ['env -i git status', 'git status', true],
      ['time -p git status', 'git status', true],
      ['exec -a x git status', 'git status', true],
      ['nohup git status', 'git status', true],
      ['nice -n 5 git status', 'nice -n 5 git status', false],
      ['timeout 5 git status', 'timeout 5 git status', false],
    ];
    for (const [command, stored, matches] of rows) {
      expect.soft(commandPrefix(command), `${command} stores`).toBe(stored);
      expect
        .soft(match('Bash', bash(command), [rule('Bash', 'git status')]), `${command} matches`)
        .toBe(matches);
    }
  });

  it('does not apply a Bash pattern to input without a command string, or to another tool', () => {
    const rules = [rule('Bash', 'docker compose')];
    expect.soft(match('Bash', {}, rules), 'missing command').toBe(false);
    expect.soft(match('Bash', bash(5), rules), 'non-string command').toBe(false);
    expect.soft(match('Bash', null, rules), 'non-object input').toBe(false);
    expect.soft(match('Read', bash('docker compose up'), rules), 'another tool').toBe(false);
  });
});

describe('a project rule for every tool an approved MCP server listed', () => {
  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);
  const rule = (toolName: string, pattern: string | null): PermissionRuleDto => ({
    id: mintId('PermissionRule'),
    projectId: mintId('Project'),
    workstreamId: null,
    toolName,
    pattern,
    sourceInboxId: null,
    foundIn: null,
    createdAt: '2026-11-05T12:00:00.000Z',
  });
  const COST = 'mcp__aws-billing__cost-explorer';
  const granted = [
    rule(COST, mcpServerPattern('aws-billing', HASH_A)),
    rule('mcp__aws-billing__credits', mcpServerPattern('aws-billing', HASH_A)),
  ];
  const runs = (
    toolName: string,
    rules: PermissionRuleDto[],
    approved?: Record<string, string>,
    paths?: { realPaths: string[] },
  ): boolean => matchPermissionRule({ toolName, input: {} }, rules, paths, approved) !== undefined;

  it('lets a grant cover only the tools the approved server listed, while its config is unchanged', () => {
    const rows: [
      string,
      string,
      PermissionRuleDto[],
      Record<string, string> | undefined,
      { realPaths: string[] } | undefined,
      boolean,
    ][] = [
      [
        'a listed tool, config unchanged',
        COST,
        granted,
        { 'aws-billing': HASH_A },
        undefined,
        true,
      ],
      [
        'another listed tool of the server',
        'mcp__aws-billing__credits',
        granted,
        { 'aws-billing': HASH_A },
        undefined,
        true,
      ],
      [
        'in a sandboxed lane (real paths in hand)',
        COST,
        granted,
        { 'aws-billing': HASH_A },
        { realPaths: [] },
        true,
      ],
      [
        'a tool the server added after the answer',
        'mcp__aws-billing__session-sql',
        granted,
        { 'aws-billing': HASH_A },
        undefined,
        false,
      ],
      ['the approved config changed', COST, granted, { 'aws-billing': HASH_B }, undefined, false],
      ['the server is not approved in this session', COST, granted, {}, undefined, false],
      ['no approvals given', COST, granted, undefined, undefined, false],
      [
        'another server with the same tool name',
        'mcp__other__cost-explorer',
        granted,
        { 'aws-billing': HASH_A, other: HASH_A },
        undefined,
        false,
      ],
      [
        'a rule whose pattern names a different server than its tool',
        'mcp__other__x',
        [rule('mcp__other__x', mcpServerPattern('aws-billing', HASH_A))],
        { 'aws-billing': HASH_A, other: HASH_A },
        undefined,
        false,
      ],
      [
        'a rule whose pattern is not a server grant',
        COST,
        [rule(COST, '/etc')],
        { 'aws-billing': HASH_A },
        undefined,
        false,
      ],
      [
        'a legacy single-tool rule with no pattern still allows its tool',
        COST,
        [rule(COST, null)],
        undefined,
        undefined,
        true,
      ],
      [
        'a legacy single-tool rule does not cover a sibling tool',
        'mcp__aws-billing__credits',
        [rule(COST, null)],
        { 'aws-billing': HASH_A },
        undefined,
        false,
      ],
    ];
    for (const [name, tool, rules, approved, paths, expected] of rows) {
      expect.soft(runs(tool, rules, approved, paths), `${name}: ${tool}`).toBe(expected);
    }
    // A grant pattern never allows a non-MCP tool.
    const forBash = [rule('Bash', mcpServerPattern('aws-billing', HASH_A))];
    expect
      .soft(
        matchPermissionRule({ toolName: 'Bash', input: { command: 'ls' } }, forBash, undefined, {
          'aws-billing': HASH_A,
        }),
        'a grant pattern on a Bash rule',
      )
      .toBeUndefined();
  });

  describe('mcpToolGrant: what a card offers', () => {
    const approved = { 'aws-billing': HASH_A, other: HASH_B, a: HASH_A, a__b: HASH_B };
    const listed = [
      'Bash',
      'Read',
      'mcp__10db__commit',
      'mcp__aws-billing__cost-explorer',
      'mcp__aws-billing__credits',
      'mcp__other__cost-explorer',
    ];

    it('offers every listed tool of an approved server, and nothing else', () => {
      const rows: [string, string, string[], ReturnType<typeof mcpToolGrant>][] = [
        [
          'a tool of an approved server gets every tool the server listed',
          COST,
          listed,
          {
            name: 'aws-billing',
            configHash: HASH_A,
            tools: ['mcp__aws-billing__cost-explorer', 'mcp__aws-billing__credits'],
          },
        ],
        ['a tool the server did not list gets no grant', 'mcp__aws-billing__new', listed, null],
        ['Bash gets no grant', 'Bash', listed, null],
        ['a file tool gets no grant', 'Read', listed, null],
        ['a network ask gets no grant', 'SandboxNetworkAccess', listed, null],
        ["10db's own server gets no grant", 'mcp__10db__commit', listed, null],
        [
          'a server with no approval in the session gets no grant',
          'mcp__stranger__x',
          ['mcp__stranger__x'],
          null,
        ],
        ['a bare server prefix is not a tool', 'mcp__aws-billing__', ['mcp__aws-billing__'], null],
        [
          'the longest server name wins',
          'mcp__a__b__x',
          ['mcp__a__b__x', 'mcp__a__y'],
          { name: 'a__b', configHash: HASH_B, tools: ['mcp__a__b__x'] },
        ],
      ];
      for (const [name, tool, tools, expected] of rows) {
        expect.soft(mcpToolGrant(tool, tools, approved), `${name}: ${tool}`).toEqual(expected);
      }
      // A server name is read as Claude Code writes it in a tool name.
      expect
        .soft(
          mcpToolGrant('mcp__my_server__go', ['mcp__my_server__go', 'mcp__my_server__stop'], {
            'my server': HASH_A,
          }),
          'a server name with a space',
        )
        .toEqual({
          name: 'my server',
          configHash: HASH_A,
          tools: ['mcp__my_server__go', 'mcp__my_server__stop'],
        });
    });
  });

  describe('mcpGrantRules: the rules an answer stores', () => {
    it('is one project rule per listed tool of the server, each tied to the config hash', () => {
      expect
        .soft(
          mcpGrantRules({
            name: 'aws-billing',
            configHash: HASH_A,
            tools: [COST, 'mcp__aws-billing__credits'],
          }),
          'tools of the server',
        )
        .toEqual([
          { toolName: COST, pattern: mcpServerPattern('aws-billing', HASH_A) },
          {
            toolName: 'mcp__aws-billing__credits',
            pattern: mcpServerPattern('aws-billing', HASH_A),
          },
        ]);
      expect
        .soft(
          mcpGrantRules({
            name: 'aws-billing',
            configHash: HASH_A,
            tools: ['mcp__other__x', 'Bash'],
          }),
          'names that are not in the server',
        )
        .toEqual([]);
    });
  });
});

describe('allowedToolsFor with the extra allowed commands of a project', () => {
  const project = {
    gateCommand: 'make gate',
    allowedCommands: ['pnpm exec prettier', 'pnpm test'],
  };
  const edit = allowedToolsFor(project, 'edit');
  const readOnly = allowedToolsFor(project, 'read_only');

  it('lets an edit step run a listed command, and nothing chained to an unlisted one', () => {
    const rows: [string, string, boolean][] = [
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
    ];
    for (const [name, command, expected] of rows) {
      expect
        .soft(matchesAllowedTool('Bash', bash(command), edit, repo.path), `${name}: ${command}`)
        .toBe(expected);
    }
  });

  it('gives no listed command to a read-only step', () => {
    expect(readOnly).not.toContain('Bash(pnpm test:*)');
    expect(matchesAllowedTool('Bash', bash('pnpm test'), readOnly, repo.path)).toBe(false);
  });
});

describe('a project with no gate command', () => {
  it('has no gate entry in the base list or an edit step, and a read-only step loses nothing else', () => {
    const tools = baseAllowedTools({ gateCommand: null });
    expect
      .soft(
        tools.filter((t) => t.startsWith('Bash(')),
        'Bash entries of the base list',
      )
      .toEqual([
        'Bash(git status:*)',
        'Bash(git diff:*)',
        'Bash(git log:*)',
        'Bash(git show:*)',
        'Bash(pwd)',
      ]);
    expect.soft(tools, 'base list').not.toContain('Bash(null)');
    // An edit step does not allow a command named after the missing gate.
    const edit = allowedToolsFor({ gateCommand: null, allowedCommands: [] }, 'edit');
    expect.soft(edit, 'edit step').not.toContain('Bash(null)');
    expect
      .soft(matchesAllowedTool('Bash', bash('null'), edit, repo.path), 'null command')
      .toBe(false);
    // A read-only step gets the same tools as a project with a gate, minus the gate.
    const withGate = allowedToolsFor(
      { gateCommand: 'make gate', allowedCommands: [] },
      'read_only',
    );
    const without = allowedToolsFor({ gateCommand: null, allowedCommands: [] }, 'read_only');
    expect.soft(without, 'read-only step').toEqual(withGate);
  });
});

describe('a project with a changed-packages check command', () => {
  const project = {
    gateCommand: 'make gate',
    changedCheckCommand: 'make check-changed',
    allowedCommands: [],
  };

  it('lets an edit step run it exactly without a card, beside the gate, and keeps it out of a read-only step', () => {
    const tools = allowedToolsFor(project, 'edit');
    expect.soft(tools, 'edit step').toContain('Bash(make gate)');
    expect.soft(tools, 'edit step').toContain('Bash(make check-changed)');
    expect
      .soft(matchesAllowedTool('Bash', bash('make check-changed'), tools, repo.path), 'exact')
      .toBe(true);
    expect
      .soft(
        matchesAllowedTool('Bash', bash('make check-changed --foo'), tools, repo.path),
        'with an argument',
      )
      .toBe(false);
    const readOnly = allowedToolsFor(project, 'read_only');
    expect.soft(readOnly, 'read-only step').not.toContain('Bash(make check-changed)');
    expect.soft(readOnly, 'read-only step').not.toContain('Bash(make gate)');
    // A project without one gets nothing added.
    expect
      .soft(
        allowedToolsFor({ gateCommand: 'make gate', allowedCommands: [] }, 'edit'),
        'project without one',
      )
      .toEqual(
        allowedToolsFor(
          { gateCommand: 'make gate', changedCheckCommand: null, allowedCommands: [] },
          'edit',
        ),
      );
  });
});

describe('allowedToolsFor', () => {
  const project = { gateCommand: 'make gate', allowedCommands: [] };
  it('gives an edit step exactly the base list, and a read-only step the read tools and commands', () => {
    const rows = [
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
    ] as const;
    for (const { tools, has, lacks } of rows) {
      const allowed = allowedToolsFor(project, tools);
      for (const t of has) expect.soft(allowed, `${tools} step has ${t}`).toContain(t);
      for (const t of lacks) expect.soft(allowed, `${tools} step lacks ${t}`).not.toContain(t);
    }
    expect
      .soft(allowedToolsFor(project, 'edit'), 'edit step is the base list')
      .toEqual(baseAllowedTools(project));
  });

  it('scopes the read tools to the real checkout when sandboxed', () => {
    const checkout = realpathSync(repo.path);
    const scope = `/${checkout}/**`;
    const sandboxed = { sandboxed: { checkout: repo.path } };
    expect(allowedToolsFor(project, 'edit', sandboxed)).toEqual(
      baseAllowedTools(project)
        .filter((entry) => entry !== 'Bash(make gate)')
        .map((entry) =>
          ['Read', 'Glob', 'Grep', 'LS'].includes(entry) ? `${entry}(${scope})` : entry,
        ),
    );
    const readOnly = allowedToolsFor(project, 'read_only', sandboxed);
    for (const tool of ['Read', 'Glob', 'Grep', 'LS']) {
      expect(readOnly).toContain(`${tool}(${scope})`);
      expect(readOnly).not.toContain(tool);
    }
  });

  it('leaves every entry that covers the gate out of a sandboxed lane, so the classifier can refuse it', () => {
    const sandboxed = { sandboxed: { checkout: repo.path } };
    const withChecks = { ...project, changedCheckCommand: 'make check-changed' };
    const edit = allowedToolsFor(withChecks, 'edit', sandboxed);
    expect.soft(edit, 'the gate, sandboxed').not.toContain('Bash(make gate)');
    expect.soft(edit, 'the changed check, sandboxed').toContain('Bash(make check-changed)');
    expect
      .soft(allowedToolsFor(withChecks, 'edit'), 'the gate, not sandboxed')
      .toContain('Bash(make gate)');
    const rows: [string, string[], string][] = [
      ['a prefix that covers the gate', ['make'], 'Bash(make:*)'],
      ['a longer prefix that covers the gate', ['make gate'], 'Bash(make gate:*)'],
    ];
    for (const [name, allowedCommands, entry] of rows) {
      const listed = allowedToolsFor({ ...project, allowedCommands }, 'edit', sandboxed);
      expect.soft(listed, `${name}, sandboxed`).not.toContain(entry);
      expect
        .soft(allowedToolsFor({ ...project, allowedCommands }, 'edit'), `${name}, not sandboxed`)
        .toContain(entry);
    }
    // An allowed prefix that does not cover the gate stays.
    expect
      .soft(
        allowedToolsFor(
          { ...project, allowedCommands: ['make test', 'pnpm test'] },
          'edit',
          sandboxed,
        ),
        'prefixes that do not cover the gate',
      )
      .toEqual(expect.arrayContaining(['Bash(make test:*)', 'Bash(pnpm test:*)']));
    // The gate stays out even when it is also the changed-check command.
    const same = { ...project, changedCheckCommand: 'make gate' };
    expect
      .soft(allowedToolsFor(same, 'edit', sandboxed), 'gate as the changed check, sandboxed')
      .not.toContain('Bash(make gate)');
    expect
      .soft(allowedToolsFor(same, 'edit'), 'gate as the changed check, not sandboxed')
      .toContain('Bash(make gate)');
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
  it('stores the narrowest rule an answer can stand for, or nothing', () => {
    const rows: [
      string,
      string,
      string,
      { toolName: string; pattern: string | null } | undefined,
    ][] = [
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
      [
        'a network summary in JSON, from a lane without the sandbox, stores no pattern',
        'SandboxNetworkAccess',
        '{"host":"example.com"}',
        { toolName: 'SandboxNetworkAccess', pattern: null },
      ],
      [
        'a host with an underscore keeps its name',
        'SandboxNetworkAccess',
        'My_Service',
        { toolName: 'SandboxNetworkAccess', pattern: 'my_service' },
      ],
      [
        'a bare IPv6 address keeps its spelling',
        'SandboxNetworkAccess',
        'FE80::1',
        { toolName: 'SandboxNetworkAccess', pattern: 'fe80::1' },
      ],
      [
        'a bracketed IPv6 address keeps its brackets',
        'SandboxNetworkAccess',
        '[::1]',
        { toolName: 'SandboxNetworkAccess', pattern: '[::1]' },
      ],
      [
        'a host with a slash stores no pattern',
        'SandboxNetworkAccess',
        'example.com/x',
        { toolName: 'SandboxNetworkAccess', pattern: null },
      ],
      [
        'a hex-looking host with a port stores no pattern',
        'SandboxNetworkAccess',
        'face.bad:8443',
        { toolName: 'SandboxNetworkAccess', pattern: null },
      ],
      [
        'an unclosed bracket stores no pattern',
        'SandboxNetworkAccess',
        '[::1',
        { toolName: 'SandboxNetworkAccess', pattern: null },
      ],
      [
        'a host with a space stores no pattern',
        'SandboxNetworkAccess',
        'example .com',
        { toolName: 'SandboxNetworkAccess', pattern: null },
      ],
      [
        'a host with a port stores no pattern',
        'SandboxNetworkAccess',
        'example.com:8443',
        { toolName: 'SandboxNetworkAccess', pattern: null },
      ],
      ['Read keeps its path', 'Read', '/a/b.ts', { toolName: 'Read', pattern: '/a/b.ts' }],
      ['Grep is stored as Read', 'Grep', '/a/b', { toolName: 'Read', pattern: '/a/b' }],
      ['Glob is stored as Read', 'Glob', '/a/b', { toolName: 'Read', pattern: '/a/b' }],
      ['LS is stored as Read', 'LS', '/a/b', { toolName: 'Read', pattern: '/a/b' }],
      [
        'a JSON summary stores what it always did',
        'Grep',
        '{"pattern":"x"}',
        { toolName: 'Grep', pattern: null },
      ],
      [
        'a relative read path is the unscoped form',
        'Read',
        'a/b.ts',
        { toolName: 'Read', pattern: null },
      ],
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
      [
        'an edit summary in JSON stores what it always did',
        'Edit',
        '{"file_path":"b.ts"}',
        { toolName: 'Edit', pattern: null },
      ],
      [
        'any other tool has no pattern',
        'WebFetch',
        '{"url":"x"}',
        { toolName: 'WebFetch', pattern: null },
      ],
    ];
    for (const [name, toolName, summary, expected] of rows) {
      expect
        .soft(storableRule(toolName, summary), `${name}: ${toolName} ${summary}`)
        .toEqual(expected);
    }
  });
});

/**
 * The CPU time `fn` takes, in ms. CPU time, not wall time: under full-gate load the process is
 * descheduled for a while, which adds wall time (2096 ms against a 2000 ms limit, for a 211 ms run)
 * but no CPU time. Exponential backtracking burns CPU, so it still shows.
 */
function cpuMillis(fn: () => void): number {
  const before = process.cpuUsage();
  fn();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
}

/** Far above a linear run (about 200 ms) and far below exponential backtracking (hours). */
const BACKTRACKING_LIMIT_MS = 10_000;

describe('commandPrefix: a crafted command', () => {
  it('finishes within a deadline and is allowed once only', () => {
    // The measure counts CPU-bound work and not time spent waiting.
    const fib = (n: number): number => (n < 2 ? n : fib(n - 1) + fib(n - 2));
    expect(cpuMillis(() => fib(34))).toBeGreaterThan(20);
    const waited = cpuMillis(() => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    });
    expect(waited).toBeLessThan(150);

    const flags = Array.from({ length: 30 }, (_, i) => `--f${String(i)} v${String(i)}`).join(' ');
    const nested = Array.from({ length: 12 }, () => `pnpm ${flags} exec`).join(' ');
    let prefix: string | null = 'unset';
    const used = cpuMillis(() => {
      prefix = commandPrefix(nested);
    });
    expect(used).toBeLessThan(BACKTRACKING_LIMIT_MS);
    expect(prefix).toBeNull();
  });
});
