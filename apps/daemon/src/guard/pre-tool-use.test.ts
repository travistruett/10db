import { homedir } from 'node:os';
import { join } from 'node:path';
import { ClaimKind, DEFAULT_HAZARDS } from '@10db/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { judgePreToolUse, protectedPaths } from './index';

const repo = tempDir('pre-tool-use-repo');
const data = tempDir('pre-tool-use-data');
const login = tempDir('pre-tool-use-login');
afterAll(() => {
  repo.cleanup();
  data.cleanup();
  login.cleanup();
});

type Claims = readonly { readonly kind: ClaimKind; readonly name: string }[];

const AREA: Claims = [{ kind: ClaimKind.Area, name: 'repo' }];
const MIGRATIONS: Claims = [...AREA, { kind: ClaimKind.Hazard, name: 'migrations' }];
const DEPS: Claims = [...AREA, { kind: ClaimKind.Hazard, name: 'deps' }];
const EVERY_HAZARD_COMMAND: Claims = [...MIGRATIONS, { kind: ClaimKind.Hazard, name: 'deps' }];

function judge(toolName: string, toolInput: unknown, claims: Claims = AREA) {
  return judgePreToolUse({
    toolName,
    toolInput,
    repoPath: repo.path,
    areas: [{ name: 'repo', globs: ['**'] }],
    hazards: DEFAULT_HAZARDS,
    claims,
    readOnly: false,
    protectedPaths: protectedPaths({
      dataDir: data.path,
      home: homedir(),
      loginConfigDir: login.path,
    }),
  });
}

const MONITOR = { description: 'watch', timeout_ms: 60_000 };

describe('judgePreToolUse', () => {
  it.each<[string, string, unknown, Claims, 'allow' | 'ask' | 'deny']>([
    // A hazard 10db can't read could be one the lane hasn't claimed: the broker must see it.
    [
      'a hazard behind a variable',
      'Bash',
      { command: 'SUB=add; pnpm $SUB left-pad@1.3.0' },
      AREA,
      'ask',
    ],
    ['a program named by a variable', 'Bash', { command: '$PM add left-pad' }, AREA, 'ask'],
    ['a program named by a glob', 'Bash', { command: '/usr/bin/p?pm add x' }, AREA, 'ask'],
    [
      'a hazard behind a variable, with only deps claimed: it could be pnpm db:migrate',
      'Bash',
      { command: 'SUB=add; pnpm $SUB left-pad@1.3.0' },
      DEPS,
      'ask',
    ],
    [
      'a hazard behind a variable, with every hazard that has commands claimed',
      'Bash',
      { command: 'SUB=add; pnpm $SUB left-pad@1.3.0' },
      EVERY_HAZARD_COMMAND,
      'allow',
    ],
    // A hazard spelled out is the guard's own refusal, as ever.
    ['a hazard spelled out', 'Bash', { command: 'pnpm add left-pad@1.3.0' }, AREA, 'deny'],
    [
      'drizzle-kit generate without the migrations claim',
      'Bash',
      { command: 'pnpm exec drizzle-kit generate' },
      AREA,
      'deny',
    ],
    // The kinds of command that raised cards on 2026-10-30 are left to the permission mode.
    [
      'drizzle-kit generate holding the migrations claim',
      'Bash',
      { command: 'pnpm exec drizzle-kit generate' },
      MIGRATIONS,
      'allow',
    ],
    ['a grep with a quoted $', 'Bash', { command: "grep -n 'fixture$' README.md" }, AREA, 'allow'],
    [
      'diff3 in the temp dir',
      'Bash',
      { command: 'diff3 "$TMPDIR/d3-mine" "$TMPDIR/d3-base" "$TMPDIR/d3-theirs"' },
      AREA,
      'allow',
    ],
    ['a plain test run', 'Bash', { command: 'pnpm test' }, AREA, 'allow'],
    ['a script in the checkout', 'Bash', { command: 'bash probe.sh' }, AREA, 'allow'],
    // A protected settings file is asked about by Claude Code's ask rule, not here.
    [
      'a dotfile under an area of **',
      'Write',
      { file_path: join(repo.path, '.mcp.json'), content: '{}' },
      AREA,
      'allow',
    ],
    ['WebSearch', 'WebSearch', { query: 'drizzle-kit generate custom migration' }, AREA, 'allow'],
    ['a read in the checkout', 'Read', { file_path: join(repo.path, 'README.md') }, AREA, 'allow'],
    // Monitor and WebFetch can reach a host from Claude Code's own process, outside the sandbox's
    // network proxy and its per-host cards, and a Monitor command is not judged here.
    [
      "Monitor's WebSocket",
      'Monitor',
      { ...MONITOR, ws: { url: 'wss://example.net/' } },
      AREA,
      'ask',
    ],
    [
      'Monitor of a file',
      'Monitor',
      { ...MONITOR, command: 'tail -f /tmp/x.output | grep -m1 DONE' },
      AREA,
      'ask',
    ],
    ['Monitor running a hazard', 'Monitor', { ...MONITOR, command: 'pnpm add x' }, AREA, 'ask'],
    [
      'WebFetch',
      'WebFetch',
      { url: 'https://example.net/', prompt: 'What is on the page?' },
      AREA,
      'ask',
    ],
    // In auto mode a command's own host list is reviewed by the classifier alone and widens the
    // sandbox's hosts with no card; in default mode Claude Code ignores it.
    [
      'a command with its own host list',
      'Bash',
      { command: 'curl https://example.net/', allowed_domains: ['example.net'] },
      AREA,
      'deny',
    ],
    [
      'a Monitor with its own host list',
      'Monitor',
      { ...MONITOR, command: 'curl https://example.net/', allowed_domains: ['example.net'] },
      AREA,
      'deny',
    ],
    [
      'a command with an empty host list',
      'Bash',
      { command: 'pnpm test', allowed_domains: [] },
      AREA,
      'allow',
    ],
    [
      "WebSearch's domain filter",
      'WebSearch',
      { query: 'drizzle-kit', allowed_domains: ['orm.drizzle.team'] },
      AREA,
      'allow',
    ],
  ])('%s: %s', (_name, toolName, input, claims, decision) => {
    expect(judge(toolName, input, claims).decision).toBe(decision);
  });

  it('names what it could not read when it asks about a command', () => {
    expect(judge('Bash', { command: 'SUB=add; pnpm $SUB left-pad@1.3.0' })).toEqual({
      decision: 'ask',
      reason: expect.stringContaining('pnpm $SUB left-pad@1.3.0') as string,
    });
  });

  it("keeps the guard's refusal over an ask", () => {
    expect(
      judge('Write', { file_path: join(repo.path, 'db', 'migrations', '0001.sql'), content: '' })
        .decision,
    ).toBe('deny');
  });
});
