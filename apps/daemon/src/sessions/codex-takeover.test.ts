import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import type { TakeoverLaunch } from '../environment';
import { codexTakeoverCommand } from './codex-takeover';
import type { TakeoverSpec } from './takeover-command';

// Sessions spec §7.5: Codex's column of the command table.

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
    kind: 'codex_signin',
    harness: 'codex',
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

/** The `-c key=value` overrides of a command as parsed TOML, by key. */
function overridesOf(argv: readonly unknown[]): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '-c') continue;
    const value = argv[i + 1];
    i += 1;
    if (typeof value !== 'string') continue;
    const eq = value.indexOf('=');
    overrides[value.slice(0, eq)] = parse(`v = ${value.slice(eq + 1)}`)['v'];
  }
  return overrides;
}

describe('codexTakeoverCommand', () => {
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
    const overrides = overridesOf(command.argv);
    expect(command.sources).toEqual(['/data/takeover/sealed.env']);
    expect(overrides['shell_environment_policy.exclude']).toEqual([
      'TENDB_MCP_TOKEN_*',
      'OPENROUTER_API_KEY',
    ]);
    expect(overrides['mcp_servers.linear']).toEqual({
      url: 'https://mcp.linear.app/mcp',
      env_http_headers: { Authorization: 'TENDB_MCP_TOKEN_1_0' },
      tool_timeout_sec: 30,
    });
    expect(JSON.stringify(command.argv)).not.toMatch(/Bearer|sk-/);
  });
});
