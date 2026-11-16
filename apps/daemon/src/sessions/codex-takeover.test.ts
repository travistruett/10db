import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { homeOutsideTemp } from '../../test/fixtures';
import { codexHomes } from './codex-home';
import type { TakeoverLaunch } from '../environment';
import { CODEX_TUI_DEFAULTS, codexTakeoverCommand, tomlInline } from './codex-takeover';
import { TakeoverRefusedError, type TakeoverSpec } from './takeover-command';

// Sessions spec §7.5: Codex's column of the command table, and one row per lane-only key of the account home.

const LAUNCH: TakeoverLaunch = {
  set: { CODEX_HOME: '/d/codex' },
  unset: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CLAUDECODE'],
  unsetPrefixes: ['ANTHROPIC_DEFAULT_', 'TENDB_'],
  keychain: [],
  apiKeyHelperAccount: null,
  scrub: false,
  model: 'gpt-5.6-sol',
};

function spec(over: Partial<TakeoverSpec> = {}): TakeoverSpec {
  return {
    binary: '/pinned/codex',
    cwd: '/work/repo',
    providerSessionId: '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    model: 'gpt-5.6-sol',
    effort: 'high',
    launch: LAUNCH,
    pluginDirs: ['/setup/plugins/one'],
    instructionsFile: '/data/takeover/instructions.toml',
    mcpConfigFile: null,
    codexServers: [],
    sealedEnvFile: null,
    web: false,
    ...over,
  };
}

/** The `-c` overrides of a command as parsed TOML, by key, and the plain options. */
function read(argv: readonly unknown[]): {
  overrides: Record<string, unknown>;
  fromFile: { prefix: string; file: string }[];
  rest: unknown[];
} {
  const overrides: Record<string, unknown> = {};
  const fromFile: { prefix: string; file: string }[] = [];
  const rest: unknown[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg !== '-c') {
      rest.push(arg);
      continue;
    }
    const value = argv[i + 1];
    i += 1;
    if (typeof value === 'string') {
      const eq = value.indexOf('=');
      const parsed = parse(`v = ${value.slice(eq + 1)}`);
      overrides[value.slice(0, eq)] = parsed['v'];
    } else if (typeof value === 'object' && value !== null && 'file' in value)
      fromFile.push({ prefix: String(Reflect.get(value, 'prefix')), file: String(value.file) });
  }
  return { overrides, fromFile, rest };
}

describe('codexTakeoverCommand', () => {
  it('resumes the chat on the pinned binary, on the account home, with Codex’s own sandbox and approvals', () => {
    const command = codexTakeoverCommand(spec());
    const { overrides, rest } = read(command.argv);
    expect(command.cwd).toBe('/work/repo');
    expect(command.set).toEqual({ CODEX_HOME: '/d/codex' });
    expect(command.unset).toEqual(LAUNCH.unset);
    expect(command.keychain).toEqual([]);
    expect(command.sources).toEqual([]);
    expect(rest).toEqual([
      '/pinned/codex',
      'resume',
      '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      '-m',
      'gpt-5.6-sol',
      '-s',
      'workspace-write',
      '-a',
      'on-request',
    ]);
    expect(overrides['model_reasoning_effort']).toBe('high');
    expect(overrides['check_for_update_on_startup']).toBe(false);
  });

  it('turns off 10db’s guard hook, so the terminal does not refuse every call', () => {
    expect(read(codexTakeoverCommand(spec()).argv).overrides['hooks.PreToolUse']).toEqual([]);
  });

  // One row per lane-only key the account home's template sets (`codex-home.ts`).
  const LANE_ONLY_KEYS: [string, string | boolean][] = [
    ['allow_login_shell', true],
    ['shell_environment_policy.inherit', 'all'],
    ['agents.enabled', true],
    ['skills.include_instructions', true],
    ...Object.entries(CODEX_TUI_DEFAULTS.features).map(([name, on]): [string, boolean] => [
      `features.${name}`,
      on,
    ]),
  ];
  it.each(LANE_ONLY_KEYS)('puts %s back to Codex’s own %j', (key, value) => {
    expect(read(codexTakeoverCommand(spec()).argv).overrides[key]).toBe(value);
  });

  it('names the release its defaults were read from', () => {
    expect(CODEX_TUI_DEFAULTS.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('keeps no key of the kept ones: the sign-in method, the sign-in store and the untrusted pin are the home’s', () => {
    const { overrides } = read(codexTakeoverCommand(spec()).argv);
    for (const key of ['forced_login_method', 'mcp_oauth_credentials_store', 'projects'])
      expect(overrides).not.toHaveProperty(key);
    expect(Object.keys(overrides).filter((k) => k.startsWith('default_permissions'))).toEqual([]);
  });

  it.each([
    [true, 'live'],
    [false, 'disabled'],
  ] as const)('sets web_search for the Web switch %s', (web, mode) => {
    expect(read(codexTakeoverCommand(spec({ web })).argv).overrides['web_search']).toBe(mode);
  });

  it('keeps header tokens from the commands it runs, and reads them from the sealed file', () => {
    const command = codexTakeoverCommand(
      spec({
        sealedEnvFile: '/data/takeover/sealed.env',
        codexServers: [
          {
            kind: 'remote',
            name: 'linear',
            url: 'https://mcp.linear.app/mcp',
            headerVariables: [{ header: 'Authorization', variable: 'TENDB_MCP_TOKEN_1_0' }],
            extras: { tool_timeout_sec: 30 },
          },
        ],
      }),
    );
    const { overrides } = read(command.argv);
    expect(command.sources).toEqual(['/data/takeover/sealed.env']);
    expect(overrides['shell_environment_policy.exclude']).toEqual(['TENDB_MCP_TOKEN_*']);
    expect(overrides['mcp_servers.linear']).toEqual({
      url: 'https://mcp.linear.app/mcp',
      env_http_headers: { Authorization: 'TENDB_MCP_TOKEN_1_0' },
      tool_timeout_sec: 30,
    });
    expect(JSON.stringify(command.argv)).not.toMatch(/Bearer|sk-/);
  });

  it('writes a stdio server as its launch, and leaves out a name McpServerName rejects', () => {
    const { overrides } = read(
      codexTakeoverCommand(
        spec({
          codexServers: [
            {
              kind: 'stdio',
              name: 'docs',
              command: '/usr/bin/env',
              args: ['-i', 'srt', 'a"b'],
              extras: { enabled_tools: ['read'] },
            },
            { kind: 'stdio', name: 'bad name', command: 'x', args: [], extras: {} },
            { kind: 'stdio', name: 'a.b', command: 'x', args: [], extras: {} },
          ],
        }),
      ).argv,
    );
    expect(overrides['mcp_servers.docs']).toEqual({
      command: '/usr/bin/env',
      args: ['-i', 'srt', 'a"b'],
      enabled_tools: ['read'],
    });
    expect(Object.keys(overrides).filter((k) => k.startsWith('mcp_servers.'))).toEqual([
      'mcp_servers.docs',
    ]);
  });

  it('refuses a header variable that Codex would not keep from commands', () => {
    expect(() =>
      codexTakeoverCommand(
        spec({
          codexServers: [
            {
              kind: 'remote',
              name: 'x',
              url: 'https://x.example',
              headerVariables: [{ header: 'Authorization', variable: 'HOME' }],
              extras: {},
            },
          ],
        }),
      ),
    ).toThrow(TakeoverRefusedError);
  });

  it('reads the instructions from their file as a TOML string, and has none without them', () => {
    expect(read(codexTakeoverCommand(spec()).argv).fromFile).toEqual([
      { prefix: 'developer_instructions=', file: '/data/takeover/instructions.toml' },
    ]);
    expect(read(codexTakeoverCommand(spec({ instructionsFile: null })).argv).fromFile).toEqual([]);
  });

  it.each(['', '--last', "a'b", 'x'.repeat(129)])('refuses the session id %j', (id) => {
    expect(() => codexTakeoverCommand(spec({ providerSessionId: id }))).toThrow(
      TakeoverRefusedError,
    );
  });
});

/** The dotted keys of a parsed config, down to its leaves; a table named in `whole` counts as one key. */
function leaves(value: unknown, whole: ReadonlySet<string>, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || whole.has(prefix))
    return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    leaves(child, whole, prefix === '' ? key : `${prefix}.${key}`),
  );
}

describe('the account home’s lane-only keys', () => {
  it('are each overridden or deliberately kept, so a key added to the home is noticed here', async () => {
    const dir = homeOutsideTemp('codex-keys');
    try {
      const home = codexHomes()(join(dir.path, 'codex'));
      await home.prepare(dir.path);
      const config = parse(readFileSync(join(home.path, 'config.toml'), 'utf8'));
      const keys = leaves(config, new Set(['projects', 'hooks.state'])).filter(
        // The hook's definition is replaced as a whole by `hooks.PreToolUse=[]`.
        (key) => !key.startsWith('hooks.PreToolUse') && key !== 'projects',
      );
      const { overrides } = read(codexTakeoverCommand(spec()).argv);
      // Kept on purpose: the sign-in method and store, the lane's permission profile (replaced by `-s`/`-a`).
      const kept = new Set([
        'forced_login_method',
        'mcp_oauth_credentials_store',
        'default_permissions',
        'permissions.lane.filesystem.:minimal',
      ]);
      expect(keys.filter((key) => !(key in overrides) && !kept.has(key))).toEqual([]);
    } finally {
      dir.cleanup();
    }
  });
});

describe('tomlInline', () => {
  it.each<[string, Parameters<typeof tomlInline>[0]]>([
    ['a string with quotes, a newline and a dollar', 'a"b\n$(x) \\'],
    ['a boolean', false],
    ['an empty array', []],
    ['an array', ['a', 'b']],
    ['a table', { a: 1, b: ['x'], c: { d: 'e f' } }],
    ['a table with a key that needs quoting', { 'X-Api-Key': 'v' }],
  ])('round-trips %s', (_name, value) => {
    expect(parse(`v = ${tomlInline(value)}`)['v']).toEqual(value);
  });
});
